import { describe, expect, it } from "vitest";
import type { MetaInsightsDaily } from "@shared/schema/index.ts";
import { normalizeMetaInsightsDailyRow } from "./metaNormalize.ts";

const ROW: MetaInsightsDaily = {
  adId: "ad_1",
  adsetId: "as_1",
  campaignId: "cmp_1",
  accountId: "act_1",
  date: "2026-08-25",
  attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
  spendMinorUnits: 102067,
  currency: "INR",
  impressions: 2330,
  reach: 1900,
  frequency: 1.22,
  clicks: 151,
  landingPageViews: 120,
  addToCart: 12,
  initiateCheckout: 1,
  purchases: 2,
  purchaseValueMinorUnits: 500000,
  sourceUpdatedAt: new Date("2026-08-26T02:00:00Z"),
  fetchedAt: new Date("2026-08-26T02:00:00Z"),
};

const CTX = {
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  nativeTimezone: "Asia/Kolkata",
  computedAt: new Date("2026-08-31T00:00:00Z"),
};

describe("normalizeMetaInsightsDailyRow", () => {
  it("carries every non-day, non-currency field through unchanged", () => {
    const result = normalizeMetaInsightsDailyRow(ROW, CTX);
    expect(result.adId).toBe(ROW.adId);
    expect(result.adsetId).toBe(ROW.adsetId);
    expect(result.campaignId).toBe(ROW.campaignId);
    expect(result.accountId).toBe(ROW.accountId);
    expect(result.impressions).toBe(ROW.impressions);
    expect(result.reach).toBe(ROW.reach);
    expect(result.frequency).toBe(ROW.frequency);
    expect(result.clicks).toBe(ROW.clicks);
    expect(result.landingPageViews).toBe(ROW.landingPageViews);
    expect(result.addToCart).toBe(ROW.addToCart);
    expect(result.initiateCheckout).toBe(ROW.initiateCheckout);
    expect(result.purchases).toBe(ROW.purchases);
    expect(result.sourceUpdatedAt).toEqual(ROW.sourceUpdatedAt);
  });

  it("carries attribution provenance through intact, never re-derived (§5.3)", () => {
    const result = normalizeMetaInsightsDailyRow(ROW, CTX);
    expect(result.attribution).toEqual(ROW.attribution);
  });

  it("stamps the timezone used, and remaps the native day onto the reporting day", () => {
    const result = normalizeMetaInsightsDailyRow(ROW, CTX);
    expect(result.reportingTimezone).toBe("Asia/Kolkata");
    expect(result.nativeTimezone).toBe("Asia/Kolkata");
    expect(result.nativeDate).toBe("2026-08-25");
    expect(result.reportingDay).toBe("2026-08-25"); // identity: native tz === reporting tz
  });

  it("normalizes spend and purchaseValue to Money-with-fx, recording a 1:1 rate in the identity case", () => {
    const result = normalizeMetaInsightsDailyRow(ROW, CTX);
    expect(result.spend).toEqual({
      amountMinorUnits: 102067,
      currency: "INR",
      sourceAmountMinorUnits: 102067,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    });
    expect(result.purchaseValue.amountMinorUnits).toBe(500000);
    expect(result.purchaseValue.fxRateToReportingCurrency).toBe(1);
  });

  it("stamps computedAt from ctx, not the source row's own timestamps", () => {
    const result = normalizeMetaInsightsDailyRow(ROW, CTX);
    expect(result.computedAt).toEqual(CTX.computedAt);
  });

  it("throws if the source currency genuinely differs from the reporting currency (no FX provider)", () => {
    expect(() =>
      normalizeMetaInsightsDailyRow(
        { ...ROW, currency: "USD" },
        { ...CTX, reportingCurrency: "INR" },
      ),
    ).toThrow();
  });
});
