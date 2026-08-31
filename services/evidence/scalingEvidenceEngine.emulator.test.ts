// D1's own "Done when" bar, proven end to end against a real Firestore emulator and the REAL,
// unmodified RECOMPUTE_FEATURES -> COMPUTE_STATISTICS -> ENRICH_CHANGE_FEATURES pipeline (C2/C3/
// C4's own task handlers, not hand-built EntityFeatures fixtures) — the same "real pipeline,
// seeded realistic volume" pattern C2/C3/C4's own emulator tests use.
//
// Four scenarios, matching this step's own required demonstrations:
//   1. A real ad set (AS_17, matching §14's own worked example id) produces the full §14
//      evidence object.
//   2. A low-volume ad (id 238591234, also matching §14's own worked example) escalates to its
//      ad set with reason SAMPLE_TOO_SMALL.
//   3. An entity whose budget ownership is genuinely UNKNOWN (B2's real orphaned-campaign case)
//      produces NO_DECISION_UNIT, never a guessed level.
//   4. An ad set that exists in Meta's config but has zero delivery produces NOT_DELIVERING,
//      never a fabricated verdict or a misleading "escalate" answer.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
  creativeAssetSchema,
  creativeFamilySchema,
  metaInsightsDailyNormalizedSchema,
  shopifyDailyCoverageSchema,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaCreative,
  type CreativeAsset,
  type CreativeFamily,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type ReportingDay,
  type ShopifyDailyCoverage,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../services/ingest/sync/archiver.ts";
import { addCalendarDays } from "@shared/canon/index.ts";
import { resolveScalingEvidence } from "./scalingEvidenceEngine.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "scalingEvidenceEngine.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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
  COLLECTIONS.metaChangeEvents,
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
const AS_OF_DAY: ReportingDay = "2026-08-30";

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(ACCOUNT_ID, TEST_CANON);
});
afterAll(cleanupCollections);

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

/** Spreads `totalPurchases`/`totalSpendMinorUnits`/`totalPurchaseValueMinorUnits` evenly across
 * the trailing `days` reporting days ending AS_OF_DAY — same cumulative-rounding-differencing
 * technique C3's own computeStatisticsTask.emulator.test.ts uses, so the daily buckets sum to
 * exactly the requested total regardless of how small it is relative to `days`. */
async function seedAdVolume(
  adId: string,
  adsetId: string,
  campaignId: string,
  days: number,
  totalPurchases: number,
  totalSpendMinorUnits: number,
  totalPurchaseValueMinorUnits: number,
) {
  const repo = createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  );
  function bucket(total: number, i: number): number {
    return Math.round((total * (i + 1)) / days) - Math.round((total * i) / days);
  }
  for (let i = 0; i < days; i++) {
    const day = addCalendarDays(AS_OF_DAY, -i) as ReportingDay;
    const row: MetaInsightsDailyNormalized = {
      adId,
      adsetId,
      campaignId,
      accountId: ACCOUNT_ID,
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      nativeDate: day,
      nativeTimezone: "Asia/Kolkata",
      attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
      spend: money(Math.max(0, bucket(totalSpendMinorUnits, i))),
      purchaseValue: money(Math.max(0, bucket(totalPurchaseValueMinorUnits, i))),
      impressions: 500,
      reach: 400,
      frequency: 1.25,
      clicks: 25,
      landingPageViews: 20,
      addToCart: 3,
      initiateCheckout: 1,
      purchases: Math.max(0, bucket(totalPurchases, i)),
      sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
      computedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await repo.set(`${adId}_${day}`, row);
  }
}

