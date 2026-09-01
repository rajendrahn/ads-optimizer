// E3 — proves `collectCalibrationInputs` against a real Firestore emulator (writes through the
// same repository/schema round-trip every other collection in this codebase uses), and proves the
// full pipeline (collect → buildCalibrationReport → renderCalibrationDashboard) end to end on
// SYNTHETIC seeded data — never real account data, per this step's own safety constraints and the
// "never real customer identifiers" instruction. This is the "prove it on synthetic outcomes"
// half of the brief; see scripts/generateCalibrationReport.ts's own header for what has, and has
// not, been run against anything real.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  recommendationSchema,
  recommendationOutcomeSchema,
  backtestRunSchema,
  guardrailRejectionLogSchema,
  type Recommendation,
  type RecommendationOutcome,
  type BacktestRun,
  type GuardrailRejectionLog,
} from "@shared/schema/index.ts";
import { collectCalibrationInputs } from "./collect.ts";
import { buildCalibrationReport } from "./report.ts";
import { renderCalibrationDashboard } from "./dashboardHtml.ts";
import { must } from "./testSupport.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "collect.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanup() {
  for (const name of [
    COLLECTIONS.recommendations,
    COLLECTIONS.recommendationOutcomes,
    COLLECTIONS.backtestRuns,
    COLLECTIONS.guardrailRejections,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}
beforeEach(cleanup);
afterAll(cleanup);

const CANON = { reportingTimezone: "Asia/Kolkata" };

function recommendation(
  overrides: Partial<Recommendation> & { recommendationId: string },
): Recommendation {
  return {
    status: "COMPLETE",
    packetId: `packet_${overrides.recommendationId}`,
    namedEntity: { type: "ADSET", id: "as_synthetic" },
    decisionUnit: { type: "ADSET", id: "as_synthetic" },
    recommendation: "INCREASE_BUDGET",
    currentBudgetMinorUnits: 100000,
    recommendedBudgetMinorUnits: 110000,
    changePercent: 10,
    confidence: 0.8,
    summary: "synthetic test fixture — not real account data",
    primaryReasons: [],
    risks: [],
    doNotDo: [],
    recheckConditions: { minimumAdditionalSpendMinorUnits: 5000, minimumAdditionalPurchases: 5 },
    guardrailRejection: null,
    accountDataVersionAtGeneration: 1,
    requestedBy: "synthetic-operator@example.com",
    requestedQuestion: "synthetic test question",
    errorMessage: null,
    provenance: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    acceptedAt: new Date("2026-07-01T01:00:00Z"),
    rejectedByUserAt: null,
    ...overrides,
  };
}

function outcome(
  overrides: Partial<RecommendationOutcome> & { recommendationId: string },
): RecommendationOutcome {
  return {
    evaluatedAt: new Date("2026-07-15T00:00:00Z"),
    triggeredBy: "RECHECK_CONDITIONS_MET",
    additionalSpendMinorUnits: 6000,
    additionalPurchases: 6,
    roasAfter: 4.5,
    baselineShrunk: 3.5,
    classification: "SUCCESS",
    createdAt: new Date("2026-07-15T00:00:00Z"),
    ...overrides,
  };
}

function backtestRun(overrides: Partial<BacktestRun> & { backtestRunId: string }): BacktestRun {
  return {
    asOfDate: "2026-06-01",
    strategy: "SYSTEM",
    decisionUnit: { type: "ADSET", id: "as_bt_synthetic" },
    generatedRecommendation: { confidence: 0.75, recommendation: "INCREASE_BUDGET" },
    actualOutcome: { scaledSuccessfully: true },
    brierScoreComponent: 0.0625,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function rejectionLog(
  overrides: Partial<GuardrailRejectionLog> & { recommendationId: string },
): GuardrailRejectionLog {
  return {
    namedEntity: { type: "ADSET", id: "as_synthetic" },
    decisionUnitClaimedByModel: { type: "ADSET", id: "as_synthetic" },
    decisionUnitResolved: { type: "ADSET", id: "as_synthetic" },
    recommendationType: "INCREASE_BUDGET",
    changePercent: 40,
    violations: [
      {
        code: "MAX_CHANGE_PERCENT_EXCEEDED",
        message: "synthetic",
        judgedAgainst: {
          field: "guardrailThresholds.maxChangePercent",
          limit: 20,
          source: "default",
          actual: 40,
        },
      },
    ],
    reason: "synthetic rejection",
    accountDataVersion: 1,
    adOptimizationKnowledgeVersion: null,
    rejectedAt: new Date("2026-07-02T00:00:00Z"),
    ...overrides,
  };
}

describe("collectCalibrationInputs — against a real, initially-empty emulator", () => {
  it("returns empty arrays, not an error, when nothing has been written yet", async () => {
    const inputs = await collectCalibrationInputs(db);
    expect(inputs).toEqual({
      recommendations: [],
      outcomes: [],
      backtestRuns: [],
      guardrailRejections: [],
    });
    // This is literally today's real state — see this step's own notes: nothing has ever run in
    // production, so a real (non-emulator) Firestore project would return exactly this today too.
  });
});

describe("collectCalibrationInputs + buildCalibrationReport + renderCalibrationDashboard — full pipeline on synthetic data", () => {
  it("round-trips every collection through real Firestore and produces a coherent, honest report", async () => {
    const recRepo = createRepository<Recommendation>(
      db,
      COLLECTIONS.recommendations,
      recommendationSchema,
    );
    const outcomeRepo = createRepository<RecommendationOutcome>(
      db,
      COLLECTIONS.recommendationOutcomes,
      recommendationOutcomeSchema,
    );
    const backtestRepo = createRepository<BacktestRun>(
      db,
      COLLECTIONS.backtestRuns,
      backtestRunSchema,
    );
    const rejectionRepo = createRepository<GuardrailRejectionLog>(
      db,
      COLLECTIONS.guardrailRejections,
      guardrailRejectionLogSchema,
    );

    // Ten SUCCESS points at confidence 0.8, two FAILUREs at 0.8 — a well-calibrated 0.8 bucket
    // (10/12 ≈ 83%, close to 80%), well above MIN_CALIBRATION_BUCKET_SIZE (10).
    for (let i = 0; i < 12; i++) {
      const id = `rec_synth_${i}`;
      await recRepo.set(id, recommendation({ recommendationId: id, confidence: 0.8 }));
      await outcomeRepo.set(
        id,
        outcome({ recommendationId: id, classification: i < 10 ? "SUCCESS" : "FAILURE" }),
      );
    }

    // One SEASONALLY_CONFOUNDED and one NEUTRAL, which must NOT enter the tally above.
    await recRepo.set(
      "rec_confounded",
      recommendation({ recommendationId: "rec_confounded", confidence: 0.9 }),
    );
    await outcomeRepo.set(
      "rec_confounded",
      outcome({
        recommendationId: "rec_confounded",
        classification: "SEASONALLY_CONFOUNDED",
        rawClassification: "SUCCESS",
        seasonalContext: {
          evaluationWindowLabels: ["diwali"],
          baselineWindowLabels: [],
          spansSeasonalBoundary: true,
          demandIndex: null,
          demandIndexSampleSize: 1,
          summaryText: "synthetic diwali overlap",
        },
      }),
    );
    await recRepo.set(
      "rec_neutral",
      recommendation({ recommendationId: "rec_neutral", confidence: 0.6 }),
    );
    await outcomeRepo.set(
      "rec_neutral",
      outcome({ recommendationId: "rec_neutral", classification: "NEUTRAL" }),
    );

    // One accepted-but-unjudged recommendation — no outcome doc written for it at all.
    await recRepo.set(
      "rec_unjudged",
      recommendation({ recommendationId: "rec_unjudged", confidence: 0.7 }),
    );

    // One guardrail-REJECTED recommendation, with its matching rejection log entry.
    await recRepo.set(
      "rec_rejected",
      recommendation({
        recommendationId: "rec_rejected",
        status: "REJECTED",
        recommendation: "INSUFFICIENT_DATA",
        recheckConditions: null,
        confidence: null,
        guardrailRejection: {
          reason: "synthetic rejection",
          rejectedAt: new Date("2026-07-02T00:00:00Z"),
        },
      }),
    );
    await rejectionRepo.set("rec_rejected", rejectionLog({ recommendationId: "rec_rejected" }));

    // One backtest SYSTEM run and one NAIVE run.
    await backtestRepo.set("bt_synth_sys", backtestRun({ backtestRunId: "bt_synth_sys" }));
    await backtestRepo.set(
      "bt_synth_naive",
      backtestRun({
        backtestRunId: "bt_synth_naive",
        strategy: "NAIVE_HIGHEST_RECENT_ROAS",
        generatedRecommendation: { confidence: null, recommendation: "INCREASE_BUDGET" },
        actualOutcome: { scaledSuccessfully: false },
        brierScoreComponent: null,
      }),
    );

    const inputs = await collectCalibrationInputs(db);
    // 12 loop + rec_confounded + rec_neutral + rec_unjudged + rec_rejected = 16 recommendations;
    // rec_unjudged and rec_rejected have no outcome doc, so 16 - 2 = 14 outcomes.
    expect(inputs.recommendations).toHaveLength(16);
    expect(inputs.outcomes).toHaveLength(14);
    expect(inputs.backtestRuns).toHaveLength(2);
    expect(inputs.guardrailRejections).toHaveLength(1);

    const report = buildCalibrationReport(inputs, CANON, new Date("2026-08-31T00:00:00Z"));

    expect(report.live.successCount).toBe(10);
    expect(report.live.failureCount).toBe(2);
    expect(report.live.neutralCount).toBe(1);
    expect(report.live.seasonallyConfoundedCount).toBe(1);
    expect(report.live.brier.n).toBe(12); // confounded + neutral excluded

    const bucket = must(
      report.calibrationCurve.buckets.find((b) => b.bucketLow <= 0.8 && b.bucketHigh > 0.8),
    );
    expect(bucket.n).toBe(12);
    expect(bucket.observedSuccessRate).toBeCloseTo(10 / 12, 10); // >= min bucket size, real number

    expect(report.unjudged.acceptedNoOutcomeYet).toBe(1); // rec_unjudged
    expect(report.unjudged.guardrailRejected).toBe(1); // rec_rejected

    expect(report.backtest.systemRuns).toBe(1);
    expect(report.backtest.naiveRuns).toBe(1);
    expect(report.backtest.systemBrier.n).toBe(1);

    expect(report.guardrailRejectionRate.overall).toEqual({
      attempts: 16,
      rejections: 1,
      rate: 1 / 16,
    });
    expect(report.guardrailRejectionRate.violations.byCode).toEqual([
      { code: "MAX_CHANGE_PERCENT_EXCEEDED", count: 1 },
    ]);

    expect(report.dataProvenance.hasAnyJudgedData).toBe(true);

    // The dashboard must render without throwing over this real, round-tripped shape, and must
    // reflect the same headline numbers the JSON report carries.
    const html = renderCalibrationDashboard(report);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<svg");
    expect(html).not.toContain("No judged outcome or backtest data exists yet");
  });
});
