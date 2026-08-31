import { describe, expect, it } from "vitest";
import type { ReportingDay } from "@shared/schema/index.ts";
import { computeLearningPhaseFeatures, type BudgetChangeCandidate } from "./learningPhase.ts";

const ASOF_DAY = "2026-08-30" as ReportingDay;
const OLD_CREATED_DAY = "2025-01-01" as ReportingDay; // long-lived ad set, never reset

function days(purchases: Record<string, number>): Map<ReportingDay, number> {
  return new Map(Object.entries(purchases) as [ReportingDay, number][]);
}

describe("computeLearningPhaseFeatures", () => {
  it("reports inLearningPhase: true for an ad set below the conversion threshold, no reset ever", () => {
    // 20-35/week is the account's own real range (§2.1) — well under the 50 threshold.
    const purchasesByDay = days({
      "2026-08-24": 4,
      "2026-08-25": 3,
      "2026-08-26": 5,
      "2026-08-27": 4,
      "2026-08-28": 3,
      "2026-08-29": 4,
      "2026-08-30": 3,
    }); // 26 total, < 50
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [],
      purchasesByDay,
    });
    expect(out.inLearningPhase).toBe(true);
    expect(out.conversionsToExitLearning).toBe(24);
    expect(out.learningResetAt).toBeUndefined();
    expect(out.learningResetCause).toBeUndefined();
  });

  it("reports inLearningPhase: false once trailing-window conversions clear the threshold", () => {
    const purchasesByDay = days({
      "2026-08-24": 10,
      "2026-08-25": 10,
      "2026-08-26": 10,
      "2026-08-27": 10,
      "2026-08-28": 10,
      "2026-08-29": 5,
      "2026-08-30": 5,
    }); // 60 total, >= 50
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [],
      purchasesByDay,
    });
    expect(out.inLearningPhase).toBe(false);
    expect(out.conversionsToExitLearning).toBe(0);
  });

  it("a simulated material budget edit produces a learning reset with the correct cause and timestamp", () => {
    const resetAt = new Date("2026-08-28T09:00:00Z"); // 2 days before asOfDay
    const materialEdit: BudgetChangeCandidate = {
      detectedAt: resetAt,
      detectedDay: "2026-08-28" as ReportingDay,
      percent: 35,
    };
    // Purchases both before and after the reset — only post-reset ones should count.
    const purchasesByDay = days({
      "2026-08-24": 20, // before the 7-day window even starts — irrelevant either way
      "2026-08-27": 30, // before the reset — must NOT count toward exiting learning
      "2026-08-28": 5, // reset day itself — counts
      "2026-08-29": 5,
      "2026-08-30": 5,
    }); // post-reset total = 15
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [materialEdit],
      purchasesByDay,
    });
    expect(out.learningResetAt).toEqual(resetAt);
    expect(out.learningResetCause).toBe("MATERIAL_BUDGET_INCREASE:35%");
    expect(out.inLearningPhase).toBe(true); // 15 < 50
    expect(out.conversionsToExitLearning).toBe(35);
  });

  it("a material budget DECREASE is labelled distinctly from an increase", () => {
    const resetAt = new Date("2026-08-29T00:00:00Z");
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [
        { detectedAt: resetAt, detectedDay: "2026-08-29" as ReportingDay, percent: -40 },
      ],
      purchasesByDay: days({}),
    });
    expect(out.learningResetCause).toBe("MATERIAL_BUDGET_DECREASE:-40%");
  });

  it("a sub-threshold budget edit does not reset learning phase", () => {
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [
        {
          detectedAt: new Date("2026-08-29T00:00:00Z"),
          detectedDay: "2026-08-29" as ReportingDay,
          percent: 8,
        },
      ],
      purchasesByDay: days({ "2026-08-30": 60 }),
    });
    expect(out.learningResetAt).toBeUndefined();
    expect(out.learningResetCause).toBeUndefined();
    expect(out.inLearningPhase).toBe(false); // still exits on its own conversion volume
  });

  it("a BUDGET event with a null percent (B4's UNKNOWN-ownership case) cannot be a reset trigger", () => {
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [
        {
          detectedAt: new Date("2026-08-29T00:00:00Z"),
          detectedDay: "2026-08-29" as ReportingDay,
          percent: null,
        },
      ],
      purchasesByDay: days({}),
    });
    expect(out.learningResetAt).toBeUndefined();
    expect(out.learningResetCause).toBeUndefined();
  });

  it("picks the MOST RECENT qualifying material edit among several", () => {
    const older = {
      detectedAt: new Date("2026-08-20T00:00:00Z"),
      detectedDay: "2026-08-20" as ReportingDay,
      percent: 50,
    };
    const newer = {
      detectedAt: new Date("2026-08-29T00:00:00Z"),
      detectedDay: "2026-08-29" as ReportingDay,
      percent: 25,
    };
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [older, newer],
      purchasesByDay: days({}),
    });
    expect(out.learningResetAt).toEqual(newer.detectedAt);
    expect(out.learningResetCause).toBe("MATERIAL_BUDGET_INCREASE:25%");
  });

  it("a brand-new ad set is floored at its own creation day, not scored against days before it existed", () => {
    const createdDay = "2026-08-29" as ReportingDay; // created yesterday relative to asOfDay
    const purchasesByDay = days({
      "2026-08-24": 100, // before creation — must not count
      "2026-08-29": 10,
      "2026-08-30": 10,
    });
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: createdDay,
      budgetEvents: [],
      purchasesByDay,
    });
    expect(out.inLearningPhase).toBe(true); // only 20 counted, not 120
    expect(out.conversionsToExitLearning).toBe(30);
  });

  it("respects overridden thresholds and window sizes", () => {
    const out = computeLearningPhaseFeatures({
      asOfDay: ASOF_DAY,
      entityCreatedDay: OLD_CREATED_DAY,
      budgetEvents: [],
      purchasesByDay: days({ "2026-08-30": 10 }),
      conversionsThreshold: 5,
      windowDays: 1,
    });
    expect(out.inLearningPhase).toBe(false); // 10 >= 5
  });
});
