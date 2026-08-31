import { describe, expect, it } from "vitest";
import type {
  CreativeFamily,
  EntityFeatures,
  MetricWithInterval,
  WindowMetrics,
} from "@shared/schema/index.ts";
import { assembleScalingEvidence } from "./evidenceAssembler.ts";
import type { EligibilityResult } from "./eligibility.ts";

const now = new Date("2026-08-30T00:00:00Z");

function metric(overrides: Partial<MetricWithInterval> = {}): MetricWithInterval {
  return {
    value: null,
    intervalLow: null,
    intervalHigh: null,
    sampleSize: 0,
    verdict: null,
    ...overrides,
  };
}

function windowMetrics(overrides: Partial<WindowMetrics> = {}): WindowMetrics {
  return {
    attribution: null,
    spendMinorUnits: 10_000,
    impressions: 1000,
    reach: 800,
    frequency: 1.25,
    cpmMinorUnits: 10,
    clicks: 50,
    ctr: 0.05,
    cpcMinorUnits: 200,
    landingPageViews: 40,
    addToCart: 5,
    checkoutStarted: 2,
    cvr: 0.02,
    addToCartRate: 0.125,
    checkoutStartedRate: 0.4,
    purchaseRate: 0.5,
    purchases: metric({ value: 128, sampleSize: 128, verdict: null }),
    metaPurchaseValueMinorUnits: 500_000,
    metaRoas: metric({
      value: 3.91,
      intervalLow: 3.1,
      intervalHigh: 4.82,
      sampleSize: 128,
      verdict: "ABOVE_TARGET",
    }),
    metaRoasShrunk: 3.74,
    shopifyAttributedPurchases: 2,
    shopifyAttributedRevenueMinorUnits: 10_000,
    shopifyNetRevenueMinorUnits: 9_000,
    shopifyRoas: metric({ value: 1.2, sampleSize: 2, verdict: "NOT_DISTINGUISHABLE" }),
    shopifyRoasShrunk: 2.9,
    shopifyDataGap: { windowHasDataGap: false, gapDays: [] },
    attributionCoverageRatio: 0.02,
    attributionCoverageRatioIncludingNameMatch: 0.05,
    cpa: metric({
      value: 831,
      intervalLow: 702,
      intervalHigh: 995,
      sampleSize: 128,
      verdict: "BELOW_TARGET",
    }),
    aov: 5000,
    newCustomerPercent: 0.6,
    newCustomerCpaMinorUnits: 1000,
    refundRate: 0.01,
    estimatedContributionMarginMinorUnits: 100_000,
    blendedMerAccountOnly: null,
    seasonality: {
      labels: [],
      spansSeasonalBoundary: false,
      demandIndex: null,
      demandIndexSampleSize: 0,
      summaryText: "off-season",
    },
    ...overrides,
  };
}

function features(overrides: Partial<EntityFeatures> = {}): EntityFeatures {
  return {
    entityId: "as_17",
    entityType: "ADSET",
    accountDataVersion: 42,
    computedAt: now,
    windows: { "28d": windowMetrics() },
    trend: { ctrChangePercent: 2, cvrChangePercent: 25 },
    changeAware: {},
    learningPhase: { inLearningPhase: false },
    ...overrides,
  };
}

const eligibility: EligibilityResult = {
  eligibleToScale: true,
  ineligibleReasons: [],
  confidence: 0.72,
  suggestedChangePercent: 15,
  safeRangePercent: [10, 15],
};

