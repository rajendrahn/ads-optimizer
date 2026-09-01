import { describe, expect, it } from "vitest";
import { buildCalibrationReport } from "./report.ts";
import { MIN_CALIBRATION_BUCKET_SIZE } from "./calibrationCurve.ts";
import type {
  BacktestRun,
  GuardrailRejectionLog,
  Recommendation,
  RecommendationOutcome,
} from "@shared/schema/index.ts";
import type { CalibrationRawInputs } from "./collect.ts";
import { must } from "./testSupport.ts";

const CANON = { reportingTimezone: "Asia/Kolkata" };
const NOW = new Date("2026-08-31T00:00:00Z");

function recommendation(
  overrides: Partial<Recommendation> & { recommendationId: string },
): Recommendation {
  return {
    status: "COMPLETE",
    packetId: `packet_${overrides.recommendationId}`,
    namedEntity: { type: "ADSET", id: "as_1" },
    decisionUnit: { type: "ADSET", id: "as_1" },
    recommendation: "INCREASE_BUDGET",
    currentBudgetMinorUnits: 100000,
    recommendedBudgetMinorUnits: 110000,
    changePercent: 10,
    confidence: 0.8,
    summary: "test",
    primaryReasons: [],
    risks: [],
    doNotDo: [],
    recheckConditions: { minimumAdditionalSpendMinorUnits: 5000, minimumAdditionalPurchases: 5 },
    guardrailRejection: null,
    accountDataVersionAtGeneration: 1,
    requestedBy: "test@example.com",
    requestedQuestion: "how is as_1 doing?",
    errorMessage: null,
    provenance: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    acceptedAt: new Date("2026-08-01T01:00:00Z"),
    rejectedByUserAt: null,
    ...overrides,
  };
}

function outcome(
  overrides: Partial<RecommendationOutcome> & { recommendationId: string },
): RecommendationOutcome {
  return {
    evaluatedAt: new Date("2026-08-10T00:00:00Z"),
    triggeredBy: "RECHECK_CONDITIONS_MET",
    additionalSpendMinorUnits: 6000,
    additionalPurchases: 6,
    roasAfter: 4.5,
    baselineShrunk: 3.5,
    classification: "SUCCESS",
    createdAt: new Date("2026-08-10T00:00:00Z"),
    ...overrides,
  };
}

