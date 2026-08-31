// Emulator-backed proof of ENRICH_CHANGE_FEATURES (§13, §13.1) — real Firestore emulator only,
// never production. Covers this step's own "Done when" bar:
//   - a simulated (material) budget edit produces a learning reset with the correct cause/
//     timestamp
//   - an ad set below the conversion threshold reports inLearningPhase: true
// plus the structural non-collision claim this step's own module comment makes: merging
// changeAware/learningPhase onto a pre-existing feature doc leaves every other top-level field
// (windows, trend, ...) — standing in for what C3 concurrently writes there — untouched, and an
// entity absent from Meta's own fetch (metaAdsets/metaAds/metaCampaigns) is never treated as a
// change (B4's documented gap).

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  entityFeaturesSchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaChangeEventSchema,
  metaInsightsDailyNormalizedSchema,
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
    "enrichChangeFeaturesTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

const ACCOUNT_ID = TEST_CANON.accountId;
const AS_OF_DAY: ReportingDay = "2026-08-30";
const OLD_CREATED_AT = new Date("2025-01-01T00:00:00Z"); // long-lived — never itself a reset floor

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  await createRepository(db, COLLECTIONS.settings, canonSettingsSchema).set(ACCOUNT_ID, TEST_CANON);
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

function stubFeatures(entityType: EntityFeatures["entityType"], entityId: string): EntityFeatures {
  return {
    entityId,
    entityType,
    accountDataVersion: 1,
    computedAt: new Date("2026-08-29T00:00:00Z"),
    // A non-empty windows object — standing in for what C2 (and, concurrently, C3) actually
    // populate — so a "did this survive the merge untouched" assertion means something.
    windows: { "7d": { spendMinorUnits: 999_00, impressions: 4321 } },
    trend: { roasChangePercent: 12.5 },
    changeAware: {},
    learningPhase: {},
  };
}

async function seedAdset(id: string, campaignId: string, createdAt: Date) {
  const adset: MetaAdset = {
    adsetId: id,
    campaignId,
    accountId: ACCOUNT_ID,
    name: `Adset ${id}`,
    status: "ACTIVE",
    budget: null,
    optimizationGoal: null,
    bidStrategy: null,
    targeting: null,
    placements: null,
    attribution: null,
    createdAt,
    metaUpdatedAt: createdAt,
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).set(id, adset);
}

async function seedCampaign(id: string) {
  const campaign: MetaCampaign = {
    campaignId: id,
    accountId: ACCOUNT_ID,
    name: `Campaign ${id}`,
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    budget: null,
    bidStrategy: null,
    createdAt: OLD_CREATED_AT,
    metaUpdatedAt: OLD_CREATED_AT,
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
    id,
    campaign,
  );
}

