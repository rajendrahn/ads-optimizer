// Emulator-backed proof of RECOMPUTE_FEATURES (§10.1, §10.2, §12): a full recompute over real
// Firestore data (emulator only — never production), covering every "Done when" claim this step
// makes:
//   - all five entity levels get a features doc (AD/ADSET/CAMPAIGN/CREATIVE_FAMILY/ACCOUNT)
//   - accountDataVersion bumps by exactly 1 per run, shared by every doc written that run
//   - the URL-tag-audit "unresolvable ad" rule: null, never zero, for Shopify-attributed figures
//   - the gap-safety rule: a window overlapping a flagged shopifyDailyCoverage day carries
//     windowHasDataGap:true on its Shopify-derived figures while its Meta figures stay intact
//   - blended MER is populated only at ACCOUNT level
//   - re-running is idempotent in shape (same entity count, version bumps again)
//
// No live Meta/Shopify call anywhere in this file.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  adUrlTagAuditSchema,
  creativeAssetSchema,
  creativeFamilySchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
  metaInsightsDailyNormalizedSchema,
  shopifyDailyCoverageSchema,
  shopifyOrderNormalizedSchema,
  shopifyRefundNormalizedSchema,
  type AdUrlTagAudit,
  type CreativeAsset,
  type CreativeFamily,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaCreative,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type ReportingDay,
  type ShopifyDailyCoverage,
  type ShopifyOrderNormalized,
  type ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../../services/ingest/sync/archiver.ts";
import { addCalendarDays } from "@shared/canon/index.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "recomputeFeaturesTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

const ALL_COLLECTIONS = [
  COLLECTIONS.metaCampaigns,
  COLLECTIONS.metaAdsets,
  COLLECTIONS.metaAds,
  COLLECTIONS.metaCreatives,
  COLLECTIONS.creativeAssets,
  COLLECTIONS.creativeFamilies,
  COLLECTIONS.metaInsightsDailyNormalized,
  COLLECTIONS.shopifyOrdersNormalized,
  COLLECTIONS.shopifyRefundsNormalized,
  COLLECTIONS.shopifyDailyCoverage,
  COLLECTIONS.adUrlTagAudits,
  COLLECTIONS.adFeatures,
  COLLECTIONS.adsetFeatures,
  COLLECTIONS.creativeFamilyFeatures,
  COLLECTIONS.accountFeatures,
  COLLECTIONS.syncState,
  COLLECTIONS.syncRuns,
  COLLECTIONS.settings,
];

async function cleanupCollections() {
  for (const name of ALL_COLLECTIONS) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

const ACCOUNT_ID = TEST_CANON.accountId;

function money(amountMinorUnits: number): NormalizedMoney {
  return {
    amountMinorUnits,
    currency: "INR",
    sourceAmountMinorUnits: amountMinorUnits,
    sourceCurrency: "INR",
    fxRateToReportingCurrency: 1,
    fxRateSource: "same_currency_no_conversion",
  };
}

// A fixed "today" so the test's windows are deterministic. asOfDay defaults to yesterday, so we
// pass it explicitly here anyway — deterministic either way, but explicit is clearer to read.
const AS_OF_DAY: ReportingDay = "2026-08-30";

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(ACCOUNT_ID, TEST_CANON);
});
afterAll(cleanupCollections);