function backtestRun(overrides: Partial<BacktestRun> & { backtestRunId: string }): BacktestRun {
  return {
    asOfDate: "2026-06-01",
    strategy: "SYSTEM",
    decisionUnit: { type: "ADSET", id: "as_bt" },
    generatedRecommendation: { confidence: 0.8, recommendation: "INCREASE_BUDGET" },
    actualOutcome: { scaledSuccessfully: true },
    brierScoreComponent: 0.04,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function rejectionLog(id: string, rejectedAt: Date): GuardrailRejectionLog {
  return {
    recommendationId: id,
    namedEntity: null,
    decisionUnitClaimedByModel: null,
    decisionUnitResolved: null,
    recommendationType: "INCREASE_BUDGET",
    changePercent: 40,
    violations: [
      {
        code: "MAX_CHANGE_PERCENT_EXCEEDED",
        message: "test",
        judgedAgainst: {
          field: "guardrailThresholds.maxChangePercent",
          limit: 20,
          source: "default",
          actual: 40,
        },
      },
    ],
    reason: "test",
    accountDataVersion: 1,
    adOptimizationKnowledgeVersion: null,
    rejectedAt,
  };
}

const EMPTY: CalibrationRawInputs = {
  recommendations: [],
  outcomes: [],
  backtestRuns: [],
  guardrailRejections: [],
};

describe("buildCalibrationReport — honesty on empty input", () => {
  it("reports n=0/null everywhere and hasAnyJudgedData=false, never a fabricated number", () => {
    const report = buildCalibrationReport(EMPTY, CANON, NOW);
    expect(report.live.brier).toEqual({ n: 0, meanBrier: null });
    expect(report.backtest.systemBrier).toEqual({ n: 0, meanBrier: null });
    expect(report.combinedBrier).toEqual({ n: 0, meanBrier: null });
    expect(report.guardrailRejectionRate.overall).toEqual({
      attempts: 0,
      rejections: 0,
      rate: null,
    });
    expect(report.dataProvenance.hasAnyJudgedData).toBe(false);
    expect(report.dataProvenance.notes.length).toBeGreaterThan(0);
    // Exactly what the real, current state of this system looks like — see IMPLEMENTATION_PLAN.md
    // E3's own notes: nothing has ever run in production, so this is the honest baseline.
  });
});

describe("buildCalibrationReport — which confidence is scored", () => {
  it("scores recommendations.confidence as persisted (D5's adjustedConfidence), not a separate raw field", () => {
    // recommendation.confidence here stands in for whatever was actually persisted — D5's
    // adjustedConfidence for a COMPLETE recommendation, per generateRecommendationTask.ts. This
    // report has no way to distinguish "raw" from "adjusted" because only one is ever stored.
    const inputs: CalibrationRawInputs = {
      recommendations: [recommendation({ recommendationId: "rec_1", confidence: 0.48 })], // e.g. 0.8 * 0.6
      outcomes: [outcome({ recommendationId: "rec_1", classification: "SUCCESS" })],
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.live.brier.n).toBe(1);
    expect(report.live.brier.meanBrier).toBeCloseTo((0.48 - 1) ** 2, 10);
  });
});

describe("buildCalibrationReport — SEASONALLY_CONFOUNDED and NEUTRAL exclusion", () => {
  it("excludes SEASONALLY_CONFOUNDED from every tally and reports its count separately", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [
        recommendation({ recommendationId: "rec_conf" }),
        recommendation({ recommendationId: "rec_ok" }),
      ],
      outcomes: [
        outcome({
          recommendationId: "rec_conf",
          classification: "SEASONALLY_CONFOUNDED",
          rawClassification: "SUCCESS",
        }),
        outcome({ recommendationId: "rec_ok", classification: "SUCCESS" }),
      ],
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.live.seasonallyConfoundedCount).toBe(1);
    expect(report.live.successCount).toBe(1); // only rec_ok
    expect(report.live.brier.n).toBe(1); // the confounded one never enters scoring
  });

  it("excludes NEUTRAL from the binary Brier/calibration tally and reports it separately, never as a failure", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [recommendation({ recommendationId: "rec_neutral", confidence: 0.9 })],
      outcomes: [outcome({ recommendationId: "rec_neutral", classification: "NEUTRAL" })],
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.live.neutralCount).toBe(1);
    expect(report.live.brier.n).toBe(0); // not scored at all — not as a 0, not as a 1
    expect(report.live.brier.meanBrier).toBeNull();
  });
});

describe("buildCalibrationReport — unjudged recommendations are not failures", () => {
  it("counts an accepted recommendation with no outcome doc as unjudged, never as a failure", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [recommendation({ recommendationId: "rec_pending" })], // accepted, recheckConditions set
      outcomes: [], // E2 has not written a doc yet — NOT_YET_ELIGIBLE, per its own module comment
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.unjudged.acceptedNoOutcomeYet).toBe(1);
    expect(report.live.failureCount).toBe(0);
    expect(report.live.successCount).toBe(0);
    expect(report.combinedBrier.n).toBe(0);
  });

  it("counts a COMPLETE-but-never-accepted recommendation separately, not as unjudged", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [recommendation({ recommendationId: "rec_unaccepted", acceptedAt: null })],
      outcomes: [],
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.unjudged.completeNotAccepted).toBe(1);
    expect(report.unjudged.acceptedNoOutcomeYet).toBe(0);
  });

  it("counts a guardrail-REJECTED recommendation in its own bucket", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [
        recommendation({
          recommendationId: "rec_rejected",
          status: "REJECTED",
          recommendation: "INSUFFICIENT_DATA",
          recheckConditions: null,
          confidence: null,
          guardrailRejection: {
            reason: "too aggressive",
            rejectedAt: new Date("2026-08-01T00:00:00Z"),
          },
        }),
      ],
      outcomes: [],
      backtestRuns: [],
      guardrailRejections: [rejectionLog("rec_rejected", new Date("2026-08-01T00:00:00Z"))],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.unjudged.guardrailRejected).toBe(1);
    expect(report.guardrailRejectionRate.overall).toEqual({ attempts: 1, rejections: 1, rate: 1 });
  });
});

