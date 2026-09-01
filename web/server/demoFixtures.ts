// D6 — shared synthetic-account fixture builder, used by both seedDemo.ts (a plain `tsx` script,
// no test runner) and web/server/webApi.emulator.test.ts (a real vitest emulator test). Kept as
// its own module, deliberately NOT importing "vitest" anywhere, so seedDemo.ts stays runnable
// outside the vitest CLI — see seedDemo.ts's own note on why importing `testFixtures.ts`
// (services/ingest/meta/entities/) breaks that (`import { vi } from "vitest"` at module scope
// throws when merely imported outside a running vitest process).
//
// Every id here is synthetic (`AS_17`, `cmp_1`, ...) — no real Meta/Shopify identifier appears in
// this file, per this step's constraint on fixtures. Mirrors D4's own
// generateRecommendationTask.emulator.test.ts fixture in shape (`seedAdVolume`/`seedCoverage`/
// `runFullPipeline`), extended with the additional scenarios D6 needs to prove every outcome
// renders (see the exported `DEMO_ENTITIES` map for what each one is for).

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { addCalendarDays, canonSettingsSchema, type CanonSettings } from "@shared/canon/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaInsightsDailyNormalizedSchema,
  shopifyDailyCoverageSchema,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type ReportingDay,
  type ShopifyDailyCoverage,
} from "@shared/schema/index.ts";
import { createTaskRegistry } from "@services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "@services/ingest/sync/store.ts";
import { runSyncTask } from "@services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "@services/ingest/sync/archiver.ts";
import { recomputeFeaturesRegistration } from "@services/analytics/features/index.ts";
import { computeStatisticsRegistration } from "@services/analytics/statistics/index.ts";
import { enrichChangeFeaturesRegistration } from "@services/analytics/changeFeatures/index.ts";

export const AS_OF_DAY = "2026-08-30" as ReportingDay;

export const DEMO_ENTITIES = {
  healthy: { type: "ADSET", id: "AS_17" } as const, // eligible -> INCREASE_BUDGET (EVIDENCE)
  notDelivering: { type: "ADSET", id: "AS_dead" } as const, // zero delivery -> NOT_DELIVERING
  noDecisionUnit: { type: "CAMPAIGN", id: "cmp_orphan" } as const, // no budget/ad sets -> NO_DECISION_UNIT
  escalates: { type: "AD", id: "ad_lowvol" } as const, // low volume -> escalates to AS_17
  fails: { type: "ADSET", id: "AS_faildemo" } as const, // demo client throws -> FAILED
  rejected: { type: "ADSET", id: "AS_overlimit" } as const, // real guardrail rejects -> REJECTED
};

export function demoCanon(accountId: string): CanonSettings {
  return {
    accountId,
    reportingTimezone: "Asia/Kolkata",
    reportingCurrency: "INR",
    attributionWindow: "7d_click_1d_view",
    purchaseActionType: "offsite_conversion.fb_pixel_purchase",
    modelConfig: {
      recommendationProvider: "anthropic",
      recommendationModel: "claude-fable-5",
      creativeReasoningModel: "claude-fable-5",
      backgroundCreativeTaggingModel: "claude-haiku-4-5",
      taggingUsesBatchApi: true,
      effort: "high",
    },
  };
}

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

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

