// Emulator-backed proof of NORMALIZE_SHOPIFY_DAILY: reads real shopifyOrders/shopifyRefunds,
// writes the normalized collections plus shopifyDailyCoverage through the real A2 version
// guard, wired through the real task framework, against a real Firestore emulator. No live
// Shopify call anywhere in this file.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS, createRepository, syncStateKey } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  shopifyOrderSchema,
  shopifyRefundSchema,
  syncStateSchema,
  type ShopifyOrder,
  type ShopifyRefund,
  type SyncState,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../../services/ingest/sync/archiver.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "normalizeShopifyDailyTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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
    COLLECTIONS.shopifyOrdersNormalized,
    COLLECTIONS.shopifyRefunds,
    COLLECTIONS.shopifyRefundsNormalized,
    COLLECTIONS.shopifyDailyCoverage,
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
afterAll(cleanupCollections);

function order(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    orderId: "order_1",
    orderNumber: "#1",
    createdAt: new Date("2026-08-25T10:00:00Z"),
    sourceUpdatedAt: new Date("2026-08-25T10:00:00Z"),
    currency: "INR",
    totalPriceMinorUnits: 100000,
    subtotalPriceMinorUnits: 90000,
    totalDiscountsMinorUnits: 0,
    totalShippingMinorUnits: 10000,
    financialStatus: "paid",
    fulfillmentStatus: "fulfilled",
    cancelledAt: null,
    customerId: "cust_1",
    isNewCustomer: true,
    country: "IN",
    landingSite: null,
    referringSite: null,
    rawAttributionTag: null,
    resolvedAdId: null,
    resolvedCampaignId: null,
    source: "GRAPHQL_SYNC",
    syncedAt: new Date("2026-08-25T10:05:00Z"),
    ...overrides,
  };
}

async function seedOrder(o: ShopifyOrder) {
  const ref = createRepository<ShopifyOrder>(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
  await ref.set(o.orderId, o);
}

async function seedRefund(r: ShopifyRefund) {
  const ref = createRepository<ShopifyRefund>(db, COLLECTIONS.shopifyRefunds, shopifyRefundSchema);
  await ref.set(`${r.orderId}_${r.refundId}`, r);
}

describe("NORMALIZE_SHOPIFY_DAILY (emulator)", () => {
  it("normalizes a real-shaped order, stamping reportingDay/timezone and a 1:1 fx rate", async () => {
    await seedOrder(order());
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(result.status).toBe("SUCCEEDED");
    const doc = await db.collection(COLLECTIONS.shopifyOrdersNormalized).doc("order_1").get();
    expect(doc.exists).toBe(true);
    const data = doc.data();
    expect(data?.reportingDay).toBe("2026-08-25");
    expect(data?.reportingTimezone).toBe("Asia/Kolkata");
    expect(data?.totalPrice).toMatchObject({
      amountMinorUnits: 100000,
      currency: "INR",
      fxRateToReportingCurrency: 1,
    });
  });

  it("normalizes refunds keyed to their own reporting day, independent of their parent order's", async () => {
    await seedOrder(order({ orderId: "order_2", createdAt: new Date("2026-08-20T10:00:00Z") }));
    await seedRefund({
      orderId: "order_2",
      refundId: "ref_1",
      createdAt: new Date("2026-08-27T10:00:00Z"), // days later than the order
      amountMinorUnits: 5000,
      currency: "INR",
      reason: null,
      sourceUpdatedAt: new Date("2026-08-27T10:00:00Z"),
      syncedAt: new Date("2026-08-27T10:05:00Z"),
    });

    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();
    await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    const refundDoc = await db
      .collection(COLLECTIONS.shopifyRefundsNormalized)
      .doc("order_2_ref_1")
      .get();
    expect(refundDoc.data()?.reportingDay).toBe("2026-08-27");
  });

  it("writes shopifyDailyCoverage for every day through today, marking days inside B5's recorded knownGaps and leaving days outside it unmarked", async () => {
    // A small gap, shaped exactly like B5's real syncState.knownGaps entries.
    const state: SyncState = {
      source: "shopify",
      resource: "orders",
      accountId: TEST_CANON.accountId,
      lastSuccessfulSyncAt: new Date(),
      lastDataDate: "2026-08-10",
      reconciliationDays: null,
      attributionWindow: null,
      status: "healthy",
      lastRunId: "prior_run",
      backfillCoverageThroughDate: "2026-08-05",
      knownGaps: [{ startDate: "2026-08-06", endDateExclusive: "2026-08-09", reason: "test gap" }],
    };
    const syncStateRepo = createRepository<SyncState>(db, COLLECTIONS.syncState, syncStateSchema);
    await syncStateRepo.set(syncStateKey("shopify", "orders"), state);

    await seedOrder(order({ orderId: "order_3", createdAt: new Date("2026-08-05T10:00:00Z") }));

    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();
    await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    const gapDay = await db.collection(COLLECTIONS.shopifyDailyCoverage).doc("2026-08-07").get();
    expect(gapDay.data()).toMatchObject({ hasCoverageGap: true, gapReason: "test gap" });

    const observedDay = await db
      .collection(COLLECTIONS.shopifyDailyCoverage)
      .doc("2026-08-05")
      .get();
    expect(observedDay.data()).toMatchObject({ hasCoverageGap: false, ordersObserved: 1 });

    const beforeGap = await db.collection(COLLECTIONS.shopifyDailyCoverage).doc("2026-08-06").get();
    expect(beforeGap.exists).toBe(true); // gap start itself IS inside the half-open range
    expect(beforeGap.data()?.hasCoverageGap).toBe(true);

    const gapEndBoundary = await db
      .collection(COLLECTIONS.shopifyDailyCoverage)
      .doc("2026-08-09")
      .get();
    expect(gapEndBoundary.data()?.hasCoverageGap).toBe(false); // endDateExclusive is NOT flagged
  });

  it("re-running over unchanged source data is idempotent — no duplicate normalized docs", async () => {
    await seedOrder(order());
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });
    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(second.status).toBe("SUCCEEDED");
    const snap = await db.collection(COLLECTIONS.shopifyOrdersNormalized).get();
    expect(snap.size).toBe(1);
  });
});
