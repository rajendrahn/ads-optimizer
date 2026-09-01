import { describe, expect, it } from "vitest";
import type { CanonSettings } from "@shared/canon/index.ts";
import type { AdSetWindowEvidence } from "./evidence.ts";
import { decideNaiveHighestRecentRoas, decideSystemStrategy } from "./strategies.ts";

const CANON: CanonSettings = {
  accountId: "act_test",
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  attributionWindow: "7d_click_1d_view",
  purchaseActionType: "omni_purchase",
  modelConfig: {
    recommendationProvider: "anthropic",
    recommendationModel: "claude-fable-5",
    creativeReasoningModel: "claude-fable-5",
    backgroundCreativeTaggingModel: "claude-haiku-4-5",
    taggingUsesBatchApi: true,
    effort: "high",
  },
};

const WINDOW = { startDay: "2026-07-05", endDay: "2026-08-01" };

function evidence(
  overrides: Partial<AdSetWindowEvidence> & { adsetId: string },
): AdSetWindowEvidence {
  return {
    window: WINDOW,
    meta: {
      currency: "INR",
      attribution: null,
      spendMinorUnits: 100000,
      impressions: 1000,
      reach: 800,
      clicks: 50,
      landingPageViews: 40,
      addToCart: 10,
      initiateCheckout: 5,
      purchases: 40,
      purchaseValueMinorUnits: 400000,
    },
    windowMetrics: {} as never,
    stats: {
      purchasesInterval: { intervalLow: null, intervalHigh: null },
      metaRoas: {
        intervalLow: null,
        intervalHigh: null,
        verdict: "ABOVE_TARGET",
        verdictReasonCode: null,
      },
      metaRoasShrunk: null,
      shopifyRoas: {
        intervalLow: null,
        intervalHigh: null,
        verdict: null,
        verdictReasonCode: null,
      },
      shopifyRoasShrunk: null,
      cpa: {
        intervalLow: null,
        intervalHigh: null,
        verdict: "BELOW_TARGET",
        verdictReasonCode: null,
      },
    },
    isDelivering: true,
    ...overrides,
  };
}

describe("decideSystemStrategy", () => {
  it("picks the eligible candidate with the highest confidence", () => {
    const low = evidence({
      adsetId: "as_low",
      meta: { ...evidence({ adsetId: "x" }).meta, purchases: 31 },
    });
    const high = evidence({
      adsetId: "as_high",
      meta: { ...evidence({ adsetId: "x" }).meta, purchases: 90 },
    });
    const rec = decideSystemStrategy([low, high], CANON, 30);
    expect(rec.recommendation).toBe("INCREASE_BUDGET");
    expect(rec.decisionUnit).toEqual({ type: "ADSET", id: "as_high" });
    expect(rec.changePercent).not.toBeNull();
    const changePercent = rec.changePercent as number;
    expect(changePercent).toBeGreaterThanOrEqual(5);
    expect(changePercent).toBeLessThanOrEqual(15); // D1's own safe range ceiling
    expect(rec.confidence).not.toBeNull();
    expect(rec.guardrailRejected).toBe(false);
  });

  it("returns INSUFFICIENT_DATA when nothing clears the eligibility gate", () => {
    const notDelivering = evidence({ adsetId: "as_dead", isDelivering: false });
    const belowTarget = evidence({
      adsetId: "as_bad",
      stats: {
        ...evidence({ adsetId: "x" }).stats,
        metaRoas: {
          intervalLow: null,
          intervalHigh: null,
          verdict: "BELOW_TARGET",
          verdictReasonCode: null,
        },
      },
    });
    const rec = decideSystemStrategy([notDelivering, belowTarget], CANON, 30);
    expect(rec.recommendation).toBe("INSUFFICIENT_DATA");
    expect(rec.decisionUnit).toBeNull();
    expect(rec.confidence).toBeNull();
  });

  it("returns INSUFFICIENT_DATA with no candidates at all", () => {
    const rec = decideSystemStrategy([], CANON, 30);
    expect(rec.recommendation).toBe("INSUFFICIENT_DATA");
    expect(rec.decisionUnit).toBeNull();
  });
});

describe("decideNaiveHighestRecentRoas — §29 criterion 10's own baseline", () => {
  it("picks whichever delivering ad set has the highest RAW ROAS, ignoring purchase floor and significance entirely", () => {
    // Deliberately a LOW-volume ad set (2 purchases — would fail D1's eligibility floor) with a
    // higher raw ROAS than a high-volume, well-measured one. The naive strategy must still pick
    // the low-volume one — that is the whole point of it being naive.
    const lowVolumeHighRoas = evidence({
      adsetId: "as_lowvol",
      meta: {
        currency: "INR",
        attribution: null,
        spendMinorUnits: 1000,
        impressions: 100,
        reach: 90,
        clicks: 10,
        landingPageViews: 8,
        addToCart: 2,
        initiateCheckout: 1,
        purchases: 2,
        purchaseValueMinorUnits: 20000, // 20x ROAS off two purchases
      },
    });
    const highVolumeLowerRoas = evidence({
      adsetId: "as_highvol",
      meta: {
        currency: "INR",
        attribution: null,
        spendMinorUnits: 500000,
        impressions: 50000,
        reach: 40000,
        clicks: 2000,
        landingPageViews: 1800,
        addToCart: 400,
        initiateCheckout: 200,
        purchases: 200,
        purchaseValueMinorUnits: 2000000, // 4x ROAS
      },
    });
    const rec = decideNaiveHighestRecentRoas([lowVolumeHighRoas, highVolumeLowerRoas], 20);
    expect(rec.decisionUnit).toEqual({ type: "ADSET", id: "as_lowvol" });
    expect(rec.recommendation).toBe("INCREASE_BUDGET");
    expect(rec.changePercent).toBe(20);
    expect(rec.confidence).toBeNull(); // naive makes no calibrated claim
  });

  it("returns INSUFFICIENT_DATA when nothing has spend", () => {
    const dead = evidence({
      adsetId: "as_dead",
      isDelivering: false,
      meta: { ...evidence({ adsetId: "x" }).meta, spendMinorUnits: 0, purchases: 0 },
    });
    const rec = decideNaiveHighestRecentRoas([dead], 20);
    expect(rec.recommendation).toBe("INSUFFICIENT_DATA");
    expect(rec.decisionUnit).toBeNull();
  });
});
