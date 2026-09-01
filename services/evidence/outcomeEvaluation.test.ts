// E2's own "Done when" bar, proven at the pure-function level (no Firestore needed — see
// recommendationOutcomeTask.emulator.test.ts for the same proof against a real emulator/pipeline):
// a recommendation with unmet recheck conditions is NOT evaluated (NOT_YET_ELIGIBLE, never a
// fixed-days fallback); one that meets them IS evaluated against its SHRUNK baseline, never raw.

import { describe, expect, it } from "vitest";
import type {
  DecisionPacket,
  MetaInsightsDailyNormalized,
  NormalizedMoney,
  Recommendation,
  ReportingDay,
} from "@shared/schema/index.ts";
import { addCalendarDays } from "@shared/canon/index.ts";
import {
  computeRecommendationOutcome,
  type SeasonalityContextForOutcome,
} from "./outcomeEvaluation.ts";

const ACCEPTED_AT = new Date("2026-08-01T10:00:00Z"); // reporting day 2026-08-01 IST
const PACKET_CREATED_AT = new Date("2026-07-31T20:00:00Z"); // reporting day 2026-08-01 IST -> asOfDay 2026-07-31

/** Calendar-correct day arithmetic (month/year boundaries included) for building multi-week
 * fixtures — plain string padding breaks the moment a test range crosses a month boundary. */
function dayFrom(startDay: string, offsetDays: number): ReportingDay {
  return addCalendarDays(startDay as ReportingDay, offsetDays);
}

const NULL_SEASONALITY: SeasonalityContextForOutcome = async () => ({
  labels: [],
  spansSeasonalBoundary: false,
  demandIndex: null,
  demandIndexSampleSize: 0,
  summaryText: "off-season",
});

function money(amountMinorUnits: number): NormalizedMoney {
  return {
    amountMinorUnits,
    currency: "INR",
    sourceAmountMinorUnits: amountMinorUnits,
    sourceCurrency: "INR",
    fxRateToReportingCurrency: 1,
    fxRateSource: "same_currency_no_conversion",
  };
}

function baseRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    recommendationId: "rec_1",
    status: "COMPLETE",
    packetId: "ADSET_AS_17",
    namedEntity: { type: "ADSET", id: "AS_17" },
    decisionUnit: { type: "ADSET", id: "AS_17" },
    recommendation: "INCREASE_BUDGET",
    currentBudgetMinorUnits: 1_000_000,
    recommendedBudgetMinorUnits: 1_150_000,
    changePercent: 15,
    confidence: 0.72,
    summary: "Increase the budget by 15%.",
    primaryReasons: ["above target"],
    risks: [],
    doNotDo: [],
    recheckConditions: {
      minimumAdditionalSpendMinorUnits: 1_500_000,
      minimumAdditionalPurchases: 15,
    },
    guardrailRejection: null,
    accountDataVersionAtGeneration: 1,
    requestedBy: "rajendrahn38@gmail.com",
    requestedQuestion: "Should I increase the budget of AS_17?",
    errorMessage: null,
    provenance: null,
    createdAt: PACKET_CREATED_AT,
    updatedAt: PACKET_CREATED_AT,
    acceptedAt: ACCEPTED_AT,
    rejectedByUserAt: null,
    ...overrides,
  };
}

function basePacket(overrides: Partial<DecisionPacket> = {}): DecisionPacket {
  return {
    packetId: "ADSET_AS_17",
    outcome: "EVIDENCE",
    namedEntity: { type: "ADSET", id: "AS_17" },
    decisionUnit: { type: "ADSET", id: "AS_17" },
    escalatedFrom: null,
    accountDataVersion: 1,
    isStale: false,
    evidence: {
      primaryWindow: "28d",
      evidence: {
        windows: {
          "28d": { metaRoasShrunk: 3.5 }, // deliberately different from any "raw" figure
        },
      },
    },
    textRendering: "…",
    createdAt: PACKET_CREATED_AT,
    ...overrides,
  };
}

function metaRow(
  reportingDay: string,
  spendMinorUnits: number,
  purchases: number,
  purchaseValueMinorUnits: number,
  overrides: Partial<MetaInsightsDailyNormalized> = {},
): MetaInsightsDailyNormalized {
  return {
    adId: "ad_1",
    adsetId: "AS_17",
    campaignId: "cmp_1",
    accountId: "act_1",
    reportingDay: reportingDay as MetaInsightsDailyNormalized["reportingDay"],
    reportingTimezone: "Asia/Kolkata",
    nativeDate: reportingDay as MetaInsightsDailyNormalized["reportingDay"],
    nativeTimezone: "Asia/Kolkata",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    spend: money(spendMinorUnits),
    purchaseValue: money(purchaseValueMinorUnits),
    impressions: 500,
    reach: 400,
    frequency: 1.25,
    clicks: 25,
    landingPageViews: 20,
    addToCart: 3,
    initiateCheckout: 1,
    purchases,
    sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    computedAt: new Date("2026-08-30T00:00:00Z"),
    ...overrides,
  };
}

