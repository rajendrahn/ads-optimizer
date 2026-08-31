import { describe, expect, it } from "vitest";
import { computeRecentMajorChanges } from "./recentChanges.ts";

describe("computeRecentMajorChanges", () => {
  it("is false with no change-aware data at all", () => {
    expect(computeRecentMajorChanges(undefined)).toBe(false);
    expect(computeRecentMajorChanges({})).toBe(false);
  });

  it("is true when a budget change happened in the last 7 days", () => {
    expect(computeRecentMajorChanges({ budgetChangesLast7Days: 1 })).toBe(true);
  });

  it("is true when a creative change happened in the last 7 days", () => {
    expect(computeRecentMajorChanges({ creativeChangesLast7Days: 2 })).toBe(true);
  });

  it("is true when an audience change happened within its own 14-day window", () => {
    expect(computeRecentMajorChanges({ hoursSinceLastAudienceChange: 24 })).toBe(true);
    expect(computeRecentMajorChanges({ hoursSinceLastAudienceChange: 15 * 24 })).toBe(false);
  });

  it("is true when a status change happened within the last 72 hours", () => {
    expect(computeRecentMajorChanges({ hoursSinceLastStatusChange: 10 })).toBe(true);
    expect(computeRecentMajorChanges({ hoursSinceLastStatusChange: 200 })).toBe(false);
  });
});
