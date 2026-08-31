import { describe, expect, it } from "vitest";
import type { ShopifyOrder, ShopifyRefund } from "@shared/schema/index.ts";
import { normalizeShopifyOrder, normalizeShopifyRefund } from "./shopifyNormalize.ts";

const CTX = {
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  computedAt: new Date("2026-08-31T00:00:00Z"),
};

const ORDER: ShopifyOrder = {
  orderId: "6628544414011",
  orderNumber: "#1681",
  createdAt: new Date("2025-04-17T00:03:50+05:30"),
  sourceUpdatedAt: new Date("2025-04-30T01:49:17+05:30"),
  currency: "INR",
  totalPriceMinorUnits: 649900,
  subtotalPriceMinorUnits: 399900,
  totalDiscountsMinorUnits: 30100,
  totalShippingMinorUnits: 250000,
  financialStatus: "paid",
  fulfillmentStatus: null,
  cancelledAt: null,
  customerId: "9000000000001",
  isNewCustomer: true,
  country: "US",
  landingSite: "/?fbclid=abc",
  referringSite: "https://l.instagram.com/",
  rawAttributionTag: null,
  resolvedAdId: null,
  resolvedCampaignId: null,
  source: "MATRIXIFY_IMPORT",
  syncedAt: new Date("2026-08-31T00:00:00Z"),
};

describe("normalizeShopifyOrder", () => {
  it("derives the reporting day straight from createdAt via toReportingDay — real midnight-boundary case", () => {
    const result = normalizeShopifyOrder(ORDER, CTX);
    // 2025-04-17T00:03:50+05:30 = 2025-04-16T18:33:50Z — a naive UTC-day read would say
    // 2025-04-16; the correct IST reporting day is 2025-04-17.
    expect(result.reportingDay).toBe("2025-04-17");
  });

  it("stamps the timezone it was computed in", () => {
    expect(normalizeShopifyOrder(ORDER, CTX).reportingTimezone).toBe("Asia/Kolkata");
  });

  it("carries PII-boundary-safe fields, attribution fields and source through unchanged", () => {
    const result = normalizeShopifyOrder(ORDER, CTX);
    expect(result.customerId).toBe(ORDER.customerId);
    expect(result.isNewCustomer).toBe(true);
    expect(result.country).toBe("US");
    expect(result.resolvedAdId).toBeNull();
    expect(result.resolvedCampaignId).toBeNull();
    expect(result.source).toBe("MATRIXIFY_IMPORT");
    expect(result.sourceUpdatedAt).toEqual(ORDER.sourceUpdatedAt);
  });

  it("normalizes every money field with a recorded 1:1 fx rate (identity case)", () => {
    const result = normalizeShopifyOrder(ORDER, CTX);
    expect(result.totalPrice).toMatchObject({
      amountMinorUnits: 649900,
      currency: "INR",
      fxRateToReportingCurrency: 1,
    });
    expect(result.subtotalPrice.amountMinorUnits).toBe(399900);
    expect(result.totalDiscounts.amountMinorUnits).toBe(30100);
    expect(result.totalShipping?.amountMinorUnits).toBe(250000);
  });

  it("leaves totalShipping null when the source order has none", () => {
    const result = normalizeShopifyOrder({ ...ORDER, totalShippingMinorUnits: null }, CTX);
    expect(result.totalShipping).toBeNull();
  });

  it("throws if the source currency genuinely differs from the reporting currency", () => {
    expect(() => normalizeShopifyOrder({ ...ORDER, currency: "USD" }, CTX)).toThrow();
  });
});

const REFUND: ShopifyRefund = {
  orderId: "6604680298811",
  refundId: "refund_1",
  createdAt: new Date("2025-05-02T10:00:00+05:30"),
  amountMinorUnits: 15000,
  currency: "INR",
  reason: "customer request",
  sourceUpdatedAt: new Date("2025-05-02T10:00:00+05:30"),
  syncedAt: new Date("2026-08-31T00:00:00Z"),
};

describe("normalizeShopifyRefund", () => {
  it("derives its OWN reporting day from its own createdAt, not its parent order's", () => {
    const result = normalizeShopifyRefund(REFUND, CTX);
    expect(result.reportingDay).toBe("2025-05-02");
    expect(result.orderId).toBe(REFUND.orderId);
    expect(result.refundId).toBe(REFUND.refundId);
  });

  it("normalizes the refund amount with a recorded fx rate", () => {
    const result = normalizeShopifyRefund(REFUND, CTX);
    expect(result.amount).toMatchObject({
      amountMinorUnits: 15000,
      currency: "INR",
      fxRateToReportingCurrency: 1,
    });
  });
});