describe("buildCalibrationReport — backtest integration", () => {
  it("reads E1's own frozen brierScoreComponent/scaledSuccessfully as-is, never recomputes", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [],
      outcomes: [],
      backtestRuns: [
        backtestRun({ backtestRunId: "bt_sys_1", strategy: "SYSTEM", brierScoreComponent: 0.09 }),
        backtestRun({
          backtestRunId: "bt_naive_1",
          strategy: "NAIVE_HIGHEST_RECENT_ROAS",
          generatedRecommendation: { confidence: null, recommendation: "INCREASE_BUDGET" },
          actualOutcome: { scaledSuccessfully: false },
          brierScoreComponent: null,
        }),
      ],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.backtest.systemRuns).toBe(1);
    expect(report.backtest.naiveRuns).toBe(1);
    expect(report.backtest.systemScaledSuccessRate).toEqual({ n: 1, rate: 1 });
    expect(report.backtest.naiveScaledSuccessRate).toEqual({ n: 1, rate: 0 });
    expect(report.backtest.systemBrier.n).toBe(1);
    expect(report.backtest.systemBrier.meanBrier).toBeCloseTo(0.09, 10);
  });

  it("pools live and backtest points into combinedBrier", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [recommendation({ recommendationId: "rec_1", confidence: 0.6 })],
      outcomes: [outcome({ recommendationId: "rec_1", classification: "FAILURE" })],
      backtestRuns: [backtestRun({ backtestRunId: "bt_1" })],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.combinedBrier.n).toBe(2);
    expect(report.dataProvenance.hasAnyJudgedData).toBe(true);
  });
});

describe("buildCalibrationReport — calibration curve minimum-n refusal, end to end", () => {
  it("reports null for a bucket below MIN_CALIBRATION_BUCKET_SIZE even with real, judged data", () => {
    const recs = Array.from({ length: 3 }, (_, i) =>
      recommendation({ recommendationId: `rec_${i}`, confidence: 0.8 }),
    );
    const outcomes = recs.map((r) =>
      outcome({ recommendationId: r.recommendationId, classification: "SUCCESS" }),
    );
    const inputs: CalibrationRawInputs = {
      recommendations: recs,
      outcomes,
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.live.brier.n).toBe(3); // Brier score itself has no minimum-n floor
    const bucket = must(
      report.calibrationCurve.buckets.find((b) => b.bucketLow <= 0.8 && b.bucketHigh > 0.8),
    );
    expect(bucket.n).toBe(3);
    expect(bucket.n).toBeLessThan(MIN_CALIBRATION_BUCKET_SIZE);
    expect(bucket.observedSuccessRate).toBeNull(); // the curve refuses to draw a point from n=3
  });
});

describe("buildCalibrationReport — guardrail rejection rate over time", () => {
  it("buckets attempts by month using the supplied reporting timezone", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [
        recommendation({ recommendationId: "rec_a", createdAt: new Date("2026-01-15T00:00:00Z") }),
        recommendation({
          recommendationId: "rec_b",
          status: "REJECTED",
          recheckConditions: null,
          confidence: null,
          createdAt: new Date("2026-01-20T00:00:00Z"),
        }),
      ],
      outcomes: [],
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, NOW);
    expect(report.guardrailRejectionRate.overTime).toEqual([
      { period: "2026-01", attempts: 2, rejections: 1, rate: 0.5 },
    ]);
  });
});
