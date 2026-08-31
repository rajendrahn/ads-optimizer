// The C1 "Done when" bar, proven against REAL account data, not only fixtures:
// "An order placed near midnight lands on the same reporting day as the Meta spend it is
// attributed to."
//
// The values below are real, gathered during this step's own implementation, with two
// deliberate exceptions redacted at review before this repository was pushed publicly:
// `customerId` and the `fbclid` in `landingSite` are SYNTHETIC. Both were live identifiers
// tied to actual people, and neither affects anything this test asserts — the reporting-day
// boundary depends only on `createdAt`. Everything else (order ids, order numbers, the real
// `+0530` timestamps, totals, currency, and the Meta spend figures) is genuine, which is the
// whole point of this test:
//   - Shopify orders #1681 and #1532 are real rows from this account's actual Matrixify export
//     (`Orders - 10000.csv`, the same 10,000-real-order file B5 developed against) — real order
//     id, real `Created At` timestamp (including its real `+0530` offset), real totals, real
//     currency.
//   - The Meta spend/impressions/clicks for reporting day 2025-04-17 (₹773.84, 5,439
//     impressions, 430 clicks) and 2025-04-16 (₹748.38) are real, live-fetched, read-only
//     account-level Meta Insights values for this ad account
//     (`GET /{accountId}/insights?level=account&time_range={"since":"2025-04-01","until":"2025-04-30"}`),
//     run once during this step's implementation. The ad/adset/campaign IDs attached to that row
//     below are representative placeholders (ad-level breakdown for a day this far in the past
//     was not re-fetched live) — only the day, spend, impressions and clicks are the real
//     account-level numbers; funnel/reach/frequency fields are zero-filled and noted as such.
//   - The Meta ad account's own configured timezone ("Asia/Kolkata") and the Shopify shop's own
//     timezone ("Asia/Kolkata") were both confirmed live during this step (`GET /{accountId}?
//     fields=timezone_name` and `{ shop { ianaTimezone } }`), matching the reporting canon's
//     "Asia/Kolkata" — see normalizeMetaDailyTask.ts's module comment.
//
// Order #1681 was created 2025-04-17 00:03:50 +0530 — 3 minutes 50 seconds after IST midnight.
// Its UTC instant is 2025-04-16T18:33:50Z. A naive UTC-calendar-day extraction (the exact
// hand-rolled bug §5.1 warns about) would place this order on 2025-04-16, a day that ALSO had
// real Meta spend (₹748.38) — so silently mis-bucketing it would not even fail loudly, it would
// just quietly misattribute ₹6,499.00 of revenue to the wrong day's spend. This test proves the
// real order lands on 2025-04-17, the correct IST reporting day, matching the real Meta spend
// recorded for that same day.
//
// Order #1532 was created 2025-04-07 00:00:14 +0530 — 14 seconds after IST midnight, an even
// tighter real-data boundary case. Meta had zero delivery that day (confirmed live — the account
// simply wasn't spending on 2025-04-07), so there's no Meta row to compare it against, but it
// still proves the reporting-day computation itself is correct at the exact edge on a real
// timestamp: 2025-04-07, not 2025-04-06.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import {
  COLLECTIONS,
  collectionRef,
  createRepository,
  metaInsightsDailyKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  metaInsightsDailySchema,
  shopifyOrderSchema,
  type MetaInsightsDaily,
  type ShopifyOrder,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../../services/ingest/meta/entities/testFixtures.ts";
import { normalizeMetaInsightsDailyHandler } from "./normalizeMetaDailyTask.ts";
import { normalizeShopifyDailyHandler } from "./normalizeShopifyDailyTask.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "midnightBoundary.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.metaInsightsDaily,
    COLLECTIONS.metaInsightsDailyNormalized,
    COLLECTIONS.shopifyOrders,
    COLLECTIONS.shopifyOrdersNormalized,
    COLLECTIONS.shopifyRefunds,
    COLLECTIONS.shopifyRefundsNormalized,
    COLLECTIONS.shopifyDailyCoverage,
    COLLECTIONS.syncState,
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

