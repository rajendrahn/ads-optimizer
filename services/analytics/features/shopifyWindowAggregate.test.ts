import { describe, expect, it } from "vitest";
import type {
  NormalizedMoney,
  ReportingDay,
  ShopifyDailyCoverage,
  ShopifyOrderNormalized,
  ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import { aggregateShopifyWindow } from "./shopifyWindowAggregate.ts";

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

function order(
  overrides: Partial<ShopifyOrderNormalized> & { orderId: string; reportingDay: ReportingDay },
): ShopifyOrderNormalized {
  return {
    reportingTimezone: "Asia/Kolkata",
    nativeCreatedAt: new Date("2026-08-25T00:00:00Z"),
    totalPrice: money(500000),
    subtotalPrice: money(500000),
    totalDiscounts: money(0),
    totalShipping: null,
    isNewCustomer: false,
    country: "IN",
    customerId: "cust_1",
    resolvedAdId: null,
    resolvedCampaignId: null,
    resolutionMethod: "AD_ID",
    resolutionConfidence: 1,
    source: "GRAPHQL_SYNC",
    sourceUpdatedAt: new Date("2026-08-25T00:00:00Z"),
    computedAt: new Date("2026-08-31T00:00:00Z"),
    ...overrides,
  };
}

function refund(
  overrides: Partial<ShopifyRefundNormalized> & {
    orderId: string;
    refundId: string;
    reportingDay: ReportingDay;
  },
): ShopifyRefundNormalized {
  return {
    reportingTimezone: "Asia/Kolkata",
    nativeCreatedAt: new Date("2026-08-26T00:00:00Z"),
    amount: money(10000),
    reason: null,
    sourceUpdatedAt: new Date("2026-08-26T00:00:00Z"),
    computedAt: new Date("2026-08-31T00:00:00Z"),
    ...overrides,
  };
}

function coverageRow(day: ReportingDay, hasCoverageGap: boolean): ShopifyDailyCoverage {
  return {
    reportingDay: day,
    reportingTimezone: "Asia/Kolkata",
    accountId: "act_1",
    hasCoverageGap,
    gapReason: hasCoverageGap ? "Matrixify backfill / read_orders window do not overlap" : null,
    ordersObserved: 0,
    refundsObserved: 0,
    computedAt: new Date("2026-08-31T00:00:00Z"),
    sourceUpdatedAt: new Date("2026-08-31T00:00:00Z"),
  };
}

const WINDOW = { startDay: "2026-08-24" as ReportingDay, endDay: "2026-08-30" as ReportingDay };
const FULLY_COVERED = new Map(
  [
    "2026-08-24",
    "2026-08-25",
    "2026-08-26",
    "2026-08-27",
    "2026-08-28",
    "2026-08-29",
    "2026-08-30",
  ].map((d) => [d as ReportingDay, coverageRow(d as ReportingDay, false)]),
);

describe("aggregateShopifyWindow", () => {
  it("sums orders and refunds correctly and marks no gap when every day is covered", () => {
    const orders = [
      order({
        orderId: "o1",
        reportingDay: "2026-08-25",
        totalPrice: money(300000),
        isNewCustomer: true,
      }),
      order({ orderId: "o2", reportingDay: "2026-08-26", totalPrice: money(200000) }),
    ];
    const refunds = [refund({ orderId: "o1", refundId: "r1", reportingDay: "2026-08-27" })];

    const result = aggregateShopifyWindow(orders, refunds, FULLY_COVERED, WINDOW, CURRENCY);

    expect(result.windowHasDataGap).toBe(false);
    expect(result.gapDays).toEqual([]);
    expect(result.value).toEqual({
      currency: CURRENCY,
      ordersCount: 2,
      newCustomerOrdersCount: 1,
      grossRevenueMinorUnits: 500000,
      refundsAmountMinorUnits: 10000,
      netRevenueMinorUnits: 490000,
    });
  });

  it("a genuine zero (no orders, fully covered window) is NOT a gap", () => {
    const result = aggregateShopifyWindow([], [], FULLY_COVERED, WINDOW, CURRENCY);
    expect(result.windowHasDataGap).toBe(false);
    expect(result.value.ordersCount).toBe(0);
    expect(result.value.netRevenueMinorUnits).toBe(0);
  });

  it("flags the window when ANY day inside it has hasCoverageGap:true, even with real orders present", () => {
    const coverage = new Map(FULLY_COVERED);
    coverage.set("2026-08-26" as ReportingDay, coverageRow("2026-08-26" as ReportingDay, true));

    const orders = [order({ orderId: "o1", reportingDay: "2026-08-25" })];
    const result = aggregateShopifyWindow(orders, [], coverage, WINDOW, CURRENCY);

    expect(result.windowHasDataGap).toBe(true);
    expect(result.gapDays).toEqual(["2026-08-26"]);
    // The number is still returned, not suppressed or zeroed — flagged, not hidden (C2's own
    // "do not suppress or zero the numbers; flag them" requirement).
    expect(result.value.ordersCount).toBe(1);
  });

  it("treats a MISSING coverage row as a gap, not as 'must be fine' — the fail-safe default", () => {
    const partialCoverage = new Map(FULLY_COVERED);
    partialCoverage.delete("2026-08-24" as ReportingDay);

    const result = aggregateShopifyWindow([], [], partialCoverage, WINDOW, CURRENCY);
    expect(result.windowHasDataGap).toBe(true);
    expect(result.gapDays).toEqual(["2026-08-24"]);
  });

  it("throws on an order whose currency does not match the reporting currency", () => {
    const badOrder = order({
      orderId: "o1",
      reportingDay: "2026-08-25",
      totalPrice: { ...money(1000), currency: "USD" },
    });
    expect(() => aggregateShopifyWindow([badOrder], [], FULLY_COVERED, WINDOW, CURRENCY)).toThrow(
      /currency/,
    );
  });
});
