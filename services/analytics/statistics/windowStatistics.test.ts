import { describe, expect, it } from "vitest";
import type { WindowMetrics } from "@shared/schema/index.ts";
import {
  computeWindowStatistics,
  type AccountMeansForWindow,
  type WindowStatisticalThresholds,
} from "./windowStatistics.ts";

const THRESHOLDS: WindowStatisticalThresholds = {
  minPurchaseFloor: 30,
  targetRoas: 3.0,
  targetCpaMinorUnits: 150_000,
  intervalZScore: 1.645,
};

const ACCOUNT_MEANS: AccountMeansForWindow = { metaRoas: 2.5, shopifyRoas: 2.2 };

function metric(value: number | null, sampleSize: number) {
  return { value, intervalLow: null, intervalHigh: null, sampleSize, verdict: null };
}

function window(overrides: Partial<WindowMetrics>): WindowMetrics {
  return {
    metaRoas: metric(null, 0),
    cpa: metric(null, 0),
    shopifyRoas: metric(null, 0),
    purchases: metric(null, 0),
    shopifyDataGap: { windowHasDataGap: false, gapDays: [] },
    seasonality: {
      labels: [],
      spansSeasonalBoundary: false,
      demandIndex: null,
      demandIndexSampleSize: 0,
      summaryText: "",
    },
    ...overrides,
  };
}

describe("computeWindowStatistics", () => {
  it("done-when #1: a naive point estimate above target is NOT_DISTINGUISHABLE at low volume", () => {
    // Raw ROAS 5.0 (well above the 3.0 target) on just 6 purchases — a naive point-estimate
    // reading would call this ABOVE_TARGET. It must not.
    const w = window({
      metaRoas: metric(5.0, 6),
      cpa: metric(50_000, 6),
      purchases: metric(6, 6),
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.metaRoas.verdict).toBe("NOT_DISTINGUISHABLE");
    // The raw number is still there, visible, just not endorsed as a confident verdict.
    expect(stats.metaRoas.intervalLow).not.toBeNull();
    expect(stats.metaRoas.intervalHigh).not.toBeNull();
  });

  it("clears the floor with real volume and a clearly-separated target -> ABOVE_TARGET", () => {
    const w = window({
      metaRoas: metric(5.0, 150),
      cpa: metric(50_000, 150),
      purchases: metric(150, 150),
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.metaRoas.verdict).toBe("ABOVE_TARGET");
    // CPA of 50,000 vs a 150,000 target, same high volume -> confidently BELOW_TARGET (literal
    // interval position — also the "good" outcome for CPA specifically).
    expect(stats.cpa.verdict).toBe("BELOW_TARGET");
  });

  it("high volume, ROAS clearly below target -> BELOW_TARGET", () => {
    const w = window({
      metaRoas: metric(1.0, 150),
      cpa: metric(300_000, 150),
      purchases: metric(150, 150),
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.metaRoas.verdict).toBe("BELOW_TARGET");
    expect(stats.cpa.verdict).toBe("ABOVE_TARGET"); // costlier than target, literal position
  });

  it("done-when #2: shrinkage pulls a small-sample outlier toward the account mean", () => {
    const w = window({ metaRoas: metric(8.0, 5), purchases: metric(5, 5) });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    const expected = (5 / 35) * 8.0 + (30 / 35) * 2.5;
    expect(stats.metaRoasShrunk).toBeCloseTo(expected, 10);
    expect(stats.metaRoasShrunk).not.toBeNull();
    expect(stats.metaRoasShrunk as number).toBeLessThan(8.0);
    expect(stats.metaRoasShrunk as number).toBeGreaterThan(2.5);
  });

  it("never emits a confident verdict on a gap-affected Shopify window, even with high volume", () => {
    const w = window({
      shopifyRoas: metric(9.0, 200), // huge volume, way above target
      shopifyDataGap: { windowHasDataGap: true, gapDays: ["2026-01-05"] },
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.shopifyRoas.verdict).toBe("NOT_DISTINGUISHABLE");
    // The number itself is still carried, never suppressed.
    expect(stats.shopifyRoas.intervalLow).not.toBeNull();
  });

  it("gap suppression is Shopify-only — metaRoas/cpa in the same window are unaffected", () => {
    const w = window({
      metaRoas: metric(5.0, 150),
      cpa: metric(50_000, 150),
      purchases: metric(150, 150),
      shopifyRoas: metric(9.0, 200),
      shopifyDataGap: { windowHasDataGap: true, gapDays: ["2026-01-05"] },
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.metaRoas.verdict).toBe("ABOVE_TARGET");
    expect(stats.cpa.verdict).toBe("BELOW_TARGET");
    expect(stats.shopifyRoas.verdict).toBe("NOT_DISTINGUISHABLE");
  });

  it("never emits a confident verdict when the window spans a seasonal boundary, for ANY metric", () => {
    const w = window({
      metaRoas: metric(6.0, 200),
      cpa: metric(40_000, 200),
      shopifyRoas: metric(6.0, 200),
      purchases: metric(200, 200),
      seasonality: {
        labels: ["diwali"],
        spansSeasonalBoundary: true,
        demandIndex: null,
        demandIndexSampleSize: 1,
        summaryText: "window covers diwali; baseline does not",
      },
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.metaRoas.verdict).toBe("NOT_DISTINGUISHABLE");
    expect(stats.cpa.verdict).toBe("NOT_DISTINGUISHABLE");
    expect(stats.shopifyRoas.verdict).toBe("NOT_DISTINGUISHABLE");
    // Still carries the numbers — seasonality context sits beside the metric, never mutates it.
    expect(stats.metaRoas.intervalLow).not.toBeNull();
  });

  it("a null value (e.g. an audit-unresolvable ad) stays fully null, never coerced to NOT_DISTINGUISHABLE", () => {
    const w = window({ shopifyRoas: metric(null, 0) });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.shopifyRoas.verdict).toBeNull();
    expect(stats.shopifyRoas.intervalLow).toBeNull();
    expect(stats.shopifyRoas.intervalHigh).toBeNull();
    expect(stats.shopifyRoasShrunk).toBeNull();
  });

  it("a real, exact zero-purchase observation is a confident NOT_DISTINGUISHABLE, not null", () => {
    const w = window({ metaRoas: metric(0, 0), cpa: metric(null, 0), purchases: metric(0, 0) });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.metaRoas.verdict).toBe("NOT_DISTINGUISHABLE");
    expect(stats.metaRoas.intervalLow).toBeNull();
    expect(stats.metaRoas.intervalHigh).toBeNull();
  });

  it("purchases carries an interval but never a verdict — there is no target for a raw count", () => {
    const w = window({ purchases: metric(150, 150), metaRoas: metric(5.0, 150) });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    expect(stats.purchasesInterval.intervalLow).not.toBeNull();
    expect(stats.purchasesInterval.intervalHigh).not.toBeNull();
  });

  it("shrinkage still computes through a gap (documented nuance: n may itself be gap-suppressed)", () => {
    const w = window({
      shopifyRoas: metric(9.0, 3),
      shopifyDataGap: { windowHasDataGap: true, gapDays: ["2026-01-05"] },
    });
    const stats = computeWindowStatistics(w, ACCOUNT_MEANS, THRESHOLDS);
    // Not null — carried alongside the gap flag, per this codebase's "never suppress the number"
    // discipline; the caller is expected to read shopifyDataGap alongside it.
    expect(stats.shopifyRoasShrunk).not.toBeNull();
    expect(stats.shopifyRoas.verdict).toBe("NOT_DISTINGUISHABLE");
  });
});