function baseInput(overrides: Partial<Parameters<typeof assembleScalingEvidence>[0]> = {}) {
  return {
    decisionUnit: { type: "ADSET" as const, id: "as_17" },
    decisionUnitName: "AS-17",
    budgetOwner: {
      ownerLevel: "ADSET" as const,
      dailyBudgetMinorUnits: 50000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    features: features(),
    targets: { targetRoas: 3.0, targetCpaMinorUnits: 150_000, source: "default" as const },
    minPurchaseFloors: { "7d": 12, "14d": 20, "28d": 30, "56d": 45 },
    eligibility,
    creativeFamilyId: null,
    creativeFamily: null,
    creativeFatigueNotApplicableReason: "not applicable",
    reportingCurrency: "INR",
    ...overrides,
  };
}

describe("assembleScalingEvidence", () => {
  it("matches §14's worked example shape for the primary 28d window", () => {
    const evidence = assembleScalingEvidence(baseInput());
    expect(evidence.decisionUnit).toEqual({ type: "ADSET", id: "as_17" });
    expect(evidence.evidence.roas28d).toEqual({
      value: 3.91,
      interval: [3.1, 4.82],
      purchases: 128,
      verdict: "ABOVE_TARGET",
      verdictReason: expect.stringMatching(/confidently above/i),
    });
    expect(evidence.evidence.roas28dShrunk).toBe(3.74);
    expect(evidence.evidence.cpa28d?.value).toBe(831);
    expect(evidence.evidence.verdict).toBe("ABOVE_TARGET");
    expect(evidence.evidence.targetRoas).toBe(3.0);
    expect(evidence.targets.targetRoas).toBe(3.0);
  });

  it("carries the ctr/cvr trend as a category derived from the entity's own trend field", () => {
    const evidence = assembleScalingEvidence(baseInput());
    expect(evidence.evidence.funnel.ctrTrend).toBe("STABLE"); // 2% is within the ±10% band
    expect(evidence.evidence.funnel.cvrTrend).toBe("UP"); // 25% clears the band
  });

  it("always states the Shopify-coverage caveat, never presenting shopify ROAS as reliable per-entity truth", () => {
    const evidence = assembleScalingEvidence(baseInput());
    expect(evidence.evidence.shopify.note).toMatch(/not reliable/i);
    expect(evidence.evidence.shopify.note).toMatch(/Magic checkout/i);
    expect(evidence.evidence.shopify.attributionCoverageRatio).toBe(0.02);
  });

  it("marks creative fatigue not-applicable with the given reason when no family was resolved", () => {
    const evidence = assembleScalingEvidence(baseInput());
    expect(evidence.evidence.creativeFatigue.applicable).toBe(false);
    expect(evidence.evidence.creativeFatigue.note).toBe("not applicable");
  });

  it("reports a real family's fatigue fields when one is supplied", () => {
    const family: CreativeFamily = {
      familyId: "hash_abc",
      memberAssetHashes: ["hash_abc"],
      creativeType: "STANDARD",
      eligibleForFamilyFatigueScore: true,
      familyAgeDays: 30,
      totalHistoricalSpendMinorUnits: 100000,
      activeAdsCount: 2,
      variationCount: 3,
      fatigueScore: null,
      createdAt: now,
      updatedAt: now,
    };
    const evidence = assembleScalingEvidence(
      baseInput({ creativeFamilyId: "hash_abc", creativeFamily: family }),
    );
    expect(evidence.evidence.creativeFatigue.applicable).toBe(true);
    expect(evidence.evidence.creativeFatigue.variationCount).toBe(3);
    expect(evidence.evidence.creativeFatigue.note).toMatch(/no fatigue score/i);
  });

  it("carries escalatedFrom through unmodified when present", () => {
    const evidence = assembleScalingEvidence(
      baseInput({ escalatedFrom: { type: "AD", id: "238591234", reason: "SAMPLE_TOO_SMALL" } }),
    );
    expect(evidence.escalatedFrom).toEqual({
      type: "AD",
      id: "238591234",
      reason: "SAMPLE_TOO_SMALL",
    });
  });

  it("carries multi-window evidence for every window C2/C3 populated, not just the primary", () => {
    const f = features({
      windows: { "7d": windowMetrics({ spendMinorUnits: 1000 }), "28d": windowMetrics() },
    });
    const evidence = assembleScalingEvidence(baseInput({ features: f }));
    expect(Object.keys(evidence.evidence.windows).sort()).toEqual(["28d", "7d"]);
  });

  it("explains a suppressed shopifyRoas verdict via its own data-gap reason, read straight off the stored code", () => {
    const f = features({
      windows: {
        "28d": windowMetrics({
          shopifyRoas: metric({
            value: 0.4,
            sampleSize: 40,
            verdict: "NOT_DISTINGUISHABLE",
            verdictReasonCode: "DATA_GAP",
          }),
          shopifyDataGap: { windowHasDataGap: true, gapDays: ["2026-01-01"] },
        }),
      },
    });
    const evidence = assembleScalingEvidence(baseInput({ features: f }));
    const windowEvidence = evidence.evidence.windows["28d"];
    expect(windowEvidence).toBeDefined();
    expect(windowEvidence?.shopifyRoas.verdictReason).toMatch(/data gap/i);
    expect(windowEvidence?.shopifyRoas.verdictReason).toContain("2026-01-01");
  });

  it("honestly reports an unrecorded reason for a metric with no verdictReasonCode (an older stored document)", () => {
    const f = features({
      windows: {
        "28d": windowMetrics({
          metaRoas: metric({ value: 5.0, sampleSize: 6, verdict: "NOT_DISTINGUISHABLE" }), // no verdictReasonCode
        }),
      },
    });
    const evidence = assembleScalingEvidence(baseInput({ features: f }));
    const windowEvidence = evidence.evidence.windows["28d"];
    expect(windowEvidence?.metaRoas.verdictReason).toMatch(/not recorded/i);
  });

  it("renders CPA's confident-verdict sentence in currency, not raw minor units — the money formatter this fix must not disturb", () => {
    // 150_000 minor units target, [159_500, 194_863] minor-unit interval — a money metric where a
    // naive .toFixed(2) default would print "150000" mid-sentence and contradict its own verdict
    // (see explainVerdict's own `formatValue` doc comment). The CPA call site in
    // evidenceAssembler.ts's buildWindowEvidence must keep passing formatMinorUnitsAsDecimal.
    const f = features({
      windows: {
        "28d": windowMetrics({
          cpa: metric({
            value: 175_000,
            intervalLow: 159_500,
            intervalHigh: 194_863,
            sampleSize: 128,
            verdict: "ABOVE_TARGET",
          }),
        }),
      },
    });
    const evidence = assembleScalingEvidence(baseInput({ features: f }));
    const cpaReason = evidence.evidence.windows["28d"]?.cpaMinorUnits.verdictReason;
    expect(cpaReason).toContain("the target of 1500.00 — interval [1595.00, 1948.63]");
  });
});
