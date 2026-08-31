// Emulator-backed proof of SHOPIFY_PROCESS_WEBHOOK — this is where B6's three "Done when"
// scenarios actually get exercised against a real Firestore emulator (a replayed webhook is a
// no-op; an out-of-order older payload is rejected and logged; the write goes through the same
// monotonic version guard as every other Shopify write). Mirrors
// ../orders/ordersSync.emulator.test.ts's structure/conventions deliberately — same cleanup
// pattern, same TEST_CANON fixture, same createFirestoreSyncStore/runSyncTask usage.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import { shopifyOrderSchema, shopifyRefundSchema } from "@shared/schema/index.ts";
import { TEST_CANON } from "../../meta/entities/testFixtures.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { createTaskRegistry } from "../../sync/registry.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { runSyncTask } from "../../sync/taskWrapper.ts";
import { shopifyProcessWebhookHandler, shopifyProcessWebhookRegistration } from "./processTask.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "processTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.shopifyOrders,
    COLLECTIONS.shopifyOrderLines,
    COLLECTIONS.shopifyRefunds,
    COLLECTIONS.syncState,
    COLLECTIONS.syncRuns,
    COLLECTIONS.settings,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(TEST_CANON.accountId, TEST_CANON);
});

afterAll(async () => {
  await cleanupCollections();
});

function orderWebhookBody(updatedAt: string, financialStatus: string) {
  return {
    id: 700000001,
    name: "#2001",
    order_number: 2001,
    created_at: "2026-08-20T10:00:00+05:30",
    updated_at: updatedAt,
    cancelled_at: null,
    currency: "INR",
    financial_status: financialStatus,
    fulfillment_status: "fulfilled",
    customer: { id: 5000000001 },
    billing_address: { country_code: "IN" },
    shipping_address: { country_code: "IN" },
    subtotal_price: "2000.00",
    total_discounts: "0.00",
    total_price: "2000.00",
    total_shipping_price_set: null,
    shipping_lines: [],
    landing_site: "/collections/all?utm_source=meta",
    referring_site: null,
    line_items: [
      {
        id: 15000000001,
        product_id: 8100000001,
        variant_id: 44100000001,
        sku: "SKU-1",
        title: "Item",
        quantity: 1,
        price: "2000.00",
      },
    ],
    refunds: [],
  };
}

