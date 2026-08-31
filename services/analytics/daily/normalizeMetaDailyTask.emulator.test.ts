// Emulator-backed proof of NORMALIZE_META_INSIGHTS_DAILY: reads real metaInsightsDaily rows,
// writes metaInsightsDailyNormalized through the real A2 version guard, wired through the real
// task framework (runSyncTask + createDefaultRegistry — the same path B2/B3/B5's own emulator
// tests exercise), against a real Firestore emulator. No live Meta call anywhere in this file.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import {
  COLLECTIONS,
  createRepository,
  metaInsightsDailyKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  metaInsightsDailyNormalizedSchema,
  metaInsightsDailySchema,
  type MetaInsightsDaily,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../../services/ingest/sync/archiver.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "normalizeMetaDailyTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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
    COLLECTIONS.metaInsightsDaily,
    COLLECTIONS.metaInsightsDailyNormalized,
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

function row(overrides: Partial<MetaInsightsDaily> = {}): MetaInsightsDaily {
  return {
    adId: "ad_1",
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: TEST_CANON.accountId,
    date: "2026-08-25",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    spendMinorUnits: 102067,
    currency: "INR",
    impressions: 2330,
    reach: 1900,
    frequency: 1.22,
    clicks: 151,
    landingPageViews: 120,
    addToCart: 12,
    initiateCheckout: 1,
    purchases: 2,
    purchaseValueMinorUnits: 500000,
    sourceUpdatedAt: new Date("2026-08-26T02:00:00Z"),
    fetchedAt: new Date("2026-08-26T02:00:00Z"),
    ...overrides,
  };
}

async function seedRow(r: MetaInsightsDaily) {
  await upsertWithVersionGuard({
    db,
    collectionName: COLLECTIONS.metaInsightsDaily,
    docId: metaInsightsDailyKey(r.adId, r.date),
    incoming: r,
    schema: metaInsightsDailySchema,
  });
}

describe("NORMALIZE_META_INSIGHTS_DAILY (emulator)", () => {
  it("normalizes a real-shaped row, stamping reportingDay/timezone/attribution and running through syncRuns as an internal task", async () => {
    await seedRow(row());
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_META_INSIGHTS_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(result.status).toBe("SUCCEEDED");
    const run = await syncStore.getSyncRun(result.runId);
    expect(run?.source).toBe("internal");
    // No watermark for this task type (syncStateTarget: null) — nothing was written to syncState.
    expect((await db.collection(COLLECTIONS.syncState).listDocuments()).length).toBe(0);

    const doc = await db
      .collection(COLLECTIONS.metaInsightsDailyNormalized)
      .doc("ad_1_2026-08-25")
      .get();
    expect(doc.exists).toBe(true);
    const data = doc.data();
    expect(data?.reportingDay).toBe("2026-08-25");
    expect(data?.reportingTimezone).toBe("Asia/Kolkata");
    expect(data?.attribution).toEqual({
      attributionWindow: "7d_click_1d_view",
      purchaseActionType: "omni_purchase",
    });
    expect(data?.spend).toMatchObject({ amountMinorUnits: 102067, currency: "INR" });
  });

  it("re-running over unchanged source data is idempotent — no duplicate doc, equal-version write accepted", async () => {
    await seedRow(row());
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_META_INSIGHTS_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });
    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_META_INSIGHTS_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(second.status).toBe("SUCCEEDED");
    const snap = await db.collection(COLLECTIONS.metaInsightsDailyNormalized).get();
    expect(snap.size).toBe(1);
  });

  it("a version-guard rejection is logged when a normalization run reads an OLDER source snapshot than what's already normalized", async () => {
    // Simulate this by writing the normalized doc directly with a newer sourceUpdatedAt than
    // the metaInsightsDaily row the task will read.
    const older = row({ sourceUpdatedAt: new Date("2020-01-01T00:00:00Z") });
    await seedRow(older);

    await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.metaInsightsDailyNormalized,
      docId: "ad_1_2026-08-25",
      incoming: {
        adId: "ad_1",
        adsetId: "as_1",
        campaignId: "cmp_1",
        accountId: TEST_CANON.accountId,
        reportingDay: "2026-08-25",
        reportingTimezone: "Asia/Kolkata",
        nativeDate: "2026-08-25",
        nativeTimezone: "Asia/Kolkata",
        attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
        spend: {
          amountMinorUnits: 1,
          currency: "INR",
          sourceAmountMinorUnits: 1,
          sourceCurrency: "INR",
          fxRateToReportingCurrency: 1,
          fxRateSource: "same_currency_no_conversion",
        },
        purchaseValue: {
          amountMinorUnits: 1,
          currency: "INR",
          sourceAmountMinorUnits: 1,
          sourceCurrency: "INR",
          fxRateToReportingCurrency: 1,
          fxRateSource: "same_currency_no_conversion",
        },
        impressions: 1,
        reach: null,
        frequency: null,
        clicks: 1,
        landingPageViews: 0,
        addToCart: 0,
        initiateCheckout: 0,
        purchases: 0,
        sourceUpdatedAt: new Date("2099-01-01T00:00:00Z"), // deliberately newer than `older`
        computedAt: new Date(),
      },
      schema: metaInsightsDailyNormalizedSchema,
    });

    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();
    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "NORMALIZE_META_INSIGHTS_DAILY",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(result.status).toBe("SUCCEEDED");
    const run = await syncStore.getSyncRun(result.runId);
    expect(run?.versionGuardRejections?.length).toBe(1);
    expect(run?.versionGuardRejections?.[0]?.collection).toBe(
      COLLECTIONS.metaInsightsDailyNormalized,
    );

    // The stale-relative-to-what-was-already-there write was rejected, so the pre-existing
    // (newer) normalized doc is untouched.
    const doc = await db
      .collection(COLLECTIONS.metaInsightsDailyNormalized)
      .doc("ad_1_2026-08-25")
      .get();
    expect(doc.data()?.impressions).toBe(1); // still the pre-seeded value, not the row's 2330
  });
});