async function seedMetaEntities() {
  const campaign: MetaCampaign = {
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    name: "Campaign 1",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    budget: null,
    bidStrategy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const adset: MetaAdset = {
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    name: "Adset 1",
    status: "ACTIVE",
    budget: null,
    optimizationGoal: null,
    bidStrategy: null,
    targeting: null,
    placements: null,
    attribution: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const ad1: MetaAd = {
    adId: "ad_resolvable",
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    creativeId: "cr_1",
    name: "Ad 1 (resolvable)",
    status: "ACTIVE",
    destinationUrl: "https://example.com/?utm_source=meta&utm_content=ad_resolvable",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const ad2: MetaAd = {
    adId: "ad_unresolvable",
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    creativeId: "cr_1",
    name: "Ad 2 (unresolvable per URL-tag audit)",
    status: "ACTIVE",
    destinationUrl: "https://example.com/?promo=summer", // no UTM at all
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const creative: MetaCreative = {
    creativeId: "cr_1",
    accountId: ACCOUNT_ID,
    name: "Creative 1",
    imageHash: "hash_abc",
    videoId: null,
    creativeType: "STANDARD",
    memberAssetHashes: null,
    deliveredMixObservable: null,
    bodyText: null,
    headline: null,
    linkUrl: null,
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const asset: CreativeAsset = {
    assetHash: "hash_abc",
    sourceType: "IMAGE",
    metaImageHash: "hash_abc",
    metaVideoId: null,
    perceptualHash: null,
    cloudStoragePath: null,
    thumbnailUrl: null,
    copy: null,
    ocrText: null,
    transcript: null,
    structuredTags: null,
    embedding: null,
    familyId: "hash_abc",
    analysisTimestamp: null,
    analysisModelVersion: null,
    discoveredAt: new Date("2026-08-30T00:00:00Z"),
  };
  const family: CreativeFamily = {
    familyId: "hash_abc",
    memberAssetHashes: ["hash_abc"],
    creativeType: "STANDARD",
    eligibleForFamilyFatigueScore: true,
    familyAgeDays: null,
    totalHistoricalSpendMinorUnits: null,
    activeAdsCount: null,
    variationCount: 1,
    fatigueScore: null,
    createdAt: new Date("2026-08-30T00:00:00Z"),
    updatedAt: new Date("2026-08-30T00:00:00Z"),
  };

  await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
    campaign.campaignId,
    campaign,
  );
  await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).set(
    adset.adsetId,
    adset,
  );
  const adsRepo = createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema);
  await adsRepo.set(ad1.adId, ad1);
  await adsRepo.set(ad2.adId, ad2);
  await createRepository<MetaCreative>(db, COLLECTIONS.metaCreatives, metaCreativeSchema).set(
    creative.creativeId,
    creative,
  );
  await createRepository<CreativeAsset>(db, COLLECTIONS.creativeAssets, creativeAssetSchema).set(
    asset.assetHash,
    asset,
  );
  await createRepository<CreativeFamily>(
    db,
    COLLECTIONS.creativeFamilies,
    creativeFamilySchema,
  ).set(family.familyId, family);

  // The URL-tag audit (B7): ad_unresolvable's destination URL carries no resolvable macro.
  await createRepository<AdUrlTagAudit>(db, COLLECTIONS.adUrlTagAudits, adUrlTagAuditSchema).set(
    ad2.adId,
    {
      adId: ad2.adId,
      auditedAt: new Date("2026-08-30T00:00:00Z"),
      destinationUrl: ad2.destinationUrl,
      utmContentRaw: null,
      utmCampaignRaw: null,
      tagKind: "MISSING",
      resolvable: false,
    },
  );
}

async function seedMetaInsightRow(
  adId: string,
  day: ReportingDay,
  spendMinorUnits: number,
  purchases: number,
  purchaseValueMinorUnits: number,
) {
  const row: MetaInsightsDailyNormalized = {
    adId,
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    reportingDay: day,
    reportingTimezone: "Asia/Kolkata",
    nativeDate: day,
    nativeTimezone: "Asia/Kolkata",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    spend: money(spendMinorUnits),
    purchaseValue: money(purchaseValueMinorUnits),
    impressions: 1000,
    reach: 800,
    frequency: 1.25,
    clicks: 50,
    landingPageViews: 40,
    addToCart: 5,
    initiateCheckout: 2,
    purchases,
    sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    computedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  ).set(`${adId}_${day}`, row);
}

async function seedShopifyOrder(o: {
  orderId: string;
  day: ReportingDay;
  totalPriceMinorUnits: number;
  resolvedAdId: string | null;
  resolutionMethod: "AD_ID" | "NAME_MATCH" | "UNRESOLVED";
  isNewCustomer?: boolean;
}) {
  const order: ShopifyOrderNormalized = {
    orderId: o.orderId,
    reportingDay: o.day,
    reportingTimezone: "Asia/Kolkata",
    nativeCreatedAt: new Date(`${o.day}T10:00:00Z`),
    totalPrice: money(o.totalPriceMinorUnits),
    subtotalPrice: money(o.totalPriceMinorUnits),
    totalDiscounts: money(0),
    totalShipping: null,
    isNewCustomer: o.isNewCustomer ?? false,
    country: "IN",
    customerId: `cust_${o.orderId}`,
    resolvedAdId: o.resolvedAdId,
    resolvedCampaignId: null,
    resolutionMethod: o.resolutionMethod,
    resolutionConfidence:
      o.resolutionMethod === "AD_ID" ? 1 : o.resolutionMethod === "NAME_MATCH" ? 0.4 : null,
    source: "GRAPHQL_SYNC",
    sourceUpdatedAt: new Date(`${o.day}T10:00:00Z`),
    computedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<ShopifyOrderNormalized>(
    db,
    COLLECTIONS.shopifyOrdersNormalized,
    shopifyOrderNormalizedSchema,
  ).set(order.orderId, order);
}

async function seedShopifyRefund(
  orderId: string,
  refundId: string,
  day: ReportingDay,
  amount: number,
) {
  const refund: ShopifyRefundNormalized = {
    orderId,
    refundId,
    reportingDay: day,
    reportingTimezone: "Asia/Kolkata",
    nativeCreatedAt: new Date(`${day}T10:00:00Z`),
    amount: money(amount),
    reason: "customer request",
    sourceUpdatedAt: new Date(`${day}T10:00:00Z`),
    computedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<ShopifyRefundNormalized>(
    db,
    COLLECTIONS.shopifyRefundsNormalized,
    shopifyRefundNormalizedSchema,
  ).set(`${orderId}_${refundId}`, refund);
}

async function seedCoverage(
  fromDay: ReportingDay,
  toDay: ReportingDay,
  gapDay: ReportingDay | null,
) {
  const repo = createRepository<ShopifyDailyCoverage>(
    db,
    COLLECTIONS.shopifyDailyCoverage,
    shopifyDailyCoverageSchema,
  );
  for (let day = fromDay; day <= toDay; day = addCalendarDays(day, 1)) {
    const hasGap = day === gapDay;
    const row: ShopifyDailyCoverage = {
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      accountId: ACCOUNT_ID,
      hasCoverageGap: hasGap,
      gapReason: hasGap ? "test gap" : null,
      ordersObserved: 0,
      refundsObserved: 0,
      computedAt: new Date("2026-08-30T00:00:00Z"),
      sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await repo.set(day, row);
  }
}

async function runRecompute() {
  const syncStore = createFirestoreSyncStore(db);
  const registry = createDefaultRegistry();
  return runSyncTask({
    syncStore,
    registry,
    taskType: "RECOMPUTE_FEATURES",
    payload: { asOfDay: AS_OF_DAY },
    archiver: dummyArchiver,
  });
}

describe("RECOMPUTE_FEATURES (emulator)", () => {
  it("writes a features doc at all five entity levels, with the right entityType and shared accountDataVersion", async () => {
    await seedMetaEntities();
    // 56-day lookback ending 2026-08-30 starts 2026-07-06 — cover the whole span with no gaps
    // for this first assertion.
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, null);
    await seedMetaInsightRow("ad_resolvable", "2026-08-20" as ReportingDay, 100000, 2, 400000);
    await seedMetaInsightRow("ad_unresolvable", "2026-08-20" as ReportingDay, 50000, 1, 150000);
    await seedShopifyOrder({
      orderId: "o1",
      day: "2026-08-20" as ReportingDay,
      totalPriceMinorUnits: 400000,
      resolvedAdId: "ad_resolvable",
      resolutionMethod: "AD_ID",
      isNewCustomer: true,
    });

    const result = await runRecompute();
    expect(result.status).toBe("SUCCEEDED");

    const adDoc = await db.collection(COLLECTIONS.adFeatures).doc("ad_resolvable").get();
    expect(adDoc.exists).toBe(true);
    expect(adDoc.data()?.entityType).toBe("AD");
    const accountDataVersion = adDoc.data()?.accountDataVersion;
    expect(accountDataVersion).toBe(1); // first-ever run

    const adsetDoc = await db.collection(COLLECTIONS.adsetFeatures).doc("as_1").get();
    expect(adsetDoc.exists).toBe(true);
    expect(adsetDoc.data()?.entityType).toBe("ADSET");
    expect(adsetDoc.data()?.accountDataVersion).toBe(accountDataVersion);

    const campaignDoc = await db.collection(COLLECTIONS.adsetFeatures).doc("cmp_1").get();
    expect(campaignDoc.exists).toBe(true);
    expect(campaignDoc.data()?.entityType).toBe("CAMPAIGN");

    const familyDoc = await db.collection(COLLECTIONS.creativeFamilyFeatures).doc("hash_abc").get();
    expect(familyDoc.exists).toBe(true);
    expect(familyDoc.data()?.entityType).toBe("CREATIVE_FAMILY");

    const accountDoc = await db.collection(COLLECTIONS.accountFeatures).doc(ACCOUNT_ID).get();
    expect(accountDoc.exists).toBe(true);
    expect(accountDoc.data()?.entityType).toBe("ACCOUNT");
    expect(accountDoc.data()?.accountDataVersion).toBe(accountDataVersion);
  });

  it("computes correct 28d figures for the resolvable ad: spend/purchases from Meta, attributed revenue from the ID-resolved order only", async () => {
    await seedMetaEntities();
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, null);
    await seedMetaInsightRow("ad_resolvable", "2026-08-20" as ReportingDay, 100000, 2, 400000);
    await seedShopifyOrder({
      orderId: "o1",
      day: "2026-08-20" as ReportingDay,
      totalPriceMinorUnits: 400000,
      resolvedAdId: "ad_resolvable",
      resolutionMethod: "AD_ID",
      isNewCustomer: true,
    });
    // A NAME_MATCH order for the same ad — must NOT be pooled into shopifyAttributedRevenue.
    await seedShopifyOrder({
      orderId: "o2",
      day: "2026-08-21" as ReportingDay,
      totalPriceMinorUnits: 999900,
      resolvedAdId: "ad_resolvable",
      resolutionMethod: "NAME_MATCH",
    });
    await seedShopifyRefund("o1", "r1", "2026-08-22" as ReportingDay, 40000);

    await runRecompute();

    const doc = await db.collection(COLLECTIONS.adFeatures).doc("ad_resolvable").get();
    const window28d = doc.data()?.windows?.["28d"];
    expect(window28d.spendMinorUnits).toBe(100000);
    expect(window28d.purchases.value).toBe(2);
    expect(window28d.metaPurchaseValueMinorUnits).toBe(400000);
    // ID-only: excludes the NAME_MATCH order's 999900.
    expect(window28d.shopifyAttributedPurchases).toBe(1);
    expect(window28d.shopifyAttributedRevenueMinorUnits).toBe(400000);
    expect(window28d.shopifyNetRevenueMinorUnits).toBe(360000); // 400000 - 40000 refund
    expect(window28d.attribution).toEqual({
      attributionWindow: "7d_click_1d_view",
      purchaseActionType: "omni_purchase",
    });
    expect(window28d.shopifyDataGap).toEqual({ windowHasDataGap: false, gapDays: [] });
  });

  it("§6.3: the unresolvable ad's Shopify-attributed figures are null, never zero — Meta figures unaffected", async () => {
    await seedMetaEntities();
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, null);
    await seedMetaInsightRow("ad_unresolvable", "2026-08-20" as ReportingDay, 75000, 3, 300000);

    await runRecompute();

    const doc = await db.collection(COLLECTIONS.adFeatures).doc("ad_unresolvable").get();
    const window28d = doc.data()?.windows?.["28d"];
    expect(window28d.shopifyAttributedPurchases).toBeNull();
    expect(window28d.shopifyAttributedRevenueMinorUnits).toBeNull();
    expect(window28d.shopifyNetRevenueMinorUnits).toBeNull();
    expect(window28d.shopifyRoas.value).toBeNull();
    expect(window28d.aov).toBeNull();
    // Meta-only figures are still real, populated numbers for the SAME ad.
    expect(window28d.spendMinorUnits).toBe(75000);
    expect(window28d.purchases.value).toBe(3);
    expect(window28d.metaRoas.value).toBeCloseTo(300000 / 75000);
  });

  it("⚠️ gap-safety: a Shopify coverage gap inside the 28d window flags windowHasDataGap on the Shopify figures while leaving Meta figures untouched", async () => {
    await seedMetaEntities();
    // Gap day sits inside the 28d window (2026-08-03..2026-08-30) but outside the 7d window
    // (2026-08-24..2026-08-30), so 28d should be flagged and 7d should not.
    const gapDay = "2026-08-10" as ReportingDay;
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, gapDay);
    await seedMetaInsightRow("ad_resolvable", "2026-08-25" as ReportingDay, 100000, 2, 400000);
    await seedShopifyOrder({
      orderId: "o1",
      day: "2026-08-25" as ReportingDay,
      totalPriceMinorUnits: 400000,
      resolvedAdId: "ad_resolvable",
      resolutionMethod: "AD_ID",
    });

    await runRecompute();

    const doc = await db.collection(COLLECTIONS.adFeatures).doc("ad_resolvable").get();
    const window28d = doc.data()?.windows?.["28d"];
    const window7d = doc.data()?.windows?.["7d"];

    expect(window28d.shopifyDataGap.windowHasDataGap).toBe(true);
    expect(window28d.shopifyDataGap.gapDays).toContain(gapDay);
    // Not suppressed — the real, computed number is still there, just flagged.
    expect(window28d.shopifyAttributedRevenueMinorUnits).toBe(400000);
    // Meta figures for the exact same window are untouched by the Shopify-side gap.
    expect(window28d.spendMinorUnits).toBe(100000);
    expect(window28d.purchases.value).toBe(2);

    // The 7d window doesn't overlap the gap day at all.
    expect(window7d.shopifyDataGap.windowHasDataGap).toBe(false);
  });

  it("blendedMerAccountOnly is populated at ACCOUNT level only, using unconditional (not attribution-filtered) Shopify revenue", async () => {
    await seedMetaEntities();
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, null);
    await seedMetaInsightRow("ad_resolvable", "2026-08-20" as ReportingDay, 100000, 2, 400000);
    await seedMetaInsightRow("ad_unresolvable", "2026-08-20" as ReportingDay, 50000, 1, 150000);
    // One resolved order and one wholly UNRESOLVED order — blended MER must count BOTH, since it
    // uses no attribution at all (§6.3's third consequence).
    await seedShopifyOrder({
      orderId: "o1",
      day: "2026-08-20" as ReportingDay,
      totalPriceMinorUnits: 400000,
      resolvedAdId: "ad_resolvable",
      resolutionMethod: "AD_ID",
    });
    await seedShopifyOrder({
      orderId: "o2",
      day: "2026-08-21" as ReportingDay,
      totalPriceMinorUnits: 999900,
      resolvedAdId: null,
      resolutionMethod: "UNRESOLVED",
    });

    await runRecompute();

    const accountDoc = await db.collection(COLLECTIONS.accountFeatures).doc(ACCOUNT_ID).get();
    const window28d = accountDoc.data()?.windows?.["28d"];
    // total spend = 150000, total shopify revenue (unconditional) = 400000 + 999900 = 1399900
    expect(window28d.blendedMerAccountOnly).toBeCloseTo(1399900 / 150000);

    const adDoc = await db.collection(COLLECTIONS.adFeatures).doc("ad_resolvable").get();
    expect(adDoc.data()?.windows?.["28d"].blendedMerAccountOnly).toBeNull();
  });

  it("accountDataVersion bumps by exactly 1 on a second run, applied to every doc written that run", async () => {
    await seedMetaEntities();
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, null);
    await seedMetaInsightRow("ad_resolvable", "2026-08-20" as ReportingDay, 100000, 2, 400000);

    const first = await runRecompute();
    expect(first.status).toBe("SUCCEEDED");
    const v1 = (await db.collection(COLLECTIONS.accountFeatures).doc(ACCOUNT_ID).get()).data()
      ?.accountDataVersion;
    expect(v1).toBe(1);

    const second = await runRecompute();
    expect(second.status).toBe("SUCCEEDED");
    const v2doc = await db.collection(COLLECTIONS.accountFeatures).doc(ACCOUNT_ID).get();
    expect(v2doc.data()?.accountDataVersion).toBe(2);
    const adV2 = await db.collection(COLLECTIONS.adFeatures).doc("ad_resolvable").get();
    expect(adV2.data()?.accountDataVersion).toBe(2);
  });

  it("§10.1 full recompute stays well inside a sync interval for this fixture's scale", async () => {
    await seedMetaEntities();
    await seedCoverage("2026-07-06" as ReportingDay, AS_OF_DAY, null);
    await seedMetaInsightRow("ad_resolvable", "2026-08-20" as ReportingDay, 100000, 2, 400000);

    const start = Date.now();
    const result = await runRecompute();
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe("SUCCEEDED");
    // Loose bound per this step's own "prefer clarity over cleverness" — this fixture is tiny
    // (2 ads); the realistic-scale timing is measured separately (see this step's report).
    expect(elapsedMs).toBeLessThan(15000);
  });
});
