// E2's own "Done when" bar, proven end to end against a real Firestore emulator and the REAL,
// unmodified EVALUATE_RECOMMENDATION_OUTCOME task (recommendationOutcomeTask.ts), run via B1's own
// `runSyncTask`/`createDefaultRegistry()` — not calling `computeRecommendationOutcome` directly
// (outcomeEvaluation.test.ts already covers that at the pure-function level).
//
// Three scenarios:
//   1. A recommendation with UNMET recheck conditions is NOT evaluated at all — no
//      recommendationOutcomes/{id} document is ever written, proven by its literal absence.
//   2. A recommendation whose recheck conditions ARE met is evaluated against its decision
//      packet's SHRUNK baseline — proven by seeding a packet whose raw-looking `metaRoas.value`
//      differs materially from its `metaRoasShrunk`, and asserting the stored outcome's
//      `baselineShrunk` matches the SHRUNK figure exactly. Re-running the task is a no-op
//      (idempotent — the doc already exists).
//   3. A recommendation whose evaluation window overlaps a seeded seasonal calendar window that
//      its baseline does NOT is flagged SEASONALLY_CONFOUNDED, not silently scored SUCCESS/FAILURE
//      — the raw (unflagged) read is still stored, visibly, as `rawClassification`.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  addCalendarDays,
  canonSettingsSchema,
  resetReportingCanonCacheForTests,
} from "@shared/canon/index.ts";
import {
  decisionPacketSchema,
  metaInsightsDailyNormalizedSchema,
  recommendationOutcomeSchema,
  recommendationSchema,
  seasonalCalendarWindowSchema,
  type DecisionPacket,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type Recommendation,
  type RecommendationOutcome,
  type ReportingDay,
  type SeasonalCalendarWindow,
} from "@shared/schema/index.ts";
import { seasonalCalendarWindowKey } from "@shared/firestore/collections.ts";
import { TEST_CANON } from "../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../services/ingest/sync/archiver.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "recommendationOutcomeTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

const ALL_COLLECTIONS = [
  COLLECTIONS.settings,
  COLLECTIONS.syncState,
  COLLECTIONS.syncRuns,
  COLLECTIONS.metaInsightsDailyNormalized,
  COLLECTIONS.decisionPackets,
  COLLECTIONS.recommendations,
  COLLECTIONS.recommendationOutcomes,
  COLLECTIONS.seasonalCalendarWindows,
];