async function seedCoverage(fromDay: ReportingDay, toDay: ReportingDay) {
  const repo = createRepository<ShopifyDailyCoverage>(
    db,
    COLLECTIONS.shopifyDailyCoverage,
    shopifyDailyCoverageSchema,
  );
  for (let day = fromDay; day <= toDay; day = addCalendarDays(day, 1)) {
    const row: ShopifyDailyCoverage = {
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      accountId: ACCOUNT_ID,
      hasCoverageGap: false,
      gapReason: null,
      ordersObserved: 0,
      refundsObserved: 0,
      computedAt: new Date("2026-08-30T00:00:00Z"),
      sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await repo.set(day, row);
  }
}

async function runFullPipeline() {
  const syncStore = createFirestoreSyncStore(db);
  const registry = createDefaultRegistry();
  const recompute = await runSyncTask({
    syncStore,
    registry,
    taskType: "RECOMPUTE_FEATURES",
    payload: { asOfDay: AS_OF_DAY },
    archiver: dummyArchiver,
  });
  expect(recompute.status).toBe("SUCCEEDED");
  const stats = await runSyncTask({
    syncStore,
    registry,
    taskType: "COMPUTE_STATISTICS",
    payload: {},
    archiver: dummyArchiver,
  });
  expect(stats.status).toBe("SUCCEEDED");
  const changeFeatures = await runSyncTask({
    syncStore,
    registry,
    taskType: "ENRICH_CHANGE_FEATURES",
    payload: { asOfDay: AS_OF_DAY },
    archiver: dummyArchiver,
  });
  expect(changeFeatures.status).toBe("SUCCEEDED");
}

describe("resolveScalingEvidence — real pipeline, real emulator (D1's own Done-when bar)", () => {
  it("1) produces the full §14 evidence object for a real ad set (AS_17)", async () => {
    const campaign: MetaCampaign = {
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      name: "Bridal Sets — Prospecting",
      status: "ACTIVE",
      objective: "OUTCOME_SALES",
      buyingType: "AUCTION",
      budget: null, // defers to ad-set level (ABO)
      bidStrategy: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    const adset: MetaAdset = {
      adsetId: "AS_17",
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      name: "AS-17 — Bridal broad",
      status: "ACTIVE",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 500_00,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      optimizationGoal: "OFFSITE_CONVERSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: null,
      placements: null,
      attribution: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
      campaign.campaignId,
      campaign,
    );
    await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).set(
      adset.adsetId,
      adset,
    );

    const adIds = Array.from({ length: 9 }, (_, i) => `ad_pool_${i}`);
    const adsRepo = createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema);
    for (const adId of adIds) {
      const ad: MetaAd = {
        adId,
        adsetId: "AS_17",
        campaignId: "cmp_1",
        accountId: ACCOUNT_ID,
        creativeId: null,
        name: `Ad ${adId}`,
        status: "ACTIVE",
        destinationUrl: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        syncedAt: new Date("2026-08-30T00:00:00Z"),
      };
      await adsRepo.set(adId, ad);
      // 30 purchases/28d each, ROAS 4.0 — individually below the 30-purchase floor is not
      // required here (30 clears it exactly), the point is real POOLED volume at the ad set.
      await seedAdVolume(adId, "AS_17", "cmp_1", 28, 30, 300_000, 1_200_000);
    }
    await seedCoverage("2026-08-03" as ReportingDay, AS_OF_DAY);

    await runFullPipeline();

    const result = await resolveScalingEvidence({
      db,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });
    expect(result.outcome).toBe("EVIDENCE");
    if (result.outcome !== "EVIDENCE") return;
    const { evidence } = result;

    // §14's own shape, checked field by field.
    expect(evidence.decisionUnit).toEqual({ type: "ADSET", id: "AS_17" });
    expect(evidence.decisionUnitName).toBe("AS-17 — Bridal broad");
    expect(evidence.escalatedFrom).toBeUndefined(); // named directly — no escalation
    expect(evidence.budgetOwner.ownerLevel).toBe("ADSET");
    expect(evidence.budgetOwner.dailyBudgetMinorUnits).toBe(50000);
    expect(evidence.evidence.roas28d?.purchases).toBe(270); // 9 * 30
    expect(evidence.evidence.roas28d?.value).toBeCloseTo(4.0, 5);
    expect(evidence.evidence.roas28d?.verdict).toBe("ABOVE_TARGET");
    expect(evidence.evidence.roas28dShrunk).not.toBeNull();
    expect(evidence.evidence.targetRoas).toBe(3.0);
    expect(evidence.targets.source).toBe("default");
    expect(evidence.evidence.deliveryStability.isDelivering).toBe(true);
    expect(evidence.evidence.windows["7d"]).toBeDefined();
    expect(evidence.evidence.windows["14d"]).toBeDefined();
    expect(evidence.evidence.windows["56d"]).toBeDefined();
    // Real volume (270/28d -> ~67.5/week) clears the learning-phase threshold — eligible.
    expect(evidence.evidence.learningState.inLearningPhase).toBe(false);
    expect(evidence.eligibleToScale).toBe(true);
    expect(evidence.suggestedChangePercent).not.toBeNull();
    expect(evidence.safeRangePercent).not.toBeNull();
    expect(evidence.safeRangePercent?.[1] ?? 0).toBeLessThan(20);
    expect(evidence.confidence).toBeGreaterThan(0);
    // Shopify coverage is near-zero on this account — the caveat must always be present.
    expect(evidence.evidence.shopify.note).toMatch(/not reliable/i);
  });

  it("2) a low-volume ad (238591234) escalates to its ad set, naming the reason SAMPLE_TOO_SMALL", async () => {
    const campaign: MetaCampaign = {
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      name: "Bridal Sets — Prospecting",
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
      adsetId: "AS_17",
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      name: "AS-17 — Bridal broad",
      status: "ACTIVE",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 500_00,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      optimizationGoal: "OFFSITE_CONVERSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: null,
      placements: null,
      attribution: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
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
    const poolAdIds = Array.from({ length: 9 }, (_, i) => `ad_pool_${i}`);
    for (const adId of poolAdIds) {
      await adsRepo.set(adId, {
        adId,
        adsetId: "AS_17",
        campaignId: "cmp_1",
        accountId: ACCOUNT_ID,
        creativeId: null,
        name: `Ad ${adId}`,
        status: "ACTIVE",
        destinationUrl: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        syncedAt: new Date("2026-08-30T00:00:00Z"),
      });
      await seedAdVolume(adId, "AS_17", "cmp_1", 28, 30, 300_000, 1_200_000);
    }

    // The low-volume ad — §14's own worked example id, and its own worked example purchase
    // count ("6 purchases in 28 days").
    const lowVolumeAdId = "238591234";
    const creative: MetaCreative = {
      creativeId: "cr_low_volume",
      accountId: ACCOUNT_ID,
      name: "Bridal set — carousel v3",
      imageHash: "hash_low_volume",
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
      assetHash: "hash_low_volume",
      sourceType: "IMAGE",
      metaImageHash: "hash_low_volume",
      metaVideoId: null,
      perceptualHash: null,
      cloudStoragePath: null,
      thumbnailUrl: null,
      copy: null,
      ocrText: null,
      transcript: null,
      structuredTags: null,
      embedding: null,
      familyId: "hash_low_volume",
      analysisTimestamp: null,
      analysisModelVersion: null,
      discoveredAt: new Date("2026-08-30T00:00:00Z"),
    };
    const family: CreativeFamily = {
      familyId: "hash_low_volume",
      memberAssetHashes: ["hash_low_volume"],
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
    await adsRepo.set(lowVolumeAdId, {
      adId: lowVolumeAdId,
      adsetId: "AS_17",
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      creativeId: "cr_low_volume",
      name: "Ad XYZ",
      status: "ACTIVE",
      destinationUrl: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    });
    await seedAdVolume(lowVolumeAdId, "AS_17", "cmp_1", 28, 6, 60_000, 240_000);
    await seedCoverage("2026-08-03" as ReportingDay, AS_OF_DAY);

    await runFullPipeline();

    const result = await resolveScalingEvidence({
      db,
      namedEntity: { type: "AD", id: lowVolumeAdId },
    });
    expect(result.outcome).toBe("EVIDENCE");
    if (result.outcome !== "EVIDENCE") return;
    const { evidence } = result;

    expect(evidence.decisionUnit).toEqual({ type: "ADSET", id: "AS_17" });
    expect(evidence.escalatedFrom).toEqual({
      type: "AD",
      id: "238591234",
      reason: "SAMPLE_TOO_SMALL",
    });
    // The ad set's own pooled evidence is what's returned — real, confident volume.
    expect(evidence.evidence.roas28d?.purchases).toBe(276); // 9*30 + 6
    expect(evidence.evidence.roas28d?.verdict).toBe("ABOVE_TARGET");
    // Creative fatigue is reported for the NAMED ad's own family, not the ad set's.
    expect(evidence.evidence.creativeFatigue.applicable).toBe(true);
    expect(evidence.evidence.creativeFatigue.familyId).toBe("hash_low_volume");
  });

  it("3) budget ownership genuinely UNKNOWN (an orphaned campaign) yields NO_DECISION_UNIT, never a guessed level", async () => {
    const orphan: MetaCampaign = {
      campaignId: "cmp_orphan",
      accountId: ACCOUNT_ID,
      name: "Sales — 2023 (orphaned)",
      status: "PAUSED",
      objective: null,
      buyingType: null,
      // B2's real live finding: an old PAUSED campaign whose ad sets Meta no longer returns and
      // which reports no budget of its own — genuinely ambiguous, not a guessable level.
      budget: {
        ownerLevel: "UNKNOWN",
        dailyBudgetMinorUnits: null,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      bidStrategy: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2024-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
      orphan.campaignId,
      orphan,
    );

    await runFullPipeline();

    const result = await resolveScalingEvidence({
      db,
      namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
    });
    expect(result.outcome).toBe("NO_DECISION_UNIT");
    if (result.outcome !== "NO_DECISION_UNIT") return;
    expect(result.detail).toMatch(/UNKNOWN/i);
  });

  it("4) an ad set with zero delivery yields NOT_DELIVERING, never a fabricated verdict", async () => {
    const campaign: MetaCampaign = {
      campaignId: "cmp_2",
      accountId: ACCOUNT_ID,
      name: "Legacy remarketing (inactive)",
      status: "ACTIVE",
      objective: null,
      buyingType: null,
      budget: null,
      bidStrategy: null,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      metaUpdatedAt: new Date("2024-06-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    const deadAdset: MetaAdset = {
      adsetId: "as_dead",
      campaignId: "cmp_2",
      accountId: ACCOUNT_ID,
      name: "Legacy remarketing ad set",
      status: "ACTIVE", // still "active" in Meta's config, but not actually delivering (C4's own
      // orchestrator finding: most of this account's 534 real ad sets are exactly this shape)
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 10_00,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      optimizationGoal: null,
      bidStrategy: null,
      targeting: null,
      placements: null,
      attribution: null,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      metaUpdatedAt: new Date("2024-06-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
      campaign.campaignId,
      campaign,
    );
    await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).set(
      deadAdset.adsetId,
      deadAdset,
    );
    // Deliberately NO metaInsightsDailyNormalized rows for this ad set — zero delivery.

    await runFullPipeline();

    const result = await resolveScalingEvidence({
      db,
      namedEntity: { type: "ADSET", id: "as_dead" },
    });
    expect(result.outcome).toBe("NOT_DELIVERING");
    if (result.outcome !== "NOT_DELIVERING") return;
    expect(result.decisionUnit).toEqual({ type: "ADSET", id: "as_dead" });
    expect(result.detail).toMatch(/not delivering|no computed features/i);
  });
});