async function seedBudgetChangeEvent(
  adsetId: string,
  detectedAt: Date,
  percent: number | null,
  toSnapshotKey: string,
) {
  const event: MetaChangeEvent = {
    entityType: "ADSET",
    entityId: adsetId,
    field: "BUDGET",
    detectedAt,
    fromSnapshotKey: `ADSET_${adsetId}_prev`,
    toSnapshotKey,
    before: {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 50000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    after: {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 67500,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    budgetChangePercent: percent,
    actor: null,
  };
  const key = `ADSET_${adsetId}_BUDGET_${toSnapshotKey}`;
  await createRepository<MetaChangeEvent>(
    db,
    COLLECTIONS.metaChangeEvents,
    metaChangeEventSchema,
  ).set(key, event);
}

async function seedPurchaseDay(adsetId: string, day: ReportingDay, purchases: number) {
  const row: MetaInsightsDailyNormalized = {
    adId: `${adsetId}_ad1`,
    adsetId,
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    reportingDay: day,
    reportingTimezone: TEST_CANON.reportingTimezone,
    nativeDate: day,
    nativeTimezone: TEST_CANON.reportingTimezone,
    attribution: {
      attributionWindow: TEST_CANON.attributionWindow,
      purchaseActionType: TEST_CANON.purchaseActionType,
    },
    spend: money(10000),
    purchaseValue: money(purchases * 50000),
    impressions: 1000,
    reach: 800,
    frequency: 1.25,
    clicks: 50,
    landingPageViews: 40,
    addToCart: 10,
    initiateCheckout: 5,
    purchases,
    sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    computedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  ).set(`${adsetId}_ad1_${day}`, row);
}

async function seedFeatureDoc(collectionName: string, id: string, features: EntityFeatures) {
  await createRepository<EntityFeatures>(db, collectionName, entityFeaturesSchema).set(
    id,
    features,
  );
}

async function runEnrich() {
  const syncStore = createFirestoreSyncStore(db);
  const registry = createDefaultRegistry();
  return runSyncTask({
    syncStore,
    registry,
    taskType: "ENRICH_CHANGE_FEATURES",
    payload: { asOfDay: AS_OF_DAY },
    archiver: dummyArchiver,
  });
}

async function readAdsetFeatures(id: string): Promise<EntityFeatures> {
  const doc = await createRepository<EntityFeatures>(
    db,
    COLLECTIONS.adsetFeatures,
    entityFeaturesSchema,
  ).get(id);
  if (!doc) throw new Error(`no adsetFeatures/${id}`);
  return doc;
}

describe("ENRICH_CHANGE_FEATURES (emulator)", () => {
  it("a simulated material budget edit produces a learning reset with the correct cause and timestamp", async () => {
    await seedCampaign("cmp_1");
    await seedAdset("as_reset", "cmp_1", OLD_CREATED_AT);
    await seedFeatureDoc(COLLECTIONS.adsetFeatures, "as_reset", stubFeatures("ADSET", "as_reset"));

    const resetAt = new Date("2026-08-28T09:00:00Z"); // 2 days before AS_OF_DAY
    await seedBudgetChangeEvent("as_reset", resetAt, 35, "run2");

    // Purchases before AND after the reset — only post-reset ones should count toward exit.
    await seedPurchaseDay("as_reset", "2026-08-27" as ReportingDay, 40); // pre-reset, excluded
    await seedPurchaseDay("as_reset", "2026-08-28" as ReportingDay, 5);
    await seedPurchaseDay("as_reset", "2026-08-29" as ReportingDay, 5);
    await seedPurchaseDay("as_reset", "2026-08-30" as ReportingDay, 5); // 15 post-reset total

    const result = await runEnrich();
    expect(result.status).toBe("SUCCEEDED");

    const doc = await readAdsetFeatures("as_reset");
    expect(doc.learningPhase.learningResetAt).toEqual(resetAt);
    expect(doc.learningPhase.learningResetCause).toBe("MATERIAL_BUDGET_INCREASE:35%");
    expect(doc.learningPhase.inLearningPhase).toBe(true); // 15 < 50
    expect(doc.learningPhase.conversionsToExitLearning).toBe(35);
    expect(doc.changeAware.hoursSinceLastBudgetChange).toBeGreaterThan(24);
    expect(doc.changeAware.lastBudgetChangePercent).toBe(35);
    expect(doc.changeAware.budgetChangesLast7Days).toBe(1);
  });

  it("an ad set below the conversion threshold (no reset) reports inLearningPhase: true", async () => {
    await seedCampaign("cmp_1");
    await seedAdset("as_low_volume", "cmp_1", OLD_CREATED_AT);
    await seedFeatureDoc(
      COLLECTIONS.adsetFeatures,
      "as_low_volume",
      stubFeatures("ADSET", "as_low_volume"),
    );
    // ~26/week — the account's own real range (§2.1), well under the 50 threshold.
    const days: [ReportingDay, number][] = [
      ["2026-08-24", 4],
      ["2026-08-25", 3],
      ["2026-08-26", 5],
      ["2026-08-27", 4],
      ["2026-08-28", 3],
      ["2026-08-29", 4],
      ["2026-08-30", 3],
    ];
    for (const [day, purchases] of days) await seedPurchaseDay("as_low_volume", day, purchases);

    const result = await runEnrich();
    expect(result.status).toBe("SUCCEEDED");

    const doc = await readAdsetFeatures("as_low_volume");
    expect(doc.learningPhase.inLearningPhase).toBe(true);
    expect(doc.learningPhase.conversionsToExitLearning).toBe(24);
    expect(doc.learningPhase.learningResetAt).toBeUndefined();
  });

  it("an ad set clearing the threshold reports inLearningPhase: false", async () => {
    await seedCampaign("cmp_1");
    await seedAdset("as_high_volume", "cmp_1", OLD_CREATED_AT);
    await seedFeatureDoc(
      COLLECTIONS.adsetFeatures,
      "as_high_volume",
      stubFeatures("ADSET", "as_high_volume"),
    );
    for (const day of [
      "2026-08-26",
      "2026-08-27",
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ] as const) {
      await seedPurchaseDay("as_high_volume", day as ReportingDay, 12); // 60 total
    }

    await runEnrich();
    const doc = await readAdsetFeatures("as_high_volume");
    expect(doc.learningPhase.inLearningPhase).toBe(false);
    expect(doc.learningPhase.conversionsToExitLearning).toBe(0);
  });

  it("does not touch windows/trend on the doc it merges into (non-collision with C3's fields)", async () => {
    await seedCampaign("cmp_1");
    await seedAdset("as_merge_check", "cmp_1", OLD_CREATED_AT);
    await seedFeatureDoc(
      COLLECTIONS.adsetFeatures,
      "as_merge_check",
      stubFeatures("ADSET", "as_merge_check"),
    );

    await runEnrich();
    const doc = await readAdsetFeatures("as_merge_check");
    // Untouched — proves the write is a targeted top-level merge, not a full overwrite.
    expect(doc.windows["7d"]?.spendMinorUnits).toBe(999_00);
    expect(doc.windows["7d"]?.impressions).toBe(4321);
    expect(doc.trend.roasChangePercent).toBe(12.5);
    expect(doc.accountDataVersion).toBe(1);
    // But changeAware/learningPhase DID get populated (real work happened).
    expect(doc.changeAware.budgetChangesLast7Days).toBe(0);
    expect(doc.learningPhase.inLearningPhase).toBe(true); // zero purchases, never exits
  });

  it("skips (and counts) an entity with no pre-existing feature doc, rather than fabricating a partial one", async () => {
    await seedCampaign("cmp_1");
    // Give the campaign itself a pre-existing doc so it is NOT also counted as a skip — this
    // test isolates the ad's missing doc specifically.
    await seedFeatureDoc(COLLECTIONS.adsetFeatures, "cmp_1", stubFeatures("CAMPAIGN", "cmp_1"));
    const ad: MetaAd = {
      adId: "ad_no_doc",
      adsetId: "as_no_doc_parent",
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      creativeId: null,
      name: "Ad with no feature doc yet",
      status: "ACTIVE",
      destinationUrl: null,
      createdAt: OLD_CREATED_AT,
      metaUpdatedAt: OLD_CREATED_AT,
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema).set(ad.adId, ad);
    // Deliberately NOT seeding adFeatures/ad_no_doc.

    const result = await runEnrich();
    expect(result.status).toBe("SUCCEEDED");
    expect((result.summary as { skippedNoFeatureDoc?: number })?.skippedNoFeatureDoc).toBe(1);

    const doc = await db.collection(COLLECTIONS.adFeatures).doc("ad_no_doc").get();
    expect(doc.exists).toBe(false); // no partial/invalid doc was fabricated
  });

  it("an entity absent from Meta's own fetch entirely is never treated as a change (B4's documented gap)", async () => {
    // Seed a pre-existing feature doc for an adset that is NOT present in metaAdsets at all —
    // simulating B2's fetch returning an entity that has quietly disappeared. Per B4's own
    // documented gap, no "removed" change event exists for this case.
    const before = stubFeatures("ADSET", "as_ghost");
    before.learningPhase = { inLearningPhase: true, conversionsToExitLearning: 50 };
    await seedFeatureDoc(COLLECTIONS.adsetFeatures, "as_ghost", before);
    // Deliberately no seedAdset("as_ghost", ...) call — it never appears in metaAdsets.

    const result = await runEnrich();
    expect(result.status).toBe("SUCCEEDED");

    const doc = await readAdsetFeatures("as_ghost");
    // Completely untouched — this task never iterates an entity it cannot find in metaAdsets/
    // metaAds/metaCampaigns, so absence produces no spurious "change" of any kind.
    expect(doc.learningPhase.inLearningPhase).toBe(true);
    expect(doc.learningPhase.conversionsToExitLearning).toBe(50);
    expect(doc.changeAware).toEqual({});
  });
});