function fakeTaskContext(): {
  getMetaClient: () => Promise<never>;
  getShopifyClient: () => Promise<never>;
  recordVersionGuardRejection: () => void;
  archiver: never;
} {
  return {
    getMetaClient: () => Promise.reject(new Error("must not call Meta live in C1 normalization")),
    getShopifyClient: () =>
      Promise.reject(new Error("must not call Shopify live in C1 normalization")),
    recordVersionGuardRejection: () => undefined,
    archiver: undefined as never,
  };
}

// Real, live-fetched Meta account-level insights for this account, April 2025 (see module
// comment). ad/adset/campaign ids are representative — see module comment for exactly which
// fields are real vs. representative here.
const REAL_META_ROW_2025_04_17: MetaInsightsDaily = {
  adId: "120210000000171",
  adsetId: "as_120210000000171",
  campaignId: "cmp_120210000000171",
  accountId: TEST_CANON.accountId,
  date: "2025-04-17", // Meta's own date_start for this ad account's real, confirmed-IST timezone
  attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
  spendMinorUnits: 77384, // real: ₹773.84
  currency: "INR",
  impressions: 5439, // real
  reach: null,
  frequency: null,
  clicks: 430, // real
  landingPageViews: 0,
  addToCart: 0,
  initiateCheckout: 0,
  purchases: 0,
  purchaseValueMinorUnits: 0,
  sourceUpdatedAt: new Date("2026-08-31T00:00:00Z"),
  fetchedAt: new Date("2026-08-31T00:00:00Z"),
};

const REAL_META_ROW_2025_04_16: MetaInsightsDaily = {
  ...REAL_META_ROW_2025_04_17,
  adId: "120210000000161",
  adsetId: "as_120210000000161",
  campaignId: "cmp_120210000000161",
  date: "2025-04-16",
  spendMinorUnits: 74838, // real: ₹748.38
};

// Real order #1681 from this account's actual Matrixify export.
const REAL_ORDER_1681: ShopifyOrder = {
  orderId: "6628544414011",
  orderNumber: "#1681",
  createdAt: new Date("2025-04-17T00:03:50+05:30"), // real: 2025-04-16T18:33:50Z
  sourceUpdatedAt: new Date("2025-04-30T01:49:17+05:30"),
  currency: "INR",
  totalPriceMinorUnits: 649900,
  subtotalPriceMinorUnits: 399900,
  totalDiscountsMinorUnits: 30100,
  totalShippingMinorUnits: 250000,
  financialStatus: "paid",
  fulfillmentStatus: null,
  cancelledAt: null,
  customerId: "9000000000001",
  isNewCustomer: null,
  country: "US",
  // Synthetic fbclid. The real order's value was a live Facebook click identifier tied to an
  // actual person; it is redacted here because this repository is public and the token is
  // incidental to what this test asserts (the reporting-day boundary, which depends only on
  // createdAt). Shape is preserved so the value still exercises the same parsing path.
  landingSite: "/?fbclid=PAZXh0bgNhZW0CMTEAAaREDACTEDsynthetic0000000000_aem_REDACTEDsynthetic",
  referringSite: "https://l.instagram.com/",
  rawAttributionTag: null,
  resolvedAdId: null,
  resolvedCampaignId: null,
  source: "MATRIXIFY_IMPORT",
  syncedAt: new Date("2026-08-31T00:00:00Z"),
};

// Real order #1532 — an even tighter real-data boundary (14s after IST midnight).
const REAL_ORDER_1532: ShopifyOrder = {
  orderId: "6609081893179",
  orderNumber: "#1532",
  createdAt: new Date("2025-04-07T00:00:14+05:30"), // real: 2025-04-06T18:30:14Z
  sourceUpdatedAt: new Date("2025-04-07T00:00:14+05:30"),
  currency: "INR",
  totalPriceMinorUnits: 155000,
  subtotalPriceMinorUnits: 145000,
  totalDiscountsMinorUnits: 0,
  totalShippingMinorUnits: 10000,
  financialStatus: "paid",
  fulfillmentStatus: null,
  cancelledAt: null,
  customerId: "9000000000002",
  isNewCustomer: null,
  country: null,
  landingSite: null,
  referringSite: null,
  rawAttributionTag: null,
  resolvedAdId: null,
  resolvedCampaignId: null,
  source: "MATRIXIFY_IMPORT",
  syncedAt: new Date("2026-08-31T00:00:00Z"),
};

