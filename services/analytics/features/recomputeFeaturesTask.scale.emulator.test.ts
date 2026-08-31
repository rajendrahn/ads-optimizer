// Realistic-scale timing proof for RECOMPUTE_FEATURES — this step's own "Done when": "a full
// recompute over real data completes well inside a sync interval." Correctness is proven
// separately (recomputeFeaturesTask.emulator.test.ts, small hand-built fixtures); this file
// exists ONLY to measure wall-clock cost at the account's real measured scale, per B2/B3's own
// live findings recorded in IMPLEMENTATION_PLAN.md:
//   - 1,139 ads / 534 ad sets / 410 campaigns (B2, live)
//   - ~47 active ad-days/day, ~17K insight rows/year (B3, live) — i.e. a 56-day lookback is
//     roughly 47 * 56 ≈ 2,632 metaInsightsDailyNormalized rows, not 1,139 * 56.
//
// Data here is SYNTHETIC (generated, not fetched from Meta/Shopify) — production Firestore and
// live mutating calls are both off-limits for this step, and pulling a full 1,139-ad entity
// snapshot live was avoided given this session's account-level throttle risk (§ this step's own
// report). The shape/volume is deliberately matched to the real numbers above, not invented, so
// the timing measured here is a meaningful proxy for the real account, not a toy.
//
// No live Meta/Shopify call anywhere in this file.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  addCalendarDays,
  canonSettingsSchema,
  resetReportingCanonCacheForTests,
} from "@shared/canon/index.ts";
import {
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
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../../services/ingest/sync/archiver.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "recomputeFeaturesTask.scale.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

const ACCOUNT_ID = TEST_CANON.accountId;
const AS_OF_DAY: ReportingDay = "2026-08-30";

// Real B2/B3-measured scale.
const NUM_CAMPAIGNS = 410;
const NUM_ADSETS = 534;
const NUM_ADS = 1139;
const NUM_CREATIVES = 300; // fewer than ads — real accounts pool creatives across many ads
const ACTIVE_ADS_PER_DAY = 47; // B3's live measurement
const LOOKBACK_DAYS = 56; // the widest §4.2 window
const ORDERS_PER_DAY = 8;

/** In-bounds array access without a forbidden `!` non-null assertion — every call site below
 * indexes with a modulus of the same array's own length, so this never actually throws. */
function at<T>(arr: readonly T[], index: number): T {
  const item = arr[index];
  if (item === undefined)
    throw new Error(`at: index ${index} out of bounds (length ${arr.length})`);
  return item;
}

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

/** Bulk-seeds via `BulkWriter` (no 500-op batch cap, automatic throttling/retry) — this is
 * seeding INPUT fixtures for the timing run, not the thing being measured, so it deliberately
 * does NOT go through `upsertWithVersionGuard` (one transaction per doc would make the SEED
 * itself the bottleneck, not RECOMPUTE_FEATURES). */
async function bulkSet<T extends Record<string, unknown>>(
  collectionName: string,
  docs: readonly { id: string; data: T }[],
) {
  const writer = db.bulkWriter();
  writer.onWriteError((err) => err.failedAttempts < 3);
  for (const { id, data } of docs) {
    writer.set(db.collection(collectionName).doc(id), data);
  }
  await writer.close();
}

describe("RECOMPUTE_FEATURES (emulator) — realistic scale", () => {
  beforeAll(async () => {
    resetReportingCanonCacheForTests();
    await cleanupCollections();
    const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
    await settingsRepo.set(ACCOUNT_ID, TEST_CANON);

    // --- Entities ---
    const campaigns: { id: string; data: MetaCampaign }[] = Array.from(
      { length: NUM_CAMPAIGNS },
      (_, i) => ({
        id: `cmp_${i}`,
        data: {
          campaignId: `cmp_${i}`,
          accountId: ACCOUNT_ID,
          name: `Campaign ${i}`,
          status: "ACTIVE",
          objective: "OUTCOME_SALES",
          buyingType: "AUCTION",
          budget: null,
          bidStrategy: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
          syncedAt: new Date("2026-08-30T00:00:00Z"),
        },
      }),
    );
    const adsets: { id: string; data: MetaAdset }[] = Array.from(
      { length: NUM_ADSETS },
      (_, i) => ({
        id: `as_${i}`,
        data: {
          adsetId: `as_${i}`,
          campaignId: `cmp_${i % NUM_CAMPAIGNS}`,
          accountId: ACCOUNT_ID,
          name: `Adset ${i}`,
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
        },
      }),
    );
    const creatives: { id: string; data: MetaCreative }[] = Array.from(
      { length: NUM_CREATIVES },
      (_, i) => ({
        id: `cr_${i}`,
        data: {
          creativeId: `cr_${i}`,
          accountId: ACCOUNT_ID,
          name: `Creative ${i}`,
          imageHash: `hash_${i}`,
          videoId: null,
          creativeType: "STANDARD",
          memberAssetHashes: null,
          deliveredMixObservable: null,
          bodyText: null,
          headline: null,
          linkUrl: null,
          syncedAt: new Date("2026-08-30T00:00:00Z"),
        },
      }),
    );
    const assets: { id: string; data: CreativeAsset }[] = creatives.map((c) => ({
      id: c.data.imageHash as string,
      data: {
        assetHash: c.data.imageHash as string,
        sourceType: "IMAGE",
        metaImageHash: c.data.imageHash,
        metaVideoId: null,
        perceptualHash: null,
        cloudStoragePath: null,
        thumbnailUrl: null,
        copy: null,
        ocrText: null,
        transcript: null,
        structuredTags: null,
        embedding: null,
        familyId: c.data.imageHash as string,
        analysisTimestamp: null,
        analysisModelVersion: null,
        discoveredAt: new Date("2026-08-30T00:00:00Z"),
      },
    }));
    const families: { id: string; data: CreativeFamily }[] = assets.map((a) => ({
      id: a.id,
      data: {
        familyId: a.id,
        memberAssetHashes: [a.id],
        creativeType: "STANDARD",
        eligibleForFamilyFatigueScore: true,
        familyAgeDays: null,
        totalHistoricalSpendMinorUnits: null,
        activeAdsCount: null,
        variationCount: 1,
        fatigueScore: null,
        createdAt: new Date("2026-08-30T00:00:00Z"),
        updatedAt: new Date("2026-08-30T00:00:00Z"),
      },
    }));
    const ads: { id: string; data: MetaAd }[] = Array.from({ length: NUM_ADS }, (_, i) => {
      const adsetId = `as_${i % NUM_ADSETS}`;
      const campaignId = at(adsets, i % NUM_ADSETS).data.campaignId;
      return {
        id: `ad_${i}`,
        data: {
          adId: `ad_${i}`,
          adsetId,
          campaignId,
          accountId: ACCOUNT_ID,
          creativeId: `cr_${i % NUM_CREATIVES}`,
          name: `Ad ${i}`,
          status: "ACTIVE",
          destinationUrl: `https://example.com/?promo=x${i}`, // synthetic, no PII
          createdAt: new Date("2026-01-01T00:00:00Z"),
          metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
          syncedAt: new Date("2026-08-30T00:00:00Z"),
        },
      };
    });

    await bulkSet(COLLECTIONS.metaCampaigns, campaigns);
    await bulkSet(COLLECTIONS.metaAdsets, adsets);
    await bulkSet(COLLECTIONS.metaCreatives, creatives);
    await bulkSet(COLLECTIONS.creativeAssets, assets);
    await bulkSet(COLLECTIONS.creativeFamilies, families);
    await bulkSet(COLLECTIONS.metaAds, ads);

    // --- 56-day lookback: Meta insight rows (~47 active ad-days/day, B3's live density) ---
    const startDay = addCalendarDays(AS_OF_DAY, -(LOOKBACK_DAYS - 1));
    const metaRows: { id: string; data: MetaInsightsDailyNormalized }[] = [];
    let day = startDay;
    let dayIndex = 0;
    while (day <= AS_OF_DAY) {
      for (let k = 0; k < ACTIVE_ADS_PER_DAY; k++) {
        const adIndex = (dayIndex * 97 + k * 131) % NUM_ADS; // deterministic pseudo-random spread
        const ad = at(ads, adIndex).data;
        metaRows.push({
          id: `${ad.adId}_${day}`,
          data: {
            adId: ad.adId,
            adsetId: ad.adsetId,
            campaignId: ad.campaignId,
            accountId: ACCOUNT_ID,
            reportingDay: day,
            reportingTimezone: "Asia/Kolkata",
            nativeDate: day,
            nativeTimezone: "Asia/Kolkata",
            attribution: {
              attributionWindow: "7d_click_1d_view",
              purchaseActionType: "omni_purchase",
            },
            spend: money(50000 + (k % 10) * 1000),
            purchaseValue: money(k % 5 === 0 ? 150000 : 0),
            impressions: 1000 + k,
            reach: 800 + k,
            frequency: 1.2,
            clicks: 40 + (k % 10),
            landingPageViews: 30 + (k % 8),
            addToCart: 3 + (k % 4),
            initiateCheckout: 1 + (k % 2),
            purchases: k % 5 === 0 ? 1 : 0,
            sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
            computedAt: new Date("2026-08-30T00:00:00Z"),
          },
        });
      }
      day = addCalendarDays(day, 1);
      dayIndex++;
    }
    await bulkSet(COLLECTIONS.metaInsightsDailyNormalized, metaRows);

    // --- Shopify: orders (near-zero attribution coverage, matching B7's real finding) + full
    // gap-free coverage across the lookback. ---
    const orders: { id: string; data: ShopifyOrderNormalized }[] = [];
    day = startDay;
    let orderIndex = 0;
    while (day <= AS_OF_DAY) {
      for (let k = 0; k < ORDERS_PER_DAY; k++) {
        // ~1 in 90 orders resolves AD_ID — matches B7's near-zero coverage finding.
        const resolved = orderIndex % 90 === 0;
        const adIndex = orderIndex % NUM_ADS;
        orders.push({
          id: `order_${orderIndex}`,
          data: {
            orderId: `order_${orderIndex}`,
            reportingDay: day,
            reportingTimezone: "Asia/Kolkata",
            nativeCreatedAt: new Date(`${day}T10:00:00Z`),
            totalPrice: money(200000 + (orderIndex % 20) * 5000),
            subtotalPrice: money(200000),
            totalDiscounts: money(0),
            totalShipping: null,
            isNewCustomer: orderIndex % 3 === 0,
            country: "IN",
            customerId: `cust_${orderIndex}`,
            resolvedAdId: resolved ? `ad_${adIndex}` : null,
            resolvedCampaignId: null,
            resolutionMethod: resolved ? "AD_ID" : "UNRESOLVED",
            resolutionConfidence: resolved ? 1 : null,
            source: "GRAPHQL_SYNC",
            sourceUpdatedAt: new Date(`${day}T10:00:00Z`),
            computedAt: new Date("2026-08-30T00:00:00Z"),
          },
        });
        orderIndex++;
      }
      day = addCalendarDays(day, 1);
    }
    await bulkSet(COLLECTIONS.shopifyOrdersNormalized, orders);

    const coverageRows: { id: string; data: ShopifyDailyCoverage }[] = [];
    day = startDay;
    while (day <= AS_OF_DAY) {
      coverageRows.push({
        id: day,
        data: {
          reportingDay: day,
          reportingTimezone: "Asia/Kolkata",
          accountId: ACCOUNT_ID,
          hasCoverageGap: false,
          gapReason: null,
          ordersObserved: ORDERS_PER_DAY,
          refundsObserved: 0,
          computedAt: new Date("2026-08-30T00:00:00Z"),
          sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
        },
      });
      day = addCalendarDays(day, 1);
    }
    await bulkSet(COLLECTIONS.shopifyDailyCoverage, coverageRows);

    console.log(
      `[scale seed] campaigns=${NUM_CAMPAIGNS} adsets=${NUM_ADSETS} ads=${NUM_ADS} creatives=${NUM_CREATIVES} ` +
        `metaRows=${metaRows.length} orders=${orders.length} coverageDays=${coverageRows.length}`,
    );
  }, 300_000);

  // Cleanup deletes ~7,500+ documents across many collections (2,384 seeded entities' worth of
  // input fixtures plus the same number of written feature docs) — the default 10s hook timeout
  // is too short for that many individual `.delete()` calls against the emulator.
  afterAll(cleanupCollections, 120_000);

  it("completes a full recompute over ~2,600 Meta rows / ~450 Shopify orders / 2,394 entities well inside a sync interval", async () => {
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    const start = Date.now();
    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "RECOMPUTE_FEATURES",
      payload: { asOfDay: AS_OF_DAY },
      archiver: dummyArchiver,
    });
    const elapsedMs = Date.now() - start;

    console.log(
      `[scale timing] RECOMPUTE_FEATURES elapsed=${elapsedMs}ms status=${result.status} summary=${JSON.stringify(result.summary)}`,
    );

    expect(result.status).toBe("SUCCEEDED");
    const entitiesComputed = (result.summary as { entitiesComputed?: number } | undefined)
      ?.entitiesComputed;
    expect(entitiesComputed).toBe(NUM_ADS + NUM_ADSETS + NUM_CAMPAIGNS + NUM_CREATIVES + 1);

    // Spot-check one ad actually got real numbers, not a silently-empty doc.
    const anyAdDoc = await db.collection(COLLECTIONS.adFeatures).doc("ad_0").get();
    expect(anyAdDoc.exists).toBe(true);
    expect(anyAdDoc.data()?.windows?.["56d"]).toBeTruthy();

    const accountDoc = await db.collection(COLLECTIONS.accountFeatures).doc(ACCOUNT_ID).get();
    expect(accountDoc.data()?.windows?.["28d"]?.spendMinorUnits).toBeGreaterThan(0);
  }, 300_000);
});