async function seedAdVolume(
  db: Firestore,
  accountId: string,
  adId: string,
  adsetId: string,
  campaignId: string,
  days: number,
  totalPurchases: number,
  totalSpendMinorUnits: number,
  totalPurchaseValueMinorUnits: number,
): Promise<void> {
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
      accountId,
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      nativeDate: day,
      nativeTimezone: "Asia/Kolkata",
      attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
      spend: money(Math.max(0, bucket(totalSpendMinorUnits, i))),
      purchaseValue: money(Math.max(0, bucket(totalPurchaseValueMinorUnits, i))),
      impressions: totalSpendMinorUnits > 0 ? 500 : 0,
      reach: totalSpendMinorUnits > 0 ? 400 : 0,
      frequency: totalSpendMinorUnits > 0 ? 1.25 : 0,
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

async function seedCoverage(
  db: Firestore,
  accountId: string,
  fromDay: ReportingDay,
  toDay: ReportingDay,
): Promise<void> {
  const repo = createRepository<ShopifyDailyCoverage>(
    db,
    COLLECTIONS.shopifyDailyCoverage,
    shopifyDailyCoverageSchema,
  );
  for (let day = fromDay; day <= toDay; day = addCalendarDays(day, 1) as ReportingDay) {
    const row: ShopifyDailyCoverage = {
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      accountId,
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

async function seedEntities(db: Firestore, accountId: string): Promise<void> {
  const campaigns = createRepository<MetaCampaign>(
    db,
    COLLECTIONS.metaCampaigns,
    metaCampaignSchema,
  );
  const adsets = createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
  const ads = createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema);
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const syncedAt = new Date("2026-08-30T00:00:00Z");

  const campaign1: MetaCampaign = {
    campaignId: "cmp_1",
    accountId,
    name: "Demo — Bridal Sets Prospecting",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    budget: null,
    bidStrategy: null,
    createdAt,
    metaUpdatedAt: createdAt,
    syncedAt,
  };
  await campaigns.set(campaign1.campaignId, campaign1);

  // cmp_orphan: no budget of its own, no ad sets at all -> B2's real "UNKNOWN ownership" case,
  // and D1's own NO_DECISION_UNIT outcome for a campaign-level question about it.
  const campaignOrphan: MetaCampaign = {
    ...campaign1,
    campaignId: "cmp_orphan",
    name: "Demo — Orphaned campaign (no ad sets left)",
    status: "PAUSED",
  };
  await campaigns.set(campaignOrphan.campaignId, campaignOrphan);

  const adsetSpecs: { id: string; name: string; dailyBudget: number }[] = [
    { id: "AS_17", name: "Demo — Bridal broad", dailyBudget: 50000 },
    { id: "AS_dead", name: "Demo — Paused, not delivering", dailyBudget: 30000 },
    { id: "AS_faildemo", name: "Demo — triggers a scripted FAILED run", dailyBudget: 60000 },
    { id: "AS_overlimit", name: "Demo — triggers a real guardrail REJECTED", dailyBudget: 40000 },
  ];
  for (const spec of adsetSpecs) {
    const adset: MetaAdset = {
      adsetId: spec.id,
      campaignId: "cmp_1",
      accountId,
      name: spec.name,
      status: "ACTIVE",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: spec.dailyBudget,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      targeting: null,
      placements: null,
      attribution: null,
      createdAt,
      metaUpdatedAt: createdAt,
      syncedAt,
    };
    await adsets.set(adset.adsetId, adset);
  }

  // A pool of ads under AS_17 so its own primary-window purchase count clears C3's 28d floor
  // (30 — see C3's notes), plus one deliberately low-volume ad (ad_lowvol) that escalates.
  const poolAdIds = Array.from({ length: 9 }, (_, i) => `ad_pool_${i}`);
  for (const adId of poolAdIds) {
    const ad: MetaAd = {
      adId,
      adsetId: "AS_17",
      campaignId: "cmp_1",
      accountId,
      creativeId: null,
      name: `Demo ad ${adId}`,
      status: "ACTIVE",
      destinationUrl: null,
      createdAt,
      metaUpdatedAt: createdAt,
      syncedAt,
    };
    await ads.set(adId, ad);
    await seedAdVolume(db, accountId, adId, "AS_17", "cmp_1", 28, 30, 5_283_000, 20_000_000);
  }

  const lowVolAd: MetaAd = {
    adId: "ad_lowvol",
    adsetId: "AS_17",
    campaignId: "cmp_1",
    accountId,
    creativeId: null,
    name: "Demo — low volume, escalates to AS_17",
    status: "ACTIVE",
    destinationUrl: null,
    createdAt,
    metaUpdatedAt: createdAt,
    syncedAt,
  };
  await ads.set(lowVolAd.adId, lowVolAd);
  await seedAdVolume(db, accountId, "ad_lowvol", "AS_17", "cmp_1", 28, 3, 400_000, 900_000);

  // AS_dead: an ad with zero spend/impressions for the whole window.
  const deadAd: MetaAd = {
    adId: "ad_dead",
    adsetId: "AS_dead",
    campaignId: "cmp_1",
    accountId,
    creativeId: null,
    name: "Demo — paused ad, zero delivery",
    status: "PAUSED",
    destinationUrl: null,
    createdAt,
    metaUpdatedAt: createdAt,
    syncedAt,
  };
  await ads.set(deadAd.adId, deadAd);
  await seedAdVolume(db, accountId, "ad_dead", "AS_dead", "cmp_1", 28, 0, 0, 0);

  // AS_faildemo / AS_overlimit: healthy volume, same shape as AS_17's pool.
  for (const adsetId of ["AS_faildemo", "AS_overlimit"]) {
    for (let i = 0; i < 9; i++) {
      const adId = `ad_${adsetId}_${i}`;
      const ad: MetaAd = {
        adId,
        adsetId,
        campaignId: "cmp_1",
        accountId,
        creativeId: null,
        name: `Demo ad ${adId}`,
        status: "ACTIVE",
        destinationUrl: null,
        createdAt,
        metaUpdatedAt: createdAt,
        syncedAt,
      };
      await ads.set(adId, ad);
      await seedAdVolume(db, accountId, adId, adsetId, "cmp_1", 28, 30, 5_283_000, 20_000_000);
    }
  }
}

async function runFullPipeline(db: Firestore): Promise<void> {
  const syncStore = createFirestoreSyncStore(db);
  const registry = createTaskRegistry();
  registry.register(recomputeFeaturesRegistration);
  registry.register(computeStatisticsRegistration);
  registry.register(enrichChangeFeaturesRegistration);

  for (const taskType of ["RECOMPUTE_FEATURES", "COMPUTE_STATISTICS", "ENRICH_CHANGE_FEATURES"]) {
    const result = await runSyncTask({
      syncStore,
      registry,
      taskType,
      payload: { asOfDay: AS_OF_DAY },
      archiver: dummyArchiver,
    });
    if (result.status !== "SUCCEEDED") {
      throw new Error(
        `demoFixtures: ${taskType} did not succeed: ${result.error ?? "unknown error"}`,
      );
    }
  }
}

/** Seeds `settings/{accountId}` + the full synthetic account + runs the real C2/C3/C4 pipeline
 * over it, so every `DEMO_ENTITIES` scenario is backed by genuinely-computed features/statistics,
 * not hand-built evidence objects. */
export async function seedDemoAccount(db: Firestore, accountId: string): Promise<void> {
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(accountId, demoCanon(accountId));
  await seedEntities(db, accountId);
  await seedCoverage(db, accountId, addCalendarDays(AS_OF_DAY, -60) as ReportingDay, AS_OF_DAY);
  await runFullPipeline(db);
}
