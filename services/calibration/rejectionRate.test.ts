import { describe, expect, it } from "vitest";
import {
  computeOverallRejectionRate,
  computeRejectionRateOverTime,
  summarizeGuardrailViolations,
} from "./rejectionRate.ts";
import type { GuardrailRejectionLog } from "@shared/schema/index.ts";
import { must } from "./testSupport.ts";

const TZ = "Asia/Kolkata";

describe("computeRejectionRateOverTime", () => {
  it("returns nothing for an empty input — not a fabricated 0% period", () => {
    expect(computeRejectionRateOverTime([], TZ)).toEqual([]);
  });

  it("buckets by month and computes a real rate per period", () => {
    const attempts = [
      { status: "COMPLETE" as const, createdAt: new Date("2026-01-05T10:00:00Z") },
      { status: "REJECTED" as const, createdAt: new Date("2026-01-20T10:00:00Z") },
      { status: "COMPLETE" as const, createdAt: new Date("2026-02-01T10:00:00Z") },
      { status: "COMPLETE" as const, createdAt: new Date("2026-02-02T10:00:00Z") },
      { status: "REJECTED" as const, createdAt: new Date("2026-02-03T10:00:00Z") },
    ];
    const periods = computeRejectionRateOverTime(attempts, TZ, "month");
    expect(periods).toEqual([
      { period: "2026-01", attempts: 2, rejections: 1, rate: 0.5 },
      { period: "2026-02", attempts: 3, rejections: 1, rate: 1 / 3 },
    ]);
  });

  it("supports day granularity", () => {
    const attempts = [
      { status: "COMPLETE" as const, createdAt: new Date("2026-03-01T05:00:00Z") },
      { status: "REJECTED" as const, createdAt: new Date("2026-03-01T06:00:00Z") },
    ];
    const periods = computeRejectionRateOverTime(attempts, TZ, "day");
    expect(periods).toHaveLength(1);
    const onlyPeriod = must(periods[0]);
    expect(onlyPeriod.period).toMatch(/^2026-03-0[12]$/); // IST is UTC+5:30 — same UTC day here
    expect(onlyPeriod.rate).toBe(0.5);
  });
});

describe("computeOverallRejectionRate", () => {
  it("returns rate=null for zero attempts", () => {
    expect(computeOverallRejectionRate([])).toEqual({ attempts: 0, rejections: 0, rate: null });
  });

  it("computes rejections / attempts", () => {
    const attempts = [
      { status: "COMPLETE" as const },
      { status: "COMPLETE" as const },
      { status: "REJECTED" as const },
    ];
    expect(computeOverallRejectionRate(attempts)).toEqual({
      attempts: 3,
      rejections: 1,
      rate: 1 / 3,
    });
  });
});

function violation(
  code: string,
  field: string | null,
  source: "settings" | "default" | null,
  limit: number,
): GuardrailRejectionLog["violations"][number] {
  return {
    code: code as GuardrailRejectionLog["violations"][number]["code"],
    message: `${code} test message`,
    judgedAgainst: field && source ? { field, limit, source, actual: limit + 5 } : null,
  };
}

function rejectionLog(
  id: string,
  violations: GuardrailRejectionLog["violations"],
  rejectedAt: Date,
): GuardrailRejectionLog {
  return {
    recommendationId: id,
    namedEntity: null,
    decisionUnitClaimedByModel: null,
    decisionUnitResolved: null,
    recommendationType: null,
    changePercent: null,
    violations,
    reason: "test",
    accountDataVersion: null,
    adOptimizationKnowledgeVersion: null,
    rejectedAt,
  };
}

describe("summarizeGuardrailViolations", () => {
  it("returns empty summaries for no rejections", () => {
    const summary = summarizeGuardrailViolations([]);
    expect(summary.byCode).toEqual([]);
    expect(summary.byJudgedAgainstSource).toEqual([]);
    expect(summary.byField).toEqual([]);
  });

  it("counts by code, by judgedAgainst.source, and by field — one rejection can carry multiple violations", () => {
    const rejections: GuardrailRejectionLog[] = [
      rejectionLog(
        "rec_1",
        [
          violation(
            "MAX_CHANGE_PERCENT_EXCEEDED",
            "guardrailThresholds.maxChangePercent",
            "default",
            20,
          ),
          violation(
            "MIN_SPEND_NOT_MET",
            "guardrailThresholds.minSpendMinorUnits.28d",
            "default",
            5284890,
          ),
        ],
        new Date("2026-01-01T00:00:00Z"),
      ),
      rejectionLog(
        "rec_2",
        [
          violation(
            "MAX_CHANGE_PERCENT_EXCEEDED",
            "guardrailThresholds.maxChangePercent",
            "settings",
            15,
          ),
        ],
        new Date("2026-02-01T00:00:00Z"),
      ),
      rejectionLog(
        "rec_3",
        [violation("DECISION_UNIT_NOT_BUDGET_OWNER", null, null, 0)],
        new Date("2026-03-01T00:00:00Z"),
      ),
    ];
    const summary = summarizeGuardrailViolations(rejections);

    expect(summary.byCode).toEqual(
      expect.arrayContaining([
        { code: "MAX_CHANGE_PERCENT_EXCEEDED", count: 2 },
        { code: "MIN_SPEND_NOT_MET", count: 1 },
        { code: "DECISION_UNIT_NOT_BUDGET_OWNER", count: 1 },
      ]),
    );

    expect(summary.byJudgedAgainstSource).toEqual(
      expect.arrayContaining([
        { source: "default", count: 2 },
        { source: "settings", count: 1 },
        { source: "none", count: 1 },
      ]),
    );

    const maxChangeField = must(
      summary.byField.find((f) => f.field === "guardrailThresholds.maxChangePercent"),
    );
    expect(maxChangeField.count).toBe(2);
    // Most recent (rec_2, 2026-02-01, settings, limit 15) wins over the earlier default/20 —
    // proves a later operator correction is what's surfaced, not the oldest record.
    expect(maxChangeField.source).toBe("settings");
    expect(maxChangeField.mostRecentLimit).toBe(15);
  });
});
