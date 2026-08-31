import { describe, expect, it } from "vitest";
import {
  computeEligibilityAndRange,
  SAFE_RANGE_LOWER_PERCENT,
  SAFE_RANGE_UPPER_PERCENT,
  type EligibilityInput,
} from "./eligibility.ts";

function base(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    isDelivering: true,
    metaRoasVerdict: "ABOVE_TARGET",
    cpaVerdict: "BELOW_TARGET",
    inLearningPhase: false,
    recentMajorChanges: false,
    metaRoasSampleSize: 60,
    minPurchaseFloor: 30,
    ...overrides,
  };
}

describe("computeEligibilityAndRange", () => {
  it("is eligible with a non-null suggested change and a safe range within the material-change threshold", () => {
    const result = computeEligibilityAndRange(base());
    expect(result.eligibleToScale).toBe(true);
    expect(result.ineligibleReasons).toEqual([]);
    expect(result.suggestedChangePercent).not.toBeNull();
    expect(result.safeRangePercent).toEqual([SAFE_RANGE_LOWER_PERCENT, SAFE_RANGE_UPPER_PERCENT]);
    expect(SAFE_RANGE_UPPER_PERCENT).toBeLessThan(20); // stays clear of C4's material-change threshold
  });

  it("is ineligible and gives no range when not delivering", () => {
    const result = computeEligibilityAndRange(base({ isDelivering: false }));
    expect(result.eligibleToScale).toBe(false);
    expect(result.ineligibleReasons).toContain("NOT_DELIVERING");
    expect(result.suggestedChangePercent).toBeNull();
    expect(result.safeRangePercent).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("is ineligible when metaRoas is not ABOVE_TARGET", () => {
    const result = computeEligibilityAndRange(base({ metaRoasVerdict: "NOT_DISTINGUISHABLE" }));
    expect(result.ineligibleReasons).toContain("ROAS_NOT_ABOVE_TARGET");
  });

  it("is ineligible when CPA is ABOVE_TARGET (the bad direction for a cost metric)", () => {
    const result = computeEligibilityAndRange(base({ cpaVerdict: "ABOVE_TARGET" }));
    expect(result.ineligibleReasons).toContain("CPA_ABOVE_TARGET");
  });

  it("treats a BELOW_TARGET or NOT_DISTINGUISHABLE cpaVerdict as not blocking", () => {
    expect(
      computeEligibilityAndRange(base({ cpaVerdict: "NOT_DISTINGUISHABLE" })).eligibleToScale,
    ).toBe(true);
  });

  it("is ineligible while in learning phase", () => {
    const result = computeEligibilityAndRange(base({ inLearningPhase: true }));
    expect(result.ineligibleReasons).toContain("IN_LEARNING_PHASE");
  });

  it("does not block on inLearningPhase === null (not applicable at this altitude)", () => {
    expect(computeEligibilityAndRange(base({ inLearningPhase: null })).eligibleToScale).toBe(true);
  });

  it("is ineligible after a recent major change", () => {
    const result = computeEligibilityAndRange(base({ recentMajorChanges: true }));
    expect(result.ineligibleReasons).toContain("RECENT_MAJOR_CHANGE");
  });

  it("reports every failing gate at once, not just the first", () => {
    const result = computeEligibilityAndRange(
      base({ isDelivering: false, inLearningPhase: true, recentMajorChanges: true }),
    );
    expect(result.ineligibleReasons).toEqual(
      expect.arrayContaining(["NOT_DELIVERING", "IN_LEARNING_PHASE", "RECENT_MAJOR_CHANGE"]),
    );
  });

  it("confidence and suggestedChangePercent grow monotonically with sample size above the floor", () => {
    const atFloor = computeEligibilityAndRange(
      base({ metaRoasSampleSize: 30, minPurchaseFloor: 30 }),
    );
    const doubleFloor = computeEligibilityAndRange(
      base({ metaRoasSampleSize: 60, minPurchaseFloor: 30 }),
    );
    expect(atFloor.confidence).toBeCloseTo(0.5);
    expect(doubleFloor.confidence).toBeGreaterThan(atFloor.confidence);
    expect(doubleFloor.confidence).toBeLessThanOrEqual(0.9);
    expect(atFloor.suggestedChangePercent).not.toBeNull();
    expect(doubleFloor.suggestedChangePercent).not.toBeNull();
    expect(doubleFloor.suggestedChangePercent ?? 0).toBeGreaterThanOrEqual(
      atFloor.suggestedChangePercent ?? 0,
    );
  });
});
