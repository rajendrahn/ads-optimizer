import { describe, expect, it } from "vitest";
import type { MetaInsightsDailyNormalized } from "@shared/schema/index.ts";
import type { BacktestRecommendation } from "./strategies.ts";
import { computeActualOutcome, computeBrierScoreComponent } from "./outcome.ts";

const ATTRIBUTION = { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" };

function row(
  adsetId: string,
  day: string,
  spend: number,
  purchaseValue: number,
  purchases: number,
): MetaInsightsDailyNormalized {
  return {
    adId: `ad_${adsetId}`,
    adsetId,
    campaignId: "cmp_1",
    accountId: "act_test",
    reportingDay: day,
    reportingTimezone: "Asia/Kolkata",
    nativeDate: day,
    nativeTimezone: "Asia/Kolkata",
    attribution: ATTRIBUTION,
    spend: {
      amountMinorUnits: spend,
      currency: "INR",
      sourceAmountMinorUnits: spend,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    purchaseValue: {
      amountMinorUnits: purchaseValue,
      currency: "INR",
      sourceAmountMinorUnits: purchaseValue,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    impressions: 100,
    reach: 80,
    frequency: 1.25,
    clicks: 10,
    landingPageViews: 8,
    addToCart: 2,
    initiateCheckout: 1,
    purchases,
    sourceUpdatedAt: new Date(`${day}T12:00:00Z`),
    computedAt: new Date("2026-09-01T00:00:00Z"),
  };
}

const HORIZON = { startDay: "2026-08-02", endDay: "2026-08-29" };

function rec(overrides: Partial<BacktestRecommendation>): BacktestRecommendation {
  return {
    strategy: "SYSTEM",
    decisionUnit: { type: "ADSET", id: "as_1" },
    recommendation: "INCREASE_BUDGET",
    changePercent: 12,
    confidence: 0.8,
    primaryReasons: [],
    guardrailRejected: false,
    guardrailReason: null,
    ...overrides,
  };
}

describe("computeActualOutcome", () => {
  it("returns a null outcome when the recommendation named no decision unit", () => {
    const outcome = computeActualOutcome(
      rec({ decisionUnit: null }),
      [],
      HORIZON,
      "INR",
      3.0,
      1.645,
      30,
    );
    expect(outcome.decisionUnit).toBeNull();
    expect(outcome.scaledSuccessfully).toBeNull();
  });

  it("classifies a genuinely above-target, above-floor post-period as success", () => {
    const rows: MetaInsightsDailyNormalized[] = [];
    for (let i = 0; i < 35; i++) rows.push(row("as_1", "2026-08-10", 10000, 50000, 1)); // 5x ROAS, 35 purchases
    const outcome = computeActualOutcome(rec({}), rows, HORIZON, "INR", 3.0, 1.645, 30);
    expect(outcome.verdict).toBe("ABOVE_TARGET");
    expect(outcome.scaledSuccessfully).toBe(true);
  });

  it("classifies a below-target post-period as failure", () => {
    const rows: MetaInsightsDailyNormalized[] = [];
    for (let i = 0; i < 35; i++) rows.push(row("as_1", "2026-08-10", 10000, 10000, 1)); // 1x ROAS
    const outcome = computeActualOutcome(rec({}), rows, HORIZON, "INR", 3.0, 1.645, 30);
    expect(outcome.verdict).toBe("BELOW_TARGET");
    expect(outcome.scaledSuccessfully).toBe(false);
  });

  it("only counts rows for the recommended decision unit and inside the horizon window", () => {
    const rows: MetaInsightsDailyNormalized[] = [
      row("as_OTHER", "2026-08-10", 10000, 50000, 5), // different ad set — excluded
      row("as_1", "2026-07-01", 10000, 50000, 5), // before horizon — excluded
      row("as_1", "2026-08-10", 10000, 50000, 5), // in window, correct ad set — included
    ];
    const outcome = computeActualOutcome(rec({}), rows, HORIZON, "INR", 3.0, 1.645, 30);
    expect(outcome.meta?.purchases).toBe(5);
  });

  it("below the purchase floor stays NOT_DISTINGUISHABLE even with a high raw ROAS", () => {
    const rows = [row("as_1", "2026-08-10", 1000, 50000, 2)]; // 2 purchases, 50x ROAS
    const outcome = computeActualOutcome(rec({}), rows, HORIZON, "INR", 3.0, 1.645, 30);
    expect(outcome.verdict).toBe("NOT_DISTINGUISHABLE");
    expect(outcome.scaledSuccessfully).toBe(false);
  });
});

describe("computeBrierScoreComponent — §21.2", () => {
  it("scores a confident, correct INCREASE_BUDGET call near zero", () => {
    const outcome = computeActualOutcome(
      rec({ confidence: 0.9 }),
      [],
      HORIZON,
      "INR",
      3.0,
      1.645,
      30,
    );
    const scored = computeBrierScoreComponent(rec({ confidence: 0.9 }), {
      ...outcome,
      scaledSuccessfully: true,
    });
    expect(scored).toBeCloseTo(0.01, 5); // (0.9 - 1)^2
  });

  it("scores a confident, WRONG INCREASE_BUDGET call near its ceiling", () => {
    const outcome = computeActualOutcome(rec({}), [], HORIZON, "INR", 3.0, 1.645, 30);
    const scored = computeBrierScoreComponent(rec({ confidence: 0.9 }), {
      ...outcome,
      scaledSuccessfully: false,
    });
    expect(scored).toBeCloseTo(0.81, 5); // (0.9 - 0)^2
  });

  it("is null for a HOLD/INSUFFICIENT_DATA recommendation — no scale prediction was made", () => {
    const outcome = computeActualOutcome(rec({}), [], HORIZON, "INR", 3.0, 1.645, 30);
    expect(computeBrierScoreComponent(rec({ recommendation: "HOLD" }), outcome)).toBeNull();
    expect(
      computeBrierScoreComponent(rec({ recommendation: "INSUFFICIENT_DATA" }), outcome),
    ).toBeNull();
  });

  it("is null for the naive strategy's un-calibrated confidence", () => {
    const outcome = computeActualOutcome(rec({}), [], HORIZON, "INR", 3.0, 1.645, 30);
    expect(
      computeBrierScoreComponent(rec({ confidence: null }), {
        ...outcome,
        scaledSuccessfully: true,
      }),
    ).toBeNull();
  });

  it("is null when the actual outcome could not be measured", () => {
    const outcome = computeActualOutcome(rec({}), [], HORIZON, "INR", 3.0, 1.645, 30);
    expect(outcome.scaledSuccessfully).toBeNull(); // no rows -> no spend -> unmeasurable
    expect(computeBrierScoreComponent(rec({}), outcome)).toBeNull();
  });
});
