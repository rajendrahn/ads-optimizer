// D2's own "Done when" bar: sample sizes and intervals visible IN THE TEXT, escalation stated
// prominently when it occurred, attribution coverage never presented as if a per-ad Shopify ROAS
// were meaningful, seasonality rendered honestly, and the judged-against target made visible.
// Exercises all three ScalingEvidenceResult outcomes.

import { describe, expect, it } from "vitest";
import type {
  CreativeFamily,
  EntityFeatures,
  MetricWithInterval,
  WindowMetrics,
} from "@shared/schema/index.ts";
import { assembleScalingEvidence } from "./evidenceAssembler.ts";
import type { EligibilityResult } from "./eligibility.ts";
import {
  renderDecisionPacketText,
  renderEvidencePacketText,
  renderNoDecisionUnitPacketText,
  renderNotDeliveringPacketText,
} from "./packetText.ts";
import type { ScalingEvidenceResult } from "./types.ts";

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
    spendMinorUnits: 1_200_000,
    impressions: 50000,
    reach: 40000,
    frequency: 1.25,
    cpmMinorUnits: 10,
    clicks: 2500,
    ctr: 0.05,
    cpcMinorUnits: 200,
    landingPageViews: 2000,
    addToCart: 500,
    checkoutStarted: 200,
    cvr: 0.02,
    addToCartRate: 0.125,
    checkoutStartedRate: 0.4,
    purchaseRate: 0.5,
    purchases: metric({ value: 128, sampleSize: 128, verdict: null }),
    metaPurchaseValueMinorUnits: 4_691_600,
    metaRoas: metric({
      value: 3.91,
      intervalLow: 3.1,
      intervalHigh: 4.82,
      sampleSize: 128,
      verdict: "ABOVE_TARGET",
    }),
    metaRoasShrunk: 3.74,
    shopifyAttributedPurchases: 1,
    shopifyAttributedRevenueMinorUnits: 5_000,
    shopifyNetRevenueMinorUnits: 4_500,
    shopifyRoas: metric({ value: 0.42, sampleSize: 1, verdict: "NOT_DISTINGUISHABLE" }),
    shopifyRoasShrunk: 2.9,
    shopifyDataGap: { windowHasDataGap: false, gapDays: [] },
    attributionCoverageRatio: 0.0002,
    attributionCoverageRatioIncludingNameMatch: 0.0009,
    cpa: metric({
      value: 176_100,
      intervalLow: 150_200,
      intervalHigh: 210_300,
      sampleSize: 128,
      verdict: "BELOW_TARGET",
    }),
    aov: 500000,
    newCustomerPercent: 0.6,
    newCustomerCpaMinorUnits: 100000,
    refundRate: 0.01,
    estimatedContributionMarginMinorUnits: 100_000,
    blendedMerAccountOnly: null,
    seasonality: {
      labels: [],
      spansSeasonalBoundary: false,
      demandIndex: null,
      demandIndexSampleSize: 0,
      summaryText: "off-season; no demand index available (n=0 clean historical occurrences).",
    },
    ...overrides,
  };
}

function features(overrides: Partial<EntityFeatures> = {}): EntityFeatures {
  return {
    entityId: "AS_17",
    entityType: "ADSET",
    accountDataVersion: 42,
    computedAt: now,
    windows: { "28d": windowMetrics() },
    trend: { ctrChangePercent: 2, cvrChangePercent: 25 },
    changeAware: { budgetChangesLast7Days: 0, creativeChangesLast7Days: 0 },
    learningPhase: { inLearningPhase: false },
    ...overrides,
  };
}

const eligibility: EligibilityResult = {
  eligibleToScale: true,
  ineligibleReasons: [],
  confidence: 0.72,
  suggestedChangePercent: 15,
  safeRangePercent: [5, 15],
};

