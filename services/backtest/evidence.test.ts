import { describe, expect, it } from "vitest";
import type { MetaInsightsDailyNormalized } from "@shared/schema/index.ts";
import {
  buildAdSetWindowEvidence,
  computeAccountMetaMeans,
  groupMetaRowsByAdset,
} from "./evidence.ts";

const ATTRIBUTION = { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" };

function row(overrides: Partial<MetaInsightsDailyNormalized>): MetaInsightsDailyNormalized {
  return {
    adId: "ad_1",
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: "act_test",
    reportingDay: "2026-08-01",
    reportingTimezone: "Asia/Kolkata",
    nativeDate: "2026-08-01",
    nativeTimezone: "Asia/Kolkata",
    attribution: ATTRIBUTION,
    spend: {
      amountMinorUnits: 100000,
      currency: "INR",
      sourceAmountMinorUnits: 100000,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    purchaseValue: {
      amountMinorUnits: 400000,
      currency: "INR",
      sourceAmountMinorUnits: 400000,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    impressions: 1000,
    reach: 800,
    frequency: 1.25,
    clicks: 50,
    landingPageViews: 40,
    addToCart: 10,
    initiateCheckout: 5,
    purchases: 4,
    sourceUpdatedAt: new Date("2026-08-01T12:00:00Z"),
    computedAt: new Date("2026-08-30T00:00:00Z"),
    ...overrides,
  };
}

describe("groupMetaRowsByAdset", () => {
  it("groups rows by their own adsetId", () => {
    const rows = [row({ adsetId: "as_1" }), row({ adsetId: "as_2" }), row({ adsetId: "as_1" })];
    const grouped = groupMetaRowsByAdset(rows);
    expect(grouped.get("as_1")).toHaveLength(2);
    expect(grouped.get("as_2")).toHaveLength(1);
  });
});

describe("buildAdSetWindowEvidence — reuses C2/C3's real aggregation+statistics unchanged", () => {
  it("computes a real metaRoas/cpa verdict for a well-above-target, well-above-floor ad set", () => {
    const window = { startDay: "2026-07-05", endDay: "2026-08-01" };
    // 40 purchases at 4x ROAS in the primary window — comfortably above a 30-purchase floor and
    // a 3.0 target.
    const rows: MetaInsightsDailyNormalized[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(
        row({
          reportingDay: "2026-08-01",
          spend: {
            amountMinorUnits: 10000,
            currency: "INR",
            sourceAmountMinorUnits: 10000,
            sourceCurrency: "INR",
            fxRateToReportingCurrency: 1,
            fxRateSource: "same_currency_no_conversion",
          },
          purchaseValue: {
            amountMinorUnits: 40000,
            currency: "INR",
            sourceAmountMinorUnits: 40000,
            sourceCurrency: "INR",
            fxRateToReportingCurrency: 1,
            fxRateSource: "same_currency_no_conversion",
          },
          purchases: 1,
        }),
      );
    }
    const accountMeans = computeAccountMetaMeans(rows, window, "INR");
    const evidence = buildAdSetWindowEvidence({
      adsetId: "as_1",
      rows,
      window,
      reportingCurrency: "INR",
      accountMeans,
      thresholds: {
        minPurchaseFloor: 30,
        targetRoas: 3.0,
        targetCpaMinorUnits: 150000,
        intervalZScore: 1.645,
      },
    });

    expect(evidence.isDelivering).toBe(true);
    expect(evidence.meta.purchases).toBe(40);
    expect(evidence.stats.metaRoas.verdict).toBe("ABOVE_TARGET");
    expect(evidence.stats.cpa.verdict).toBe("BELOW_TARGET"); // cpa = 10000/1 = well below 150000 target
  });

  it("marks a below-floor ad set NOT_DISTINGUISHABLE even with a high raw ROAS", () => {
    const window = { startDay: "2026-07-05", endDay: "2026-08-01" };
    const rows = [
      row({
        reportingDay: "2026-08-01",
        purchases: 2,
        spend: {
          amountMinorUnits: 1000,
          currency: "INR",
          sourceAmountMinorUnits: 1000,
          sourceCurrency: "INR",
          fxRateToReportingCurrency: 1,
          fxRateSource: "same_currency_no_conversion",
        },
        purchaseValue: {
          amountMinorUnits: 10000,
          currency: "INR",
          sourceAmountMinorUnits: 10000,
          sourceCurrency: "INR",
          fxRateToReportingCurrency: 1,
          fxRateSource: "same_currency_no_conversion",
        },
      }),
    ];
    const accountMeans = computeAccountMetaMeans(rows, window, "INR");
    const evidence = buildAdSetWindowEvidence({
      adsetId: "as_low",
      rows,
      window,
      reportingCurrency: "INR",
      accountMeans,
      thresholds: {
        minPurchaseFloor: 30,
        targetRoas: 3.0,
        targetCpaMinorUnits: 150000,
        intervalZScore: 1.645,
      },
    });
    expect(evidence.stats.metaRoas.verdict).toBe("NOT_DISTINGUISHABLE");
    expect(evidence.stats.metaRoas.verdictReasonCode).toBe("BELOW_FLOOR");
  });

  it("isDelivering is false for an ad set with zero spend and zero impressions", () => {
    const window = { startDay: "2026-07-05", endDay: "2026-08-01" };
    const evidence = buildAdSetWindowEvidence({
      adsetId: "as_dead",
      rows: [],
      window,
      reportingCurrency: "INR",
      accountMeans: { metaRoas: null, shopifyRoas: null },
      thresholds: {
        minPurchaseFloor: 30,
        targetRoas: 3.0,
        targetCpaMinorUnits: 150000,
        intervalZScore: 1.645,
      },
    });
    expect(evidence.isDelivering).toBe(false);
  });
});