function makeCtx(runId: string, payload: unknown) {
  return {
    runId,
    taskType: "SHOPIFY_PROCESS_WEBHOOK",
    payload,
    archiver: dummyArchiver,
    getMetaClient: async (): Promise<never> => {
      throw new Error("should not be called");
    },
    getShopifyClient: async (): Promise<never> => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

describe("shopifyProcessWebhookHandler (emulator)", () => {
  it("writes an order + line from an orders/create-shaped webhook payload", async () => {
    const result = await shopifyProcessWebhookHandler(
      makeCtx("run_create", {
        topic: "orders/create",
        webhookId: "wh_create",
        body: orderWebhookBody("2026-08-20T10:00:00+05:30", "paid"),
      }),
    );

    expect(result.newRowCount).toBe(1);
    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    const order = await ordersRepo.get("700000001");
    expect(order?.source).toBe("WEBHOOK");
    expect(order?.financialStatus).toBe("paid");
    expect(order?.landingSite).toBe("/collections/all?utm_source=meta");

    const lines = await db.collection(COLLECTIONS.shopifyOrderLines).listDocuments();
    expect(lines).toHaveLength(1);
  });

  it("writes a refund from a standalone refunds/create-shaped payload", async () => {
    const result = await shopifyProcessWebhookHandler(
      makeCtx("run_refund", {
        topic: "refunds/create",
        webhookId: "wh_refund",
        body: {
          id: 900000010,
          order_id: 700000001,
          created_at: "2026-08-21T09:00:00+05:30",
          transactions: [{ amount: "500.00", kind: "refund", status: "success", currency: "INR" }],
        },
      }),
    );

    expect(result.newRowCount).toBe(1);
    const refundsRepo = createRepository(db, COLLECTIONS.shopifyRefunds, shopifyRefundSchema);
    const refund = await refundsRepo.get("700000001_900000010");
    expect(refund?.amountMinorUnits).toBe(50_000);
    expect(refund?.currency).toBe("INR");
  });

  it("a currency-less refund payload fails terminally (not retryable) rather than guessing", async () => {
    await expect(
      shopifyProcessWebhookHandler(
        makeCtx("run_bad_refund", {
          topic: "refunds/create",
          webhookId: "wh_bad_refund",
          body: { id: 900000011, order_id: 700000001, created_at: "2026-08-21T09:00:00+05:30" },
        }),
      ),
    ).rejects.toMatchObject({ retryable: false });
  });

  describe("through the full runSyncTask path (real idempotency + version-guard + syncRuns logging)", () => {
    it("a replayed webhook (same taskId) is a no-op — the handler does not run a second time and no duplicate write occurs", async () => {
      const syncStore = createFirestoreSyncStore(db);
      const registry = createTaskRegistry();
      registry.register(shopifyProcessWebhookRegistration);

      const payload = {
        topic: "orders/create",
        webhookId: "wh_replay",
        body: orderWebhookBody("2026-08-20T10:00:00+05:30", "paid"),
      };

      const first = await runSyncTask({
        syncStore,
        registry,
        taskType: "SHOPIFY_PROCESS_WEBHOOK",
        payload,
        archiver: dummyArchiver,
        taskId: "wh_replay",
      });
      expect(first.status).toBe("SUCCEEDED");

      const second = await runSyncTask({
        syncStore,
        registry,
        taskType: "SHOPIFY_PROCESS_WEBHOOK",
        payload,
        archiver: dummyArchiver,
        taskId: "wh_replay", // Shopify's own at-least-once redelivery of the SAME webhook id
      });
      expect(second.status).toBe("SKIPPED_ALREADY_SUCCEEDED");

      const orderDocs = await db.collection(COLLECTIONS.shopifyOrders).listDocuments();
      expect(orderDocs).toHaveLength(1);
      const lineDocs = await db.collection(COLLECTIONS.shopifyOrderLines).listDocuments();
      expect(lineDocs).toHaveLength(1);
    });

    it("an out-of-order older payload is rejected and the rejection is logged in syncRuns — 'a refund webhook can arrive before the order update it follows'", async () => {
      const syncStore = createFirestoreSyncStore(db);
      const registry = createTaskRegistry();
      registry.register(shopifyProcessWebhookRegistration);

      // Simulate genuine out-of-order delivery: the NEWER state (post-refund, financial_status
      // "refunded") is processed first, then the OLDER webhook (still "paid") arrives late and
      // must not be allowed to clobber it.
      const newer = await runSyncTask({
        syncStore,
        registry,
        taskType: "SHOPIFY_PROCESS_WEBHOOK",
        payload: {
          topic: "orders/updated",
          webhookId: "wh_newer",
          body: orderWebhookBody("2026-08-22T12:00:00+05:30", "refunded"),
        },
        archiver: dummyArchiver,
        taskId: "wh_newer",
      });
      expect(newer.status).toBe("SUCCEEDED");

      const older = await runSyncTask({
        syncStore,
        registry,
        taskType: "SHOPIFY_PROCESS_WEBHOOK",
        payload: {
          topic: "orders/updated",
          webhookId: "wh_older",
          body: orderWebhookBody("2026-08-20T10:00:00+05:30", "paid"),
        },
        archiver: dummyArchiver,
        taskId: "wh_older",
      });
      // The run itself still succeeds (a version-guard rejection is not a task failure — §9.5
      // asks for the rejection to be logged and observable, not for the whole delivery to be
      // treated as an error) but records the rejection. orderWebhookBody's one line item shares
      // the order's own sourceUpdatedAt (matching graphqlNormalize.ts's convention), so an
      // out-of-order order payload is rejected on BOTH docs it would have touched — the order
      // itself and its one line — hence 2, not 1.
      expect(older.status).toBe("SUCCEEDED");
      expect((older.summary as { versionRejections: number }).versionRejections).toBe(2);

      // The stored order must still reflect the NEWER state, never the late-arriving older one.
      const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
      const order = await ordersRepo.get("700000001");
      expect(order?.financialStatus).toBe("refunded");

      // And the rejection must be independently observable in syncRuns (§9.5: "log the
      // rejection in syncRuns so ordering problems stay observable") — not just in the
      // in-memory summary this test already checked above.
      const olderRun = await syncStore.getSyncRun("wh_older");
      expect(olderRun?.status).toBe("SUCCEEDED");
      expect(olderRun?.versionGuardRejections).not.toBeNull();
      expect(olderRun?.versionGuardRejections).toHaveLength(2);
      expect(olderRun?.versionGuardRejections).toContainEqual(
        expect.objectContaining({ collection: COLLECTIONS.shopifyOrders, docId: "700000001" }),
      );
      expect(olderRun?.versionGuardRejections).toContainEqual(
        expect.objectContaining({
          collection: COLLECTIONS.shopifyOrderLines,
          docId: "700000001_15000000001",
        }),
      );
    });
  });
});
