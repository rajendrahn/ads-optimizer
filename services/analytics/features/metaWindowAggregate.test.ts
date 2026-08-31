import { describe, expect, it } from "vitest";
import type {
  MetaInsightsDailyNormalized,
  NormalizedMoney,
  ReportingDay,
} from "@shared/schema/index.ts";
import { aggregateMetaWindow } from "./metaWindowAggregate.ts";

const CURRENCY = "INR";

function money(amountMinorUnits: number): NormalizedMoney {
  return {
    amountMinorUnits,
    currency: CURRENCY,
    sourceAmountMinorUnits: amountMinorUnits,
    sourceCurrency: CURRENCY,
    fxRateToReportingCurrency: 1,
    fxRateSource: "same_currency_no_conversion",
  };
}

function row(
  overrides: Partial<MetaInsightsDailyNormalized> & { adId: string; reportingDay: ReportingDay },
): MetaInsightsDailyNormalized {
  return {
    adsetId: "as1",
    campaignId: "c1",
    accountId: "act_1",
    reportingTimezone: "Asia/Kolkata",
    nativeDate: overrides.reportingDay,
    nativeTimezone: "Asia/Kolkata",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    spend: money(100000),
    purchaseValue: money(0),
    impressions: 1000,
    reach: 800,
    frequency: 1.25,
    clicks: 50,
    landingPageViews: 40,
    addToCart: 5,
    initiateCheckout: 2,
    purchases: 1,
    sourceUpdatedAt: new Date("2026-08-25T00:00:00Z"),
    computedAt: new Date("2026-08-31T00:00:00Z"),
    ...overrides,
  };
}

describe("aggregateMetaWindow", () => {
  it("sums every field across rows", () => {
    const rows = [
      row({
        adId: "a1",
        reportingDay: "2026-08-25",
        spend: money(100000),
        purchases: 1,
        purchaseValue: money(400000),
      }),
      row({
        adId: "a1",
        reportingDay: "2026-08-26",
        spend: money(50000),
        purchases: 0,
        purchaseValue: money(0),
      }),
    ];
    const totals = aggregateMetaWindow(rows, CURRENCY);
    expect(totals.spendMinorUnits).toBe(150000);
    expect(totals.impressions).toBe(2000);
    expect(totals.reach).toBe(1600);
    expect(totals.clicks).toBe(100);
    expect(totals.purchases).toBe(1);
    expect(totals.purchaseValueMinorUnits).toBe(400000);
  });

  it("treats a null reach as 0, not a thrown error", () => {
    const rows = [row({ adId: "a1", reportingDay: "2026-08-25", reach: null })];
    expect(aggregateMetaWindow(rows, CURRENCY).reach).toBe(0);
  });

  it("returns all-zero totals for an empty row set — a genuine zero, no special-casing needed by the caller", () => {
    const totals = aggregateMetaWindow([], CURRENCY);
    expect(totals.spendMinorUnits).toBe(0);
    expect(totals.purchases).toBe(0);
  });

  it("throws on a currency mismatch", () => {
    const badRow = row({
      adId: "a1",
      reportingDay: "2026-08-25",
      spend: { ...money(1), currency: "USD" },
    });
    expect(() => aggregateMetaWindow([badRow], CURRENCY)).toThrow(/currency/);
  });

  it("§5.3: carries attribution provenance through verbatim when every row agrees", () => {
    const rows = [
      row({ adId: "a1", reportingDay: "2026-08-25" }),
      row({ adId: "a1", reportingDay: "2026-08-26" }),
    ];
    expect(aggregateMetaWindow(rows, CURRENCY).attribution).toEqual({
      attributionWindow: "7d_click_1d_view",
      purchaseActionType: "omni_purchase",
    });
  });

  it("attribution is null for an empty row set — never defaulted", () => {
    expect(aggregateMetaWindow([], CURRENCY).attribution).toBeNull();
  });

  it("§5.3: attribution is null (never silently picked) when rows inside the window disagree", () => {
    const rows = [
      row({ adId: "a1", reportingDay: "2026-08-25" }),
      row({
        adId: "a1",
        reportingDay: "2026-08-26",
        attribution: { attributionWindow: "1d_click", purchaseActionType: "omni_purchase" },
      }),
    ];
    expect(aggregateMetaWindow(rows, CURRENCY).attribution).toBeNull();
  });
});
