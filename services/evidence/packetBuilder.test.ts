// Structural checks on `buildDecisionPacket` — the object side of D2's "structured object AND
// text rendering" deliverable, and the accountDataVersion stamping staleness depends on.

import { describe, expect, it } from "vitest";
import { decisionPacketSchema } from "@shared/schema/index.ts";
import type { EntityFeatures, MetricWithInterval, WindowMetrics } from "@shared/schema/index.ts";
import { assembleScalingEvidence } from "./evidenceAssembler.ts";
import type { EligibilityResult } from "./eligibility.ts";
import { buildDecisionPacket } from "./packetBuilder.ts";
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
    purchases: metric({ value: 128, sampleSize: 128 }),
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
      summaryText: "off-season",
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
    trend: {},
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
  safeRangePercent: [5, 15],
};

function makeEvidenceResult(): ScalingEvidenceResult {
  const evidence = assembleScalingEvidence({
    decisionUnit: { type: "ADSET", id: "AS_17" },
    decisionUnitName: "AS-17 — Bridal broad",
    escalatedFrom: { type: "AD", id: "238591234", reason: "SAMPLE_TOO_SMALL" },
    budgetOwner: {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 50000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    features: features(),
    targets: { targetRoas: 3.0, targetCpaMinorUnits: 150_000, source: "default" },
    minPurchaseFloors: { "7d": 12, "14d": 20, "28d": 30, "56d": 45 },
    eligibility,
    creativeFamilyId: null,
    creativeFamily: null,
    creativeFatigueNotApplicableReason: "n/a",
    reportingCurrency: "INR",
  });
  return { outcome: "EVIDENCE", evidence };
}

describe("buildDecisionPacket — EVIDENCE outcome", () => {
  const packet = buildDecisionPacket({
    namedEntity: { type: "AD", id: "238591234" },
    result: makeEvidenceResult(),
    currentAccountDataVersion: 42,
    now,
  });

  it("validates against the Firestore schema", () => {
    expect(() => decisionPacketSchema.parse(packet)).not.toThrow();
  });

  it("keys the packet by the NAMED entity, not the resolved decision unit", () => {
    expect(packet.packetId).toBe("AD_238591234");
  });

  it("stamps the decision unit, escalation and account version D1 resolved", () => {
    expect(packet.outcome).toBe("EVIDENCE");
    expect(packet.decisionUnit).toEqual({ type: "ADSET", id: "AS_17" });
    expect(packet.escalatedFrom).toEqual({
      type: "AD",
      id: "238591234",
      reason: "SAMPLE_TOO_SMALL",
    });
    expect(packet.accountDataVersion).toBe(42);
    expect(packet.namedEntity).toEqual({ type: "AD", id: "238591234" });
  });

  it("is never stale at the moment it is built", () => {
    expect(packet.isStale).toBe(false);
  });

  it("produces a non-null text rendering distinct from the structured object", () => {
    expect(typeof packet.textRendering).toBe("string");
    expect(packet.textRendering?.length ?? 0).toBeGreaterThan(100);
  });

  it("carries the full evidence object under `evidence`, not a summary", () => {
    const record = packet.evidence as { evidence?: { roas28d?: { value?: number } } };
    expect(record.evidence).toBeDefined();
    expect(record.evidence?.roas28d?.value).toBe(3.91);
  });
});

describe("buildDecisionPacket — NOT_DELIVERING outcome", () => {
  const result: ScalingEvidenceResult = {
    outcome: "NOT_DELIVERING",
    namedEntity: { type: "ADSET", id: "as_dead" },
    decisionUnit: { type: "ADSET", id: "as_dead" },
    decisionUnitName: "Legacy remarketing ad set",
    primaryWindow: "28d",
    detail: "zero spend, zero impressions",
  };
  const packet = buildDecisionPacket({
    namedEntity: { type: "ADSET", id: "as_dead" },
    result,
    currentAccountDataVersion: 42,
    now,
  });

  it("validates against the Firestore schema", () => {
    expect(() => decisionPacketSchema.parse(packet)).not.toThrow();
  });

  it("still carries a real decision unit (the entity resolved to, even though not delivering)", () => {
    expect(packet.decisionUnit).toEqual({ type: "ADSET", id: "as_dead" });
    expect(packet.escalatedFrom).toBeNull();
  });
});

describe("buildDecisionPacket — NO_DECISION_UNIT outcome", () => {
  const result: ScalingEvidenceResult = {
    outcome: "NO_DECISION_UNIT",
    namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
    detail: "budget.ownerLevel is UNKNOWN",
  };
  const packet = buildDecisionPacket({
    namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
    result,
    currentAccountDataVersion: 42,
    now,
  });

  it("validates against the Firestore schema with decisionUnit explicitly null", () => {
    expect(() => decisionPacketSchema.parse(packet)).not.toThrow();
    expect(packet.decisionUnit).toBeNull();
  });

  it("never fabricates an escalation or a decision unit", () => {
    expect(packet.escalatedFrom).toBeNull();
    expect(packet.namedEntity).toEqual({ type: "CAMPAIGN", id: "cmp_orphan" });
  });
});
