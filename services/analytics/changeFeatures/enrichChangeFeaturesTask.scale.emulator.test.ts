// Realistic-scale distribution proof for ENRICH_CHANGE_FEATURES — this step's own explicit
// reporting requirement: "Report what the real distribution actually looks like" (how many ad
// sets are in learning phase; how many change events exist by type), separate from
// enrichChangeFeaturesTask.emulator.test.ts's own small hand-built correctness fixtures.
//
// Entity counts and daily-active-ad density are the account's REAL measured numbers, matching
// C2's own scale test exactly (IMPLEMENTATION_PLAN.md B2/B3, live):
//   - 410 campaigns / 534 ad sets / 1,139 ads
//   - ~47 active ads/day (B3's live density measurement)
// The purchase-per-active-ad rate below (1 purchase per 5 active ad-slots) is copied verbatim
// from C2's own scale test generator (recomputeFeaturesTask.scale.emulator.test.ts) — the same
// synthetic model C2 already used to stand in for a live pull (this session could not re-pull
// 1,139 real ads without risking the account's own throttle, same constraint C2's session hit).
// That generator produces an account-wide weekly purchase volume in the same order of magnitude
// as this account's own REAL, live-measured figure: C2's own live reconciliation call (real,
// non-mutating, account-level Insights API) measured exactly 113 omni_purchase over the real
// 7-day window 2026-08-24..2026-08-30 for this account. See this step's own report for the
// analysis of what that combination (113 real purchases/week, account-wide, spread across 534 ad
// sets) implies for how many ad sets can possibly clear the ~50/week learning-phase threshold.
//
// Change-event volume is seeded at a level consistent with §15.4's own documented real rate for
// this account ("perhaps ten to twenty per year in total, across all shapes of change") — a
// small, deliberately sparse set, not scaled up to "one per ad set" the way purchase rows are.
//
// Data here is SYNTHETIC (generated, not fetched from Meta) — no live/mutating call anywhere in
// this file, matching this step's own constraints.

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
  entityFeaturesSchema,
  metaChangeEventSchema,
  type EntityFeatures,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaChangeEvent,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type ReportingDay,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../../services/ingest/sync/archiver.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "enrichChangeFeaturesTask.scale.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

// Real B2/B3-measured scale — see module comment.
const NUM_CAMPAIGNS = 410;
const NUM_ADSETS = 534;
const NUM_ADS = 1139;
const ACTIVE_ADS_PER_DAY = 47; // B3's live density measurement
const PURCHASE_WINDOW_DAYS = 7; // matches LEARNING_PHASE_WINDOW_DAYS

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
  COLLECTIONS.metaChangeEvents,
  COLLECTIONS.metaInsightsDailyNormalized,
  COLLECTIONS.adFeatures,
  COLLECTIONS.adsetFeatures,
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

/** Bulk-seeds via `BulkWriter` — seeding INPUT fixtures for the timing/distribution run, not the
 * thing being measured (same rationale as C2's own scale test). */
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

function stubFeatures(entityType: EntityFeatures["entityType"], entityId: string): EntityFeatures {
  return {
    entityId,
    entityType,
    accountDataVersion: 1,
    computedAt: new Date("2026-08-29T00:00:00Z"),
    windows: {},
    trend: {},
    changeAware: {},
    learningPhase: {},
  };
}