function baseAssembleInput(overrides: Partial<Parameters<typeof assembleScalingEvidence>[0]> = {}) {
  return {
    decisionUnit: { type: "ADSET" as const, id: "AS_17" },
    decisionUnitName: "AS-17 — Bridal broad",
    escalatedFrom: undefined,
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
    creativeFamily: null as CreativeFamily | null,
    creativeFatigueNotApplicableReason: "This request named an adset directly.",
    reportingCurrency: "INR",
    ...overrides,
  };
}

describe("renderEvidencePacketText — EVIDENCE outcome", () => {
  const evidence = assembleScalingEvidence(baseAssembleInput());
  const text = renderEvidencePacketText(evidence, 42);

  it("shows every ROAS/CPA figure with its sample size AND interval, in the text", () => {
    // Meta ROAS: value, interval, purchases.
    expect(text).toMatch(/3\.91x/);
    expect(text).toMatch(/3\.10x.{0,5}4\.82x/);
    expect(text).toMatch(/128 purchases/);
    // CPA: value, interval, purchases — money-formatted, not a bare integer.
    expect(text).toMatch(/INR 1761\.00/);
    expect(text).toMatch(/INR 1502\.00.{0,5}INR 2103\.00/);
  });

  it("renders the verdict AND its reason, not just the label", () => {
    expect(text).toMatch(/ABOVE_TARGET/);
    expect(text).toMatch(/confidently above the target/i);
  });

  it("never states an escalation block when none occurred", () => {
    expect(text).not.toMatch(/ESCALATED/);
  });

  it("states attribution coverage plainly, with the Meta-vs-Shopify caveat, never presenting Shopify per-ad ROAS as reliable", () => {
    expect(text).toMatch(/ATTRIBUTION COVERAGE/);
    expect(text).toMatch(/not reliable/i);
    expect(text).toMatch(/Magic checkout/i);
    expect(text).toMatch(/Lean on Meta-attributed/i);
    // The near-zero coverage ratio itself is rendered, not hidden.
    expect(text).toMatch(/0\.020%/);
  });

  it("renders seasonality honestly — no fabricated index", () => {
    expect(text).toMatch(/SEASONALITY/);
    expect(text).toMatch(/no demand index available/i);
  });

  it("makes the judged-against target visible, with a placeholder warning when source is default", () => {
    expect(text).toMatch(/TARGETS THIS PACKET WAS JUDGED AGAINST \(source: default\)/);
    expect(text).toMatch(/PLACEHOLDER defaults/i);
    expect(text).toMatch(/targetRoas: 3\.00x/);
    expect(text).toMatch(/targetCpaMinorUnits: INR 1500\.00/);
  });

  it("does not warn about placeholders when targets come from settings", () => {
    const settingsEvidence = assembleScalingEvidence(
      baseAssembleInput({
        targets: { targetRoas: 3.5, targetCpaMinorUnits: 140_000, source: "settings" },
      }),
    );
    const t = renderEvidencePacketText(settingsEvidence, 42);
    expect(t).toMatch(/source: settings/);
    expect(t).not.toMatch(/PLACEHOLDER/i);
    expect(t).toMatch(/operator's own configured targets/i);
  });

  it("renders every populated window, not only the primary", () => {
    const multi = assembleScalingEvidence(
      baseAssembleInput({
        features: features({
          windows: { "7d": windowMetrics({ spendMinorUnits: 300_000 }), "28d": windowMetrics() },
        }),
      }),
    );
    const t = renderEvidencePacketText(multi, 42);
    expect(t).toMatch(/7d window/);
    expect(t).toMatch(/28d window/);
  });

  it("states the shrunk baseline distinctly from the raw figure (§15.3)", () => {
    expect(text).toMatch(/shrunk toward account mean: 3\.74x/);
  });

  it("renders eligibility and the suggested safe range", () => {
    expect(text).toMatch(/ELIGIBLE TO SCALE/);
    expect(text).toMatch(/\+15%/);
    expect(text).toMatch(/\[5%, 15%\]/);
  });
});

describe("renderEvidencePacketText — escalation", () => {
  it("states escalation prominently: what was asked, what answers instead, and why", () => {
    const evidence = assembleScalingEvidence(
      baseAssembleInput({
        escalatedFrom: { type: "AD", id: "238591234", reason: "SAMPLE_TOO_SMALL" },
      }),
    );
    const text = renderEvidencePacketText(evidence, 42);
    const escalationIdx = text.indexOf("ESCALATED");
    expect(escalationIdx).toBeGreaterThan(-1);
    // Prominent = appears before the metric sections, not buried at the end.
    expect(escalationIdx).toBeLessThan(text.indexOf("MULTI-WINDOW PERFORMANCE"));
    expect(text).toMatch(/You asked about AD 238591234/);
    expect(text).toMatch(/below the statistical floor/i);
    expect(text).toMatch(/AS_17/);
  });

  it("renders a distinct reason for a structural (non-sample-size) escalation", () => {
    const evidence = assembleScalingEvidence(
      baseAssembleInput({
        escalatedFrom: { type: "ADSET", id: "AS_99", reason: "ADSET_NOT_BUDGET_OWNER" },
      }),
    );
    const text = renderEvidencePacketText(evidence, 42);
    expect(text).toMatch(/Campaign Budget Optimization/i);
  });
});

describe("renderNotDeliveringPacketText", () => {
  const result: Extract<ScalingEvidenceResult, { outcome: "NOT_DELIVERING" }> = {
    outcome: "NOT_DELIVERING",
    namedEntity: { type: "ADSET", id: "as_dead" },
    decisionUnit: { type: "ADSET", id: "as_dead" },
    decisionUnitName: "Legacy remarketing ad set",
    primaryWindow: "28d",
    detail:
      "ADSET as_dead has zero Meta spend and zero impressions in the primary 28d window — it is " +
      "not delivering, not merely low-volume.",
  };

  it("names what was asked about and states plainly there is nothing to measure", () => {
    const text = renderNotDeliveringPacketText(result, 42);
    expect(text).toMatch(/NOT DELIVERING/);
    expect(text).toMatch(/as_dead/);
    expect(text).toMatch(/not delivering, not merely low-volume/i);
    expect(text).toMatch(
      /nothing currently running to scale|nothing currently running to measure/i,
    );
  });

  it("still states an escalation prominently if the not-delivering unit was itself escalated to", () => {
    const escalated = {
      ...result,
      namedEntity: { type: "AD" as const, id: "ad_low_vol" },
      escalatedFrom: { type: "AD" as const, id: "ad_low_vol", reason: "SAMPLE_TOO_SMALL" as const },
    };
    const text = renderNotDeliveringPacketText(escalated, 42);
    expect(text).toMatch(/ESCALATED/);
    expect(text).toMatch(/ad_low_vol/);
  });
});

describe("renderNoDecisionUnitPacketText", () => {
  it("names what was asked about and never fabricates a decision unit", () => {
    const result: Extract<ScalingEvidenceResult, { outcome: "NO_DECISION_UNIT" }> = {
      outcome: "NO_DECISION_UNIT",
      namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
      detail:
        "Campaign cmp_orphan has budget.ownerLevel: UNKNOWN and no child ad sets own budget either.",
    };
    const text = renderNoDecisionUnitPacketText(result, 42);
    expect(text).toMatch(/NO DECISION UNIT/);
    expect(text).toMatch(/cmp_orphan/);
    expect(text).toMatch(/UNKNOWN/);
    expect(text).toMatch(/never guesses a level/i);
  });
});

describe("renderDecisionPacketText — dispatches on outcome", () => {
  it("routes EVIDENCE to renderEvidencePacketText", () => {
    const evidence = assembleScalingEvidence(baseAssembleInput());
    const direct = renderEvidencePacketText(evidence, 42);
    const dispatched = renderDecisionPacketText({ outcome: "EVIDENCE", evidence }, 42);
    expect(dispatched).toBe(direct);
  });
});
