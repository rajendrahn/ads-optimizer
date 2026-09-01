import { describe, expect, it } from "vitest";
import { renderCalibrationDashboard } from "./dashboardHtml.ts";
import { buildCalibrationReport } from "./report.ts";
import type { CalibrationRawInputs } from "./collect.ts";
import type {
  GuardrailRejectionLog,
  Recommendation,
  RecommendationOutcome,
} from "@shared/schema/index.ts";

const CANON = { reportingTimezone: "Asia/Kolkata" };

const EMPTY: CalibrationRawInputs = {
  recommendations: [],
  outcomes: [],
  backtestRuns: [],
  guardrailRejections: [],
};

function recommendation(id: string, confidence: number): Recommendation {
  return {
    recommendationId: id,
    status: "COMPLETE",
    packetId: `packet_${id}`,
    namedEntity: { type: "ADSET", id: "as_1" },
    decisionUnit: { type: "ADSET", id: "as_1" },
    recommendation: "INCREASE_BUDGET",
    currentBudgetMinorUnits: 100000,
    recommendedBudgetMinorUnits: 110000,
    changePercent: 10,
    confidence,
    summary: "test",
    primaryReasons: [],
    risks: [],
    doNotDo: [],
    recheckConditions: { minimumAdditionalSpendMinorUnits: 5000, minimumAdditionalPurchases: 5 },
    guardrailRejection: null,
    accountDataVersionAtGeneration: 1,
    requestedBy: "test@example.com",
    requestedQuestion: "<script>alert(1)</script>",
    errorMessage: null,
    provenance: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    acceptedAt: new Date("2026-08-01T01:00:00Z"),
    rejectedByUserAt: null,
  };
}

function outcome(id: string): RecommendationOutcome {
  return {
    recommendationId: id,
    evaluatedAt: new Date("2026-08-10T00:00:00Z"),
    triggeredBy: "RECHECK_CONDITIONS_MET",
    additionalSpendMinorUnits: 6000,
    additionalPurchases: 6,
    roasAfter: 4.5,
    baselineShrunk: 3.5,
    classification: "SUCCESS",
    createdAt: new Date("2026-08-10T00:00:00Z"),
  };
}

describe("renderCalibrationDashboard", () => {
  it("renders a well-formed HTML document for the empty (no-data) report", () => {
    const report = buildCalibrationReport(EMPTY, CANON, new Date("2026-08-31T00:00:00Z"));
    const html = renderCalibrationDashboard(report);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Confidence calibration report");
    expect(html).toContain("No judged outcome or backtest data exists yet");
    // Every note explaining the exclusions must actually appear on the page, not just live in the
    // report object — an operator reads the HTML, not the JSON.
    for (const note of report.dataProvenance.notes) {
      expect(html).toContain(note.slice(0, 40));
    }
  });

  it("renders real numbers and the reliability diagram once there is judged data", () => {
    const inputs: CalibrationRawInputs = {
      recommendations: [recommendation("rec_1", 0.8)],
      outcomes: [outcome("rec_1")],
      backtestRuns: [],
      guardrailRejections: [],
    };
    const report = buildCalibrationReport(inputs, CANON, new Date("2026-08-31T00:00:00Z"));
    const html = renderCalibrationDashboard(report);
    expect(html).toContain("<svg");
    expect(html).not.toContain("No judged outcome or backtest data exists yet");
    expect(html).toContain("n=1");
  });

  it("HTML-escapes free-text fields (e.g. guardrailJudgedAgainst.field) rather than interpolating them raw", () => {
    // `judgedAgainst.field` is a free `z.string()`, not an enum, so it is the one string in this
    // report's inputs that isn't guaranteed safe by construction — defensively escaped anyway.
    const rejection: GuardrailRejectionLog = {
      recommendationId: "rec_xss",
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
            field: '<script>alert("field")</script>',
            limit: 20,
            source: "default",
            actual: 40,
          },
        },
      ],
      reason: "test",
      accountDataVersion: 1,
      adOptimizationKnowledgeVersion: null,
      rejectedAt: new Date("2026-08-01T00:00:00Z"),
    };
    const inputs: CalibrationRawInputs = {
      recommendations: [],
      outcomes: [],
      backtestRuns: [],
      guardrailRejections: [rejection],
    };
    const report = buildCalibrationReport(inputs, CANON, new Date("2026-08-31T00:00:00Z"));
    const html = renderCalibrationDashboard(report);
    expect(html).not.toContain('<script>alert("field")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});