describe("ENRICH_CHANGE_FEATURES (emulator) — realistic scale and real distribution", () => {
  beforeAll(async () => {
    resetReportingCanonCacheForTests();
    await cleanupCollections();
    await createRepository(db, COLLECTIONS.settings, canonSettingsSchema).set(
      ACCOUNT_ID,
      TEST_CANON,
    );

    // --- Entities: real B2-measured counts. ---
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
          createdAt: new Date("2025-06-01T00:00:00Z"),
          metaUpdatedAt: new Date("2025-06-01T00:00:00Z"),
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
          createdAt: new Date("2025-06-01T00:00:00Z"),
          metaUpdatedAt: new Date("2025-06-01T00:00:00Z"),
          syncedAt: new Date("2026-08-30T00:00:00Z"),
        },
      }),
    );
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
          creativeId: null,
          name: `Ad ${i}`,
          status: "ACTIVE",
          destinationUrl: null,
          createdAt: new Date("2025-06-01T00:00:00Z"),
          metaUpdatedAt: new Date("2025-06-01T00:00:00Z"),
          syncedAt: new Date("2026-08-30T00:00:00Z"),
        },
      };
    });
    await bulkSet(COLLECTIONS.metaCampaigns, campaigns);
    await bulkSet(COLLECTIONS.metaAdsets, adsets);
    await bulkSet(COLLECTIONS.metaAds, ads);

    // --- Pre-existing feature docs for every entity — standing in for a prior RECOMPUTE_FEATURES
    // run, which this task requires (see enrichChangeFeaturesTask.ts's own ordering note). ---
    const adFeatureDocs = ads.map((a) => ({
      id: a.id,
      data: stubFeatures("AD", a.data.adId),
    }));
    const adsetFeatureDocs = adsets.map((a) => ({
      id: a.id,
      data: stubFeatures("ADSET", a.data.adsetId),
    }));
    const campaignFeatureDocs = campaigns.map((c) => ({
      id: c.id,
      data: stubFeatures("CAMPAIGN", c.data.campaignId),
    }));
    await bulkSet(COLLECTIONS.adFeatures, adFeatureDocs);
    await bulkSet(COLLECTIONS.adsetFeatures, [...adsetFeatureDocs, ...campaignFeatureDocs]);

    // --- 7-day lookback: Meta insight rows, ~47 active ads/day (B3's live density), 1-in-5
    // active ad-slots converting — C2's own scale-test generator, copied verbatim (see module
    // comment for why this produces a realistic, not arbitrary, weekly total). ---
    const startDay = addCalendarDays(AS_OF_DAY, -(PURCHASE_WINDOW_DAYS - 1));
    const metaRows: { id: string; data: MetaInsightsDailyNormalized }[] = [];
    let day = startDay;
    let dayIndex = 0;
    let totalPurchasesSeeded = 0;
    while (day <= AS_OF_DAY) {
      for (let k = 0; k < ACTIVE_ADS_PER_DAY; k++) {
        const adIndex = (dayIndex * 97 + k * 131) % NUM_ADS; // deterministic pseudo-random spread
        const ad = at(ads, adIndex).data;
        const purchases = k % 5 === 0 ? 1 : 0;
        totalPurchasesSeeded += purchases;
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
            purchaseValue: money(purchases * 150000),
            impressions: 1000 + k,
            reach: 800 + k,
            frequency: 1.2,
            clicks: 40 + (k % 10),
            landingPageViews: 30 + (k % 8),
            addToCart: 3 + (k % 4),
            initiateCheckout: 1 + (k % 2),
            purchases,
            sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
            computedAt: new Date("2026-08-30T00:00:00Z"),
          },
        });
      }
      day = addCalendarDays(day, 1);
      dayIndex++;
    }
    await bulkSet(COLLECTIONS.metaInsightsDailyNormalized, metaRows);
    console.log(
      `[scale test] total Meta-reported purchases seeded (7d, account-wide): ${totalPurchasesSeeded}`,
    );

    // --- A sparse handful of change events — §15.4's own documented real rate ("perhaps ten to
    // twenty per year in total, across all shapes of change"), not scaled to entity count. Two
    // are material BUDGET edits (>=20%), on two different, otherwise-idle ad sets, so the
    // distribution report can show the reset mechanism firing at scale too. ---
    const changeEvents: { id: string; data: MetaChangeEvent }[] = [
      {
        id: "ADSET_as_10_BUDGET_run2",
        data: {
          entityType: "ADSET",
          entityId: "as_10",
          field: "BUDGET",
          detectedAt: new Date("2026-08-27T10:00:00Z"),
          fromSnapshotKey: "ADSET_as_10_prev",
          toSnapshotKey: "run2",
          before: {
            ownerLevel: "ADSET",
            dailyBudgetMinorUnits: 50000,
            lifetimeBudgetMinorUnits: null,
            currency: "INR",
          },
          after: {
            ownerLevel: "ADSET",
            dailyBudgetMinorUnits: 65000,
            lifetimeBudgetMinorUnits: null,
            currency: "INR",
          },
          budgetChangePercent: 30,
          actor: null,
        },
      },
      {
        id: "ADSET_as_200_BUDGET_run2",
        data: {
          entityType: "ADSET",
          entityId: "as_200",
          field: "BUDGET",
          detectedAt: new Date("2026-08-29T08:00:00Z"),
          fromSnapshotKey: "ADSET_as_200_prev",
          toSnapshotKey: "run2",
          before: {
            ownerLevel: "ADSET",
            dailyBudgetMinorUnits: 100000,
            lifetimeBudgetMinorUnits: null,
            currency: "INR",
          },
          after: {
            ownerLevel: "ADSET",
            dailyBudgetMinorUnits: 40000,
            lifetimeBudgetMinorUnits: null,
            currency: "INR",
          },
          budgetChangePercent: -60,
          actor: null,
        },
      },
      {
        id: "AD_ad_50_STATUS_run2",
        data: {
          entityType: "AD",
          entityId: "ad_50",
          field: "STATUS",
          detectedAt: new Date("2026-08-28T00:00:00Z"),
          fromSnapshotKey: "AD_ad_50_prev",
          toSnapshotKey: "run2",
          before: "PAUSED",
          after: "ACTIVE",
          budgetChangePercent: null,
          actor: null,
        },
      },
      {
        id: "ADSET_as_75_TARGETING_run2",
        data: {
          entityType: "ADSET",
          entityId: "as_75",
          field: "TARGETING",
          detectedAt: new Date("2026-08-20T00:00:00Z"),
          fromSnapshotKey: "ADSET_as_75_prev",
          toSnapshotKey: "run2",
          before: { age_min: 18 },
          after: { age_min: 25 },
          budgetChangePercent: null,
          actor: null,
        },
      },
      {
        id: "AD_ad_900_CREATIVE_ASSIGNMENT_run2",
        data: {
          entityType: "AD",
          entityId: "ad_900",
          field: "CREATIVE_ASSIGNMENT",
          detectedAt: new Date("2026-08-26T00:00:00Z"),
          fromSnapshotKey: "AD_ad_900_prev",
          toSnapshotKey: "run2",
          before: ["cr_old"],
          after: ["cr_new"],
          budgetChangePercent: null,
          actor: null,
        },
      },
      {
        id: "ADSET_as_10_BUDGET_run1",
        data: {
          entityType: "ADSET",
          entityId: "as_10",
          field: "BUDGET",
          detectedAt: new Date("2026-07-15T00:00:00Z"), // an older, sub-7-day-window edit
          fromSnapshotKey: "ADSET_as_10_prev0",
          toSnapshotKey: "ADSET_as_10_prev",
          before: {
            ownerLevel: "ADSET",
            dailyBudgetMinorUnits: 40000,
            lifetimeBudgetMinorUnits: null,
            currency: "INR",
          },
          after: {
            ownerLevel: "ADSET",
            dailyBudgetMinorUnits: 50000,
            lifetimeBudgetMinorUnits: null,
            currency: "INR",
          },
          budgetChangePercent: 25,
          actor: null,
        },
      },
    ];
    await bulkSet(COLLECTIONS.metaChangeEvents, changeEvents);
  }, 120_000);

  afterAll(cleanupCollections);

  it("completes well inside a sync interval and reports the real distribution", async () => {
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();
    const startedAt = Date.now();
    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "ENRICH_CHANGE_FEATURES",
      payload: { asOfDay: AS_OF_DAY, writeConcurrency: 30 },
      archiver: dummyArchiver,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe("SUCCEEDED");
    console.log(`[scale test] ENRICH_CHANGE_FEATURES wall time: ${elapsedMs}ms`, result.summary);
    expect(elapsedMs).toBeLessThan(120_000); // "well inside a sync interval" (§25: hours, not seconds)

    // --- The real distribution: how many ad sets are in learning phase. ---
    const adsetRepo = createRepository<EntityFeatures>(
      db,
      COLLECTIONS.adsetFeatures,
      entityFeaturesSchema,
    );
    let adsetsInLearning = 0;
    let adsetsOutOfLearning = 0;
    let adsetsWithReset = 0;
    const allAdsetDocs = await adsetRepo.query((r) => r);
    // Only ADSET-typed docs carry a learningPhase verdict — CAMPAIGN-typed docs in this same
    // collection deliberately do not (see enrichChangeFeaturesTask.ts's own scoping note).
    const adsetOnlyDocs = allAdsetDocs.filter((d) => d.entityType === "ADSET");
    for (const doc of adsetOnlyDocs) {
      if (doc.learningPhase.inLearningPhase === true) adsetsInLearning++;
      else if (doc.learningPhase.inLearningPhase === false) adsetsOutOfLearning++;
      if (doc.learningPhase.learningResetAt) adsetsWithReset++;
    }

    console.log(
      `[scale test] learning phase: ${adsetsInLearning}/${adsetOnlyDocs.length} ad sets in learning phase, ` +
        `${adsetsOutOfLearning} out, ${adsetsWithReset} with a recorded reset`,
    );
    expect(adsetOnlyDocs.length).toBe(NUM_ADSETS);
    // The account's real measured weekly purchase total (113, via C2's live reconciliation) is
    // far below 50 * 534 — the overwhelming majority of ad sets MUST be in learning phase.
    expect(adsetsInLearning).toBeGreaterThan(NUM_ADSETS * 0.9);

    // --- Change events by type (matched at all, regardless of entity type). ---
    const allChangeEvents = await createRepository<MetaChangeEvent>(
      db,
      COLLECTIONS.metaChangeEvents,
      metaChangeEventSchema,
    ).query((r) => r);
    const byField: Record<string, number> = {};
    for (const e of allChangeEvents) byField[e.field] = (byField[e.field] ?? 0) + 1;
    console.log(`[scale test] change events by field (seeded, whole-account):`, byField);
    expect(allChangeEvents.length).toBe(6);

    // The two material budget edits produced exactly two resets (as_10, as_200).
    const as10 = await adsetRepo.get("as_10");
    const as200 = await adsetRepo.get("as_200");
    expect(as10?.learningPhase.learningResetCause).toBe("MATERIAL_BUDGET_INCREASE:30%");
    expect(as200?.learningPhase.learningResetCause).toBe("MATERIAL_BUDGET_DECREASE:-60%");
  }, 180_000);
});