describe("C1 done-when bar, real data: an order placed near midnight lands on the same reporting day as the Meta spend it is attributed to", () => {
  it("order #1681 (00:03:50 IST) and real Meta spend both normalize to reporting day 2025-04-17, NOT the UTC calendar day 2025-04-16", async () => {
    await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.metaInsightsDaily,
      docId: metaInsightsDailyKey(REAL_META_ROW_2025_04_17.adId, REAL_META_ROW_2025_04_17.date),
      incoming: REAL_META_ROW_2025_04_17,
      schema: metaInsightsDailySchema,
    });
    await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.metaInsightsDaily,
      docId: metaInsightsDailyKey(REAL_META_ROW_2025_04_16.adId, REAL_META_ROW_2025_04_16.date),
      incoming: REAL_META_ROW_2025_04_16,
      schema: metaInsightsDailySchema,
    });
    const ordersRef = collectionRef(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    await ordersRef.doc(REAL_ORDER_1681.orderId).set(REAL_ORDER_1681);

    const ctx = fakeTaskContext();
    await normalizeMetaInsightsDailyHandler({
      runId: "r-meta",
      taskType: "NORMALIZE_META_INSIGHTS_DAILY",
      payload: {},
      ...ctx,
    });
    await normalizeShopifyDailyHandler({
      runId: "r-shopify",
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      ...ctx,
    });

    const normalizedOrder = await db
      .collection(COLLECTIONS.shopifyOrdersNormalized)
      .doc(REAL_ORDER_1681.orderId)
      .get();
    expect(normalizedOrder.data()?.reportingDay).toBe("2025-04-17");
    expect(normalizedOrder.data()?.reportingDay).not.toBe("2025-04-16");

    const normalizedMetaSnap = await db
      .collection(COLLECTIONS.metaInsightsDailyNormalized)
      .doc(`${REAL_META_ROW_2025_04_17.adId}_2025-04-17`)
      .get();
    expect(normalizedMetaSnap.data()?.reportingDay).toBe("2025-04-17");

    // The real order and the real Meta spend it should be read alongside now share one
    // reporting day — the join C2 will do over these two collections lines up correctly.
    expect(normalizedOrder.data()?.reportingDay).toBe(normalizedMetaSnap.data()?.reportingDay);
    expect(normalizedMetaSnap.data()?.spend).toMatchObject({
      amountMinorUnits: 77384,
      currency: "INR",
      fxRateToReportingCurrency: 1,
    });
    expect(normalizedOrder.data()?.totalPrice).toMatchObject({
      amountMinorUnits: 649900,
      currency: "INR",
      fxRateToReportingCurrency: 1,
    });
    expect(normalizedOrder.data()?.reportingTimezone).toBe("Asia/Kolkata");
    expect(normalizedMetaSnap.data()?.reportingTimezone).toBe("Asia/Kolkata");
  });

  it("order #1532 (00:00:14 IST, 14 seconds after midnight) still normalizes to 2025-04-07, not the UTC day 2025-04-06", async () => {
    const ordersRef = collectionRef(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    await ordersRef.doc(REAL_ORDER_1532.orderId).set(REAL_ORDER_1532);

    const ctx = fakeTaskContext();
    await normalizeShopifyDailyHandler({
      runId: "r-shopify-2",
      taskType: "NORMALIZE_SHOPIFY_DAILY",
      payload: {},
      ...ctx,
    });

    const normalized = await db
      .collection(COLLECTIONS.shopifyOrdersNormalized)
      .doc(REAL_ORDER_1532.orderId)
      .get();
    expect(normalized.data()?.reportingDay).toBe("2025-04-07");
    expect(normalized.data()?.reportingDay).not.toBe("2025-04-06");
  });
});
