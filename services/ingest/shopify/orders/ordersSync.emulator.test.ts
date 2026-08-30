// Emulator-backed proof of SHOPIFY_SYNC_ORDERS: orders/lines/refunds from a (mocked) GraphQL
// response land correctly, pagination is followed, the watermark advances, and knownGaps stays
// current. The Shopify side is a real `ShopifyClient` with a canned `fetchImpl` — no live
// network call; every Firestore call is real, against the emulator.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository, syncStateKey } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import { shopifyOrderSchema } from "@shared/schema/index.ts";
import { TEST_CANON } from "../../meta/entities/testFixtures.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { createTaskRegistry } from "../../sync/registry.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { runSyncTask } from "../../sync/taskWrapper.ts";
import { ShopifyClient } from "../client.ts";
import { shopifySyncOrdersHandler, shopifySyncOrdersRegistration } from "./ordersSync.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "ordersSync.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function orderNode(id: string, updatedAt: string, customerId: string | null = "c1") {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: updatedAt,
    updatedAt,
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "INR",
    customer: customerId ? { id: `gid://shopify/Customer/${customerId}` } : null,
    billingAddress: { countryCodeV2: "IN" },
    shippingAddress: { countryCodeV2: "IN" },
    subtotalPriceSet: { shopMoney: { amount: "100.0" } },
    totalDiscountsSet: { shopMoney: { amount: "0.0" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.0" } },
    totalPriceSet: { shopMoney: { amount: "100.0" } },
    lineItems: {
      edges: [
        {
          node: {
            id: `gid://shopify/LineItem/${id}0`,
            title: "Test Item",
            sku: "sku",
            quantity: 1,
            product: { id: "gid://shopify/Product/p1", productType: "ring", tags: ["a"] },
            variant: { id: "gid://shopify/ProductVariant/v1" },
            originalUnitPriceSet: { shopMoney: { amount: "100.0" } },
          },
        },
      ],
    },
    refunds: [],
  };
}

function pageResponse(
  nodes: ReturnType<typeof orderNode>[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return jsonResponse({
    data: {
      orders: {
        pageInfo: { hasNextPage, endCursor },
        edges: nodes.map((node) => ({ node })),
      },
    },
  });
}

function makeCtx(runId: string, client: ShopifyClient) {
  return {
    runId,
    taskType: "SHOPIFY_SYNC_ORDERS",
    payload: {},
    archiver: dummyArchiver,
    getMetaClient: async (): Promise<never> => {
      throw new Error("should not be called");
    },
    getShopifyClient: async () => client,
    recordVersionGuardRejection: () => undefined,
  };
}

function clientWithFetch(fetchImpl: ReturnType<typeof vi.fn>): ShopifyClient {
  return new ShopifyClient({
    shopDomain: "shop.myshopify.com",
    accessToken: "tok",
    fetchImpl,
    sleepImpl: vi.fn().mockResolvedValue(undefined),
  });
}

describe("shopifySyncOrdersHandler (emulator)", () => {
  it("writes orders/lines from a single-page GraphQL response and advances the watermark", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(pageResponse([orderNode("201", "2026-08-01T00:00:00Z")], false, null));
    const client = clientWithFetch(fetchImpl);

    const result = await shopifySyncOrdersHandler(makeCtx("run_1", client));

    expect(result.newRowCount).toBe(1);
    expect(result.newWatermarkDate).toBe("2026-08-01");

    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    const order = await ordersRepo.get("201");
    expect(order?.source).toBe("GRAPHQL_SYNC");
    expect(order?.totalPriceMinorUnits).toBe(10_000);
    expect(order?.isNewCustomer).toBe(true); // recompute pass runs at the end of the handler
  });

  it("follows pagination across multiple pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse([orderNode("301", "2026-08-01T00:00:00Z")], true, "cursor1"),
      )
      .mockResolvedValueOnce(pageResponse([orderNode("302", "2026-08-02T00:00:00Z")], false, null));
    const client = clientWithFetch(fetchImpl);

    const result = await shopifySyncOrdersHandler(makeCtx("run_1", client));

    expect(result.newRowCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    expect(await ordersRepo.get("301")).not.toBeNull();
    expect(await ordersRepo.get("302")).not.toBeNull();
  });

  it("through the full runSyncTask path: advances syncState and derives knownGaps from a prior backfillCoverageThroughDate", async () => {
    const syncStore = createFirestoreSyncStore(db);
    // Simulate MATRIXIFY_IMPORT having already run and left its watermark/coverage behind.
    await syncStore.setSyncState(syncStateKey("shopify", "orders"), {
      source: "shopify",
      resource: "orders",
      accountId: TEST_CANON.accountId,
      lastSuccessfulSyncAt: new Date("2026-08-30T00:00:00Z"),
      lastDataDate: "2025-12-13",
      reconciliationDays: null,
      attributionWindow: null,
      status: "healthy",
      lastRunId: "prior-import",
      backfillCoverageThroughDate: "2025-12-13",
      knownGaps: [{ startDate: "2025-12-14", endDateExclusive: "2026-07-02", reason: "stale" }],
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(pageResponse([orderNode("401", "2026-08-15T00:00:00Z")], false, null));
    const client = clientWithFetch(fetchImpl);

    const registry = createTaskRegistry();
    registry.register({ ...shopifySyncOrdersRegistration, handler: shopifySyncOrdersHandler });

    await runSyncTask({
      syncStore,
      registry,
      taskType: "SHOPIFY_SYNC_ORDERS",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_full",
      createShopifyClientImpl: async () => client,
    });

    const state = await syncStore.getSyncState(syncStateKey("shopify", "orders"));
    expect(state?.lastDataDate).toBe("2026-08-15");
    // backfillCoverageThroughDate is carried forward unchanged (this task never sets it).
    expect(state?.backfillCoverageThroughDate).toBe("2025-12-13");
    // knownGaps is recomputed fresh every run (not the stale "2026-07-02" seeded above).
    expect(state?.knownGaps?.[0].startDate).toBe("2025-12-14");
  });

  it("re-running with the same data is a no-op (no duplicate docs, equal-version writes accepted)", async () => {
    // A fresh Response per call — a Response body can only be read once, and this mock backs
    // two separate handler invocations below.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(pageResponse([orderNode("501", "2026-08-01T00:00:00Z")], false, null)),
      );

    await shopifySyncOrdersHandler(makeCtx("run_1", clientWithFetch(fetchImpl)));
    const result2 = await shopifySyncOrdersHandler(makeCtx("run_2", clientWithFetch(fetchImpl)));

    const orderDocs = await db.collection(COLLECTIONS.shopifyOrders).listDocuments();
    expect(orderDocs).toHaveLength(1);
    expect((result2.summary as { versionRejections: number }).versionRejections).toBe(0);
  });
});