const COMMON = {
  reportingCurrency: "INR",
  reportingTimezone: "Asia/Kolkata",
  intervalZScore: 1.645,
  intervalZScoreSource: "default" as const,
  now: new Date("2026-08-15T00:00:00Z"),
  seasonalityContextFor: NULL_SEASONALITY,
};

describe("computeRecommendationOutcome — §21.1: evaluate on evidence, never the calendar", () => {
  it("NOT_YET_ELIGIBLE: unmet recheck conditions are not evaluated at all", async () => {
    const rec = baseRecommendation();
    const packet = basePacket();
    // Only 3 days of small volume since acceptance — far short of the 1,500,000/15 thresholds.
    const rows = [
      metaRow("2026-08-02", 50_000, 2, 200_000),
      metaRow("2026-08-03", 50_000, 2, 200_000),
      metaRow("2026-08-04", 50_000, 2, 200_000),
    ];
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: "2026-08-04" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("NOT_YET_ELIGIBLE");
    if (result.kind !== "NOT_YET_ELIGIBLE") throw new Error("expected NOT_YET_ELIGIBLE");
    expect(result.reason).toMatch(/not yet met/);
  });

  it("EVALUATED: recheck conditions met — compares against the SHRUNK baseline, never the raw value", async () => {
    // A higher purchase-count threshold (50) than the other tests here so the resulting Poisson
    // interval is tight enough for its LOW bound to clear the 3.5 baseline outright — this test
    // is about proving SUCCESS is reachable and reads the shrunk figure, not about the estimator
    // itself (that's interval.test.ts's job).
    const rec = baseRecommendation({
      recheckConditions: {
        minimumAdditionalSpendMinorUnits: 1_000_000,
        minimumAdditionalPurchases: 50,
      },
    });
    // metaRoasShrunk on the packet is 3.5; if this were compared against some OTHER, raw-like
    // number instead, this assertion below would catch it directly.
    const packet = basePacket();
    const rows = Array.from({ length: 60 }, (_, i) =>
      metaRow(dayFrom("2026-08-02", i), 100_000, 1, 500_000),
    );
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: dayFrom("2026-08-02", 59) as never,
      ...COMMON,
    });
    expect(result.kind).toBe("EVALUATED");
    if (result.kind !== "EVALUATED") throw new Error("expected EVALUATED");
    expect(result.outcome.baselineShrunk).toBe(3.5); // the packet's SHRUNK figure, verbatim
    expect(result.outcome.triggeredBy).toBe("RECHECK_CONDITIONS_MET");
    expect(result.outcome.additionalSpendMinorUnits).toBeGreaterThanOrEqual(1_000_000);
    expect(result.outcome.additionalPurchases).toBeGreaterThanOrEqual(50);
    // roasAfter = 500,000/100,000 = 5.0 throughout -> comfortably above the 3.5 shrunk baseline,
    // and at n=50 purchases the interval's own low bound clears 3.5 too -> SUCCESS.
    expect(result.outcome.roasAfter).toBeCloseTo(5.0, 5);
    expect(result.outcome.classification).toBe("SUCCESS");
    expect(result.outcome.rawClassification).toBe("SUCCESS");
    // The evaluation window stops at the FIRST day both conditions are met (day 50), not the
    // whole 60-day range handed in.
    expect(result.outcome.evaluationWindow?.startDay).toBe("2026-08-02");
    expect(result.outcome.evaluationWindow?.endDay).toBe(dayFrom("2026-08-02", 49));
  });

  it("FAILURE: roasAfter's interval sits entirely below the shrunk baseline", async () => {
    const rec = baseRecommendation();
    const packet = basePacket({
      evidence: { primaryWindow: "28d", evidence: { windows: { "28d": { metaRoasShrunk: 6.0 } } } },
    });
    const rows = Array.from(
      { length: 20 },
      (_, i) => metaRow(`2026-08-${String(2 + i).padStart(2, "0")}`, 100_000, 1, 200_000), // roas 2.0
    );
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: "2026-08-21" as never,
      ...COMMON,
    });
    if (result.kind !== "EVALUATED") throw new Error(`expected EVALUATED, got ${result.kind}`);
    expect(result.outcome.roasAfter).toBeCloseTo(2.0, 5);
    expect(result.outcome.classification).toBe("FAILURE");
  });

  it("NEUTRAL: roasAfter's interval straddles the shrunk baseline — a real, correct answer", async () => {
    const rec = baseRecommendation({
      recheckConditions: {
        minimumAdditionalSpendMinorUnits: 100_000,
        minimumAdditionalPurchases: 1,
      },
    });
    const packet = basePacket({
      evidence: { primaryWindow: "28d", evidence: { windows: { "28d": { metaRoasShrunk: 3.5 } } } },
    });
    // A single day, one purchase — a very wide interval that straddles 3.5.
    const rows = [metaRow("2026-08-02", 100_000, 1, 350_000)];
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: "2026-08-02" as never,
      ...COMMON,
    });
    if (result.kind !== "EVALUATED") throw new Error(`expected EVALUATED, got ${result.kind}`);
    expect(result.outcome.classification).toBe("NEUTRAL");
  });

  it("SEASONALLY_CONFOUNDED: flags rather than silently scores when window and baseline sit in different seasonal regimes", async () => {
    const rec = baseRecommendation({
      recheckConditions: {
        minimumAdditionalSpendMinorUnits: 1_000_000,
        minimumAdditionalPurchases: 50,
      },
    });
    const packet = basePacket();
    const rows = Array.from(
      { length: 60 },
      (_, i) => metaRow(dayFrom("2026-08-02", i), 100_000, 1, 500_000), // roas 5.0 -> would be SUCCESS unflagged
    );
    const seasonalContext: SeasonalityContextForOutcome = async (_window, baseline) => ({
      labels: ["diwali"],
      spansSeasonalBoundary: baseline !== undefined, // true only for the window-vs-baseline call
      demandIndex: null,
      demandIndexSampleSize: 1,
      summaryText: "window covers Diwali; baseline is off-season — different seasonal regimes",
    });
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: dayFrom("2026-08-02", 59) as never,
      ...COMMON,
      seasonalityContextFor: seasonalContext,
    });
    if (result.kind !== "EVALUATED") throw new Error(`expected EVALUATED, got ${result.kind}`);
    // The number is NOT suppressed...
    expect(result.outcome.roasAfter).toBeCloseTo(5.0, 5);
    // ...but the classification is flagged, not silently scored as the SUCCESS the raw read would be.
    expect(result.outcome.rawClassification).toBe("SUCCESS");
    expect(result.outcome.classification).toBe("SEASONALLY_CONFOUNDED");
    expect(result.outcome.seasonalContext?.spansSeasonalBoundary).toBe(true);
    expect(result.outcome.seasonalContext?.evaluationWindowLabels).toEqual(["diwali"]);
  });

  it("SKIPPED: recommendation never accepted", async () => {
    const rec = baseRecommendation({ acceptedAt: null });
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet: basePacket(),
      metaRowsInRange: [],
      asOfDay: "2026-08-21" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("SKIPPED");
  });

  it("SKIPPED: no recheckConditions (e.g. a guardrail-rejected recommendation)", async () => {
    const rec = baseRecommendation({ recheckConditions: null });
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet: basePacket(),
      metaRowsInRange: [],
      asOfDay: "2026-08-21" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("SKIPPED");
  });

  it("SKIPPED: recheckConditions has neither threshold set", async () => {
    const rec = baseRecommendation({
      recheckConditions: {
        minimumAdditionalSpendMinorUnits: null,
        minimumAdditionalPurchases: null,
      },
    });
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet: basePacket(),
      metaRowsInRange: [],
      asOfDay: "2026-08-21" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("SKIPPED");
  });

  it("SKIPPED: no shrunk baseline on the packet — never substitutes the raw value", async () => {
    const rec = baseRecommendation();
    const packet = basePacket({
      evidence: {
        primaryWindow: "28d",
        evidence: { windows: { "28d": { metaRoasShrunk: null } } },
      },
    });
    const rows = Array.from({ length: 20 }, (_, i) =>
      metaRow(`2026-08-${String(2 + i).padStart(2, "0")}`, 100_000, 1, 500_000),
    );
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: "2026-08-21" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("SKIPPED");
    if (result.kind !== "SKIPPED") throw new Error("expected SKIPPED");
    expect(result.reason).toMatch(/shrunk baseline/);
  });

  it("SKIPPED: packet outcome is not EVIDENCE (defensive backstop)", async () => {
    const rec = baseRecommendation();
    const packet = basePacket({ outcome: "NOT_DELIVERING", evidence: {} });
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: [],
      asOfDay: "2026-08-21" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("SKIPPED");
  });

  it("NOT_YET_ELIGIBLE: accepted too recently for a complete post-acceptance reporting day", async () => {
    const rec = baseRecommendation({ acceptedAt: new Date("2026-08-21T10:00:00Z") });
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet: basePacket(),
      metaRowsInRange: [],
      asOfDay: "2026-08-21" as never, // same day as (the reporting-day of) acceptance
      ...COMMON,
    });
    expect(result.kind).toBe("NOT_YET_ELIGIBLE");
  });

  it("rows for a different decision unit are ignored, not counted toward the recheck conditions", async () => {
    const rec = baseRecommendation(); // decisionUnit AS_17
    const packet = basePacket();
    const rows = [
      metaRow("2026-08-02", 5_000_000, 100, 20_000_000, { adsetId: "AS_other" }), // huge, wrong entity
      metaRow("2026-08-02", 10_000, 1, 40_000, { adsetId: "AS_17" }), // tiny, correct entity
    ];
    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange: rows,
      asOfDay: "2026-08-02" as never,
      ...COMMON,
    });
    expect(result.kind).toBe("NOT_YET_ELIGIBLE");
  });
});
