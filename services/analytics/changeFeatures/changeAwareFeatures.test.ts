import { describe, expect, it } from "vitest";
import type { MetaChangeEvent } from "@shared/schema/index.ts";
import { computeChangeAwareFeatures } from "./changeAwareFeatures.ts";

const ASOF = new Date("2026-08-30T12:00:00Z");

function event(overrides: Partial<MetaChangeEvent>): MetaChangeEvent {
  return {
    entityType: "ADSET",
    entityId: "as_1",
    field: "BUDGET",
    detectedAt: ASOF,
    fromSnapshotKey: "from",
    toSnapshotKey: "to",
    before: null,
    after: null,
    budgetChangePercent: null,
    actor: null,
    ...overrides,
  };
}

describe("computeChangeAwareFeatures", () => {
  it("returns an empty object when there are no events at all except zeroed counters", () => {
    const out = computeChangeAwareFeatures({ events: [], asOf: ASOF });
    expect(out.hoursSinceLastBudgetChange).toBeUndefined();
    expect(out.lastBudgetChangePercent).toBeUndefined();
    expect(out.hoursSinceLastAudienceChange).toBeUndefined();
    expect(out.hoursSinceLastCreativeChange).toBeUndefined();
    expect(out.hoursSinceLastStatusChange).toBeUndefined();
    // Counters are real, measured zeros — always present.
    expect(out.budgetChangesLast7Days).toBe(0);
    expect(out.targetingChangesLast14Days).toBe(0);
    expect(out.creativeChangesLast7Days).toBe(0);
  });

  it("computes hoursSinceLastBudgetChange and lastBudgetChangePercent from the most recent BUDGET event", () => {
    const twoDaysAgo = new Date(ASOF.getTime() - 2 * 24 * 3_600_000);
    const fiveDaysAgo = new Date(ASOF.getTime() - 5 * 24 * 3_600_000);
    const out = computeChangeAwareFeatures({
      events: [
        event({ field: "BUDGET", detectedAt: fiveDaysAgo, budgetChangePercent: 10 }),
        event({ field: "BUDGET", detectedAt: twoDaysAgo, budgetChangePercent: 35.5 }),
      ],
      asOf: ASOF,
    });
    expect(out.hoursSinceLastBudgetChange).toBeCloseTo(48, 0);
    expect(out.lastBudgetChangePercent).toBe(35.5);
  });

  it("omits lastBudgetChangePercent when the most recent BUDGET event has a null percent", () => {
    const out = computeChangeAwareFeatures({
      events: [event({ field: "BUDGET", detectedAt: ASOF, budgetChangePercent: null })],
      asOf: ASOF,
    });
    expect(out.hoursSinceLastBudgetChange).toBe(0);
    expect(out.lastBudgetChangePercent).toBeUndefined();
  });

  it("budgetChangesLast7Days counts only events within the window", () => {
    const threeDaysAgo = new Date(ASOF.getTime() - 3 * 24 * 3_600_000);
    const tenDaysAgo = new Date(ASOF.getTime() - 10 * 24 * 3_600_000);
    const out = computeChangeAwareFeatures({
      events: [
        event({ field: "BUDGET", detectedAt: threeDaysAgo }),
        event({ field: "BUDGET", detectedAt: threeDaysAgo }),
        event({ field: "BUDGET", detectedAt: tenDaysAgo }),
      ],
      asOf: ASOF,
    });
    expect(out.budgetChangesLast7Days).toBe(2);
  });

  it("TARGETING maps to hoursSinceLastAudienceChange and a 14-day counter", () => {
    const oneDayAgo = new Date(ASOF.getTime() - 24 * 3_600_000);
    const twentyDaysAgo = new Date(ASOF.getTime() - 20 * 24 * 3_600_000);
    const out = computeChangeAwareFeatures({
      events: [
        event({ field: "TARGETING", detectedAt: oneDayAgo }),
        event({ field: "TARGETING", detectedAt: twentyDaysAgo }),
      ],
      asOf: ASOF,
    });
    expect(out.hoursSinceLastAudienceChange).toBeCloseTo(24, 0);
    expect(out.targetingChangesLast14Days).toBe(1);
  });

  it("CREATIVE_ASSIGNMENT maps to hoursSinceLastCreativeChange and a 7-day counter", () => {
    const out = computeChangeAwareFeatures({
      events: [event({ field: "CREATIVE_ASSIGNMENT", detectedAt: ASOF })],
      asOf: ASOF,
    });
    expect(out.hoursSinceLastCreativeChange).toBe(0);
    expect(out.creativeChangesLast7Days).toBe(1);
  });

  it("STATUS maps to hoursSinceLastStatusChange, with no NDays counter in §13", () => {
    const out = computeChangeAwareFeatures({
      events: [event({ field: "STATUS", detectedAt: ASOF })],
      asOf: ASOF,
    });
    expect(out.hoursSinceLastStatusChange).toBe(0);
  });

  it("fields for one entity do not leak into another event's field type", () => {
    const out = computeChangeAwareFeatures({
      events: [event({ field: "BID_STRATEGY", detectedAt: ASOF })],
      asOf: ASOF,
    });
    // BID_STRATEGY has no §13 field at all — every output field stays absent/zeroed.
    expect(out.hoursSinceLastBudgetChange).toBeUndefined();
    expect(out.hoursSinceLastAudienceChange).toBeUndefined();
    expect(out.hoursSinceLastCreativeChange).toBeUndefined();
    expect(out.hoursSinceLastStatusChange).toBeUndefined();
    expect(out.budgetChangesLast7Days).toBe(0);
  });
});