async function cleanupCollections() {
  for (const name of ALL_COLLECTIONS) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

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

async function seedMetaRow(
  adsetId: string,
  day: ReportingDay,
  spendMinorUnits: number,
  purchases: number,
  purchaseValueMinorUnits: number,
) {
  const repo = createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  );
  const row: MetaInsightsDailyNormalized = {
    adId: `${adsetId}_ad1`,
    adsetId,
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    reportingDay: day,
    reportingTimezone: "Asia/Kolkata",
    nativeDate: day,
    nativeTimezone: "Asia/Kolkata",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    spend: money(spendMinorUnits),
    purchaseValue: money(purchaseValueMinorUnits),
    impressions: 500,
    reach: 400,
    frequency: 1.25,
    clicks: 25,
    landingPageViews: 20,
    addToCart: 3,
    initiateCheckout: 1,
    purchases,
    sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    computedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await repo.set(`${row.adId}_${day}`, row);
}

async function seedPacket(
  packetId: string,
  adsetId: string,
  primaryWindow: "28d",
  rawMetaRoas: number,
  shrunkMetaRoas: number,
  createdAt: Date,
) {
  const repo = createRepository<DecisionPacket>(
    db,
    COLLECTIONS.decisionPackets,
    decisionPacketSchema,
  );
  const packet: DecisionPacket = {
    packetId,
    outcome: "EVIDENCE",
    namedEntity: { type: "ADSET", id: adsetId },
    decisionUnit: { type: "ADSET", id: adsetId },
    escalatedFrom: null,
    accountDataVersion: 1,
    isStale: false,
    // Mirrors D1's real ScalingEvidence shape closely enough to prove the read path: a raw-looking
    // metaRoas.value materially different from metaRoasShrunk. If the comparison ever accidentally
    // read the raw figure instead of the shrunk one, these tests would catch it directly.
    evidence: {
      primaryWindow,
      evidence: {
        windows: {
          [primaryWindow]: {
            metaRoas: {
              value: rawMetaRoas,
              interval: [rawMetaRoas - 1, rawMetaRoas + 1],
              purchases: 270,
            },
            metaRoasShrunk: shrunkMetaRoas,
          },
        },
      },
    },
    textRendering: "…",
    createdAt,
  };
  await repo.set(packetId, packet);
}

async function seedRecommendation(
  recommendationId: string,
  packetId: string,
  adsetId: string,
  acceptedAt: Date,
  minimumAdditionalSpendMinorUnits: number,
  minimumAdditionalPurchases: number,
) {
  const repo = createRepository<Recommendation>(
    db,
    COLLECTIONS.recommendations,
    recommendationSchema,
  );
  const rec: Recommendation = {
    recommendationId,
    status: "COMPLETE",
    packetId,
    namedEntity: { type: "ADSET", id: adsetId },
    decisionUnit: { type: "ADSET", id: adsetId },
    recommendation: "INCREASE_BUDGET",
    currentBudgetMinorUnits: 1_000_000,
    recommendedBudgetMinorUnits: 1_150_000,
    changePercent: 15,
    confidence: 0.72,
    summary: "Increase the budget by 15%.",
    primaryReasons: ["above target"],
    risks: [],
    doNotDo: [],
    recheckConditions: { minimumAdditionalSpendMinorUnits, minimumAdditionalPurchases },
    guardrailRejection: null,
    accountDataVersionAtGeneration: 1,
    requestedBy: "rajendrahn38@gmail.com",
    requestedQuestion: `Should I increase the budget of ${adsetId}?`,
    errorMessage: null,
    provenance: null,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    acceptedAt,
    rejectedByUserAt: null,
  };
  await repo.set(recommendationId, rec);
}

async function seedCalendarWindow(label: string, startDay: ReportingDay, endDay: ReportingDay) {
  const repo = createRepository<SeasonalCalendarWindow>(
    db,
    COLLECTIONS.seasonalCalendarWindows,
    seasonalCalendarWindowSchema,
  );
  const row: SeasonalCalendarWindow = {
    label,
    startDay,
    endDay,
    year: 2026,
    confidence: "confirmed",
    source: "test fixture",
    notes: null,
    sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    computedAt: new Date("2026-01-01T00:00:00Z"),
  };
  await repo.set(seasonalCalendarWindowKey(label, startDay), row);
}

async function runEvaluateTask(asOfDay: ReportingDay) {
  const syncStore = createFirestoreSyncStore(db);
  const registry = createDefaultRegistry();
  return runSyncTask({
    syncStore,
    registry,
    taskType: "EVALUATE_RECOMMENDATION_OUTCOME",
    payload: { asOfDay },
    archiver: dummyArchiver,
  });
}

const outcomesRepo = () =>
  createRepository<RecommendationOutcome>(
    db,
    COLLECTIONS.recommendationOutcomes,
    recommendationOutcomeSchema,
  );

describe("EVALUATE_RECOMMENDATION_OUTCOME — E2's own Done-when bar", () => {
  it("1) unmet recheck conditions: the recommendation is NOT evaluated at all — no outcome doc exists", async () => {
    const acceptedAt = new Date("2026-06-01T10:00:00Z"); // reporting day 2026-06-01 IST
    await seedPacket(
      "ADSET_as_unmet",
      "as_unmet",
      "28d",
      8.0,
      3.5,
      new Date("2026-05-31T20:00:00Z"),
    );
    await seedRecommendation(
      "rec_unmet",
      "ADSET_as_unmet",
      "as_unmet",
      acceptedAt,
      1_500_000, // needs 15,00,000 additional spend
      50, // needs 50 additional purchases
    );
    // Only 3 tiny days of post-acceptance delivery — nowhere near either threshold.
    await seedMetaRow("as_unmet", "2026-06-02" as ReportingDay, 20_000, 1, 80_000);
    await seedMetaRow("as_unmet", "2026-06-03" as ReportingDay, 20_000, 1, 80_000);
    await seedMetaRow("as_unmet", "2026-06-04" as ReportingDay, 20_000, 1, 80_000);

    const result = await runEvaluateTask("2026-06-04" as ReportingDay);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary?.evaluated).toBe(0);
    expect(result.summary?.notYetEligible).toBe(1);

    const stored = await outcomesRepo().get("rec_unmet");
    expect(stored).toBeNull(); // <-- the actual proof: no document was ever written
  });

  it("2) met recheck conditions: evaluated against the SHRUNK baseline (never the raw metaRoas value) — and re-running is idempotent", async () => {
    const acceptedAt = new Date("2026-06-01T10:00:00Z");
    // Raw metaRoas.value on the packet is 8.0; metaRoasShrunk is 3.5 — deliberately far apart so
    // a comparison against the wrong one would be unmistakable.
    await seedPacket("ADSET_as_met", "as_met", "28d", 8.0, 3.5, new Date("2026-05-31T20:00:00Z"));
    await seedRecommendation("rec_met", "ADSET_as_met", "as_met", acceptedAt, 1_000_000, 50);

    // 60 days at (100,000 spend / 1 purchase / 500,000 purchase value) each, starting the day
    // after acceptance — crosses both thresholds on day 50 (spend threshold clears on day 10,
    // purchase threshold on day 50, so day 50 is the binding constraint).
    let day: ReportingDay = "2026-06-02" as ReportingDay;
    const days: ReportingDay[] = [];
    for (let i = 0; i < 60; i++) {
      days.push(day);
      day = addCalendarDays(day, 1);
    }
    for (const d of days) {
      await seedMetaRow("as_met", d, 100_000, 1, 500_000);
    }
    const asOfDay = days[days.length - 1];

    const result = await runEvaluateTask(asOfDay);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary?.evaluated).toBe(1);

    const stored = await outcomesRepo().get("rec_met");
    if (stored === null) throw new Error("expected an outcome document to have been written");
    expect(stored.triggeredBy).toBe("RECHECK_CONDITIONS_MET");
    expect(stored.baselineShrunk).toBe(3.5); // the SHRUNK figure — not 8.0, the raw one
    expect(stored.additionalSpendMinorUnits).toBeGreaterThanOrEqual(1_000_000);
    expect(stored.additionalPurchases).toBeGreaterThanOrEqual(50);
    expect(stored.roasAfter).toBeCloseTo(5.0, 5);
    expect(stored.classification).toBe("SUCCESS");
    expect(stored.rawClassification).toBe("SUCCESS");
    expect(stored.primaryWindow).toBe("28d");
    expect(stored.decisionUnit).toEqual({ type: "ADSET", id: "as_met" });
    // The evaluation window stopped at the crossing day, not the full 60-day range seeded.
    expect(stored.evaluationWindow?.endDay).not.toBe(asOfDay);

    // Re-running the task is a no-op: the recommendation is already evaluated, so it is excluded
    // from the candidate set before any work happens on it (idempotency, §10.2).
    const second = await runEvaluateTask(asOfDay);
    expect(second.status).toBe("SUCCEEDED");
    expect(second.summary?.evaluated).toBe(0);
    expect(second.summary?.candidatesConsidered).toBe(0);
  });

  it("3) evaluation window straddling a seasonal boundary is flagged SEASONALLY_CONFOUNDED, not silently scored", async () => {
    const acceptedAt = new Date("2026-09-15T10:00:00Z"); // reporting day 2026-09-15 IST
    // Packet generated 2026-09-14 IST -> asOfDay 2026-09-13 -> 28d baseline window
    // [2026-08-17, 2026-09-13], entirely off-season (no calendar window seeded there).
    await seedPacket(
      "ADSET_as_season",
      "as_season",
      "28d",
      8.0,
      3.5,
      new Date("2026-09-13T20:00:00Z"),
    );
    await seedRecommendation(
      "rec_season",
      "ADSET_as_season",
      "as_season",
      acceptedAt,
      1_000_000,
      50,
    );

    // A festive window that overlaps the POST-acceptance evaluation period but not the baseline.
    await seedCalendarWindow("diwali", "2026-10-15" as ReportingDay, "2026-10-20" as ReportingDay);

    let day: ReportingDay = "2026-09-16" as ReportingDay;
    const days: ReportingDay[] = [];
    for (let i = 0; i < 60; i++) {
      days.push(day);
      day = addCalendarDays(day, 1);
    }
    for (const d of days) {
      await seedMetaRow("as_season", d, 100_000, 1, 500_000); // roas 5.0 -> would be SUCCESS unflagged
    }
    const asOfDay = days[days.length - 1];

    const result = await runEvaluateTask(asOfDay);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary?.evaluated).toBe(1);

    const stored = await outcomesRepo().get("rec_season");
    if (stored === null) throw new Error("expected an outcome document to have been written");
    expect(stored.rawClassification).toBe("SUCCESS"); // the unflagged read — never discarded
    expect(stored.classification).toBe("SEASONALLY_CONFOUNDED"); // the flagged, final answer
    expect(stored.seasonalContext?.spansSeasonalBoundary).toBe(true);
    expect(stored.seasonalContext?.evaluationWindowLabels).toContain("diwali");
    expect(stored.seasonalContext?.baselineWindowLabels).toEqual([]);
    expect(stored.roasAfter).toBeCloseTo(5.0, 5); // the number itself is still carried, not suppressed
  });

  it("EVALUATE_RECOMMENDATION_OUTCOME is registered and runnable as a real task", async () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toContain("EVALUATE_RECOMMENDATION_OUTCOME");
    const result = await runEvaluateTask("2026-08-30" as ReportingDay);
    expect(result.status).toBe("SUCCEEDED");
  });
});
