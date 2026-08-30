import { describe, expect, it } from "vitest";
import { normalizeMatrixifyOrderGroup } from "./csvNormalize.ts";
import type { MatrixifyOrderGroup, MatrixifyRow } from "./csvParser.ts";

const SYNCED_AT = new Date("2026-08-30T00:00:00Z");

/** Builds a full-column row like the real export, with sensible blanks, overridden by `over`. */
function row(over: Partial<MatrixifyRow>): MatrixifyRow {
  return {
    ID: "6489142231355",
    Name: "#1001",
    "Created At": "2025-01-15 14:27:06 +0530",
    "Updated At": "2025-01-15 14:48:50 +0530",
    "Cancelled At": "",
    "Cancel: Reason": "",
    Currency: "INR",
    Source: "web",
    "Source Identifier": "",
    "Source URL": "",
    "Price: Subtotal": "",
    "Price: Total Discount": "",
    "Price: Total Shipping": "",
    "Price: Total Refund": "",
    "Price: Total": "",
    "Payment: Status": "refunded",
    "Customer: ID": "9231937929531",
    "Billing: Country Code": "IN",
    "Shipping: Country Code": "IN",
    "Browser: Landing Page": "",
    "Browser: Referrer": "",
    "Line: Type": "",
    "Line: Product ID": "",
    "Line: Title": "",
    "Line: Variant ID": "",
    "Line: SKU": "",
    "Line: Quantity": "",
    "Line: Price": "",
    "Line: Discount": "",
    "Line: Total": "",
    "Line: Product Type": "",
    "Line: Product Tags": "",
    "Refund: ID": "",
    "Refund: Created At": "",
    ...over,
  };
}

describe("normalizeMatrixifyOrderGroup", () => {
  it("normalizes a full order: line item + shipping + refund, mirroring the real export", () => {
    const group: MatrixifyOrderGroup = {
      orderId: "6489142231355",
      rows: [
        row({
          "Price: Subtotal": "4580.00",
          "Price: Total Discount": "0.00",
          "Price: Total Shipping": "0.00",
          "Price: Total": "5404.40",
          "Browser: Landing Page": "/cart/49676151030075:1",
          "Browser: Referrer": "https://admin.shopify.com/",
          "Line: Type": "Line Item",
          "Line: Title": "Beautiful gutta pusalu haram with kemp and cz stones",
          "Line: Quantity": "1",
          "Line: Price": "4580.00",
          "Line: Discount": "0.00",
          "Line: Total": "4580.00",
        }),
        row({
          "Browser: Landing Page": "/cart/49676151030075:1",
          "Browser: Referrer": "https://admin.shopify.com/",
          "Line: Type": "Shipping Line",
          "Line: Title": "Standard",
          "Line: Price": "0.00",
          "Line: Total": "0.00",
        }),
        row({
          "Browser: Landing Page": "/cart/49676151030075:1",
          "Browser: Referrer": "https://admin.shopify.com/",
          "Line: Type": "Refund Line",
          "Line: Title": "Beautiful gutta pusalu haram with kemp and cz stones",
          "Line: Quantity": "-1",
          "Line: Price": "4580.00",
          "Line: Discount": "0.00",
          "Line: Total": "-4580.00",
          "Refund: ID": "987103330619",
          "Refund: Created At": "2025-01-15 14:48:49 +0530",
        }),
      ],
    };

    const { order, lines, refunds } = normalizeMatrixifyOrderGroup(group, { syncedAt: SYNCED_AT });

    expect(order.orderId).toBe("6489142231355");
    expect(order.orderNumber).toBe("#1001");
    expect(order.currency).toBe("INR");
    expect(order.totalPriceMinorUnits).toBe(540_440);
    expect(order.subtotalPriceMinorUnits).toBe(458_000);
    expect(order.totalDiscountsMinorUnits).toBe(0);
    expect(order.totalShippingMinorUnits).toBe(0);
    expect(order.financialStatus).toBe("refunded");
    expect(order.customerId).toBe("9231937929531");
    expect(order.country).toBe("IN");
    expect(order.landingSite).toBe("/cart/49676151030075:1");
    expect(order.referringSite).toBe("https://admin.shopify.com/");
    expect(order.isNewCustomer).toBeNull();
    expect(order.rawAttributionTag).toBeNull();
    expect(order.resolvedAdId).toBeNull();
    expect(order.source).toBe("MATRIXIFY_IMPORT");
    expect(order.createdAt.toISOString()).toBe("2025-01-15T08:57:06.000Z");
    expect(order.sourceUpdatedAt.toISOString()).toBe("2025-01-15T09:18:50.000Z");

    // Only the "Line Item" row becomes a shopifyOrderLines doc — shipping/refund rows don't.
    expect(lines).toHaveLength(1);
    expect(lines[0].lineItemId).toBe("csvline-1");
    expect(lines[0].title).toBe("Beautiful gutta pusalu haram with kemp and cz stones");
    expect(lines[0].quantity).toBe(1);
    expect(lines[0].priceMinorUnits).toBe(458_000);
    expect(lines[0].sourceUpdatedAt.toISOString()).toBe(order.sourceUpdatedAt.toISOString());

    expect(refunds).toHaveLength(1);
    expect(refunds[0].refundId).toBe("987103330619");
    expect(refunds[0].amountMinorUnits).toBe(458_000);
    expect(refunds[0].createdAt.toISOString()).toBe("2025-01-15T09:18:49.000Z");
    expect(refunds[0].sourceUpdatedAt.toISOString()).toBe(refunds[0].createdAt.toISOString());
  });

  it("groups two separate refund events (Refund: ID) into two refund docs", () => {
    const group: MatrixifyOrderGroup = {
      orderId: "6604680298811",
      rows: [
        row({
          "Price: Subtotal": "1450.00",
          "Price: Total Discount": "0.00",
          "Price: Total Shipping": "199.00",
          "Price: Total": "1649.00",
          "Line: Type": "Line Item",
          "Line: Title": "Mango and flower designed ear chain with stones",
          "Line: Quantity": "1",
          "Line: Price": "1450.00",
          "Line: Total": "1450.00",
        }),
        row({
          "Line: Type": "Refund Shipping",
          "Line: Price": "199.00",
          "Line: Total": "-199.00",
          "Refund: ID": "993078018363",
          "Refund: Created At": "2025-04-03 18:19:43 +0530",
        }),
        row({
          "Line: Type": "Refund Line",
          "Line: Title": "Mango and flower designed ear chain with stones",
          "Line: Quantity": "-1",
          "Line: Total": "-1450.00",
          "Refund: ID": "993078214971",
          "Refund: Created At": "2025-04-03 18:22:11 +0530",
        }),
      ],
    };

    const { refunds } = normalizeMatrixifyOrderGroup(group, { syncedAt: SYNCED_AT });
    expect(refunds).toHaveLength(2);
    const byId = new Map(refunds.map((r) => [r.refundId, r]));
    expect(byId.get("993078018363")?.amountMinorUnits).toBe(19_900);
    expect(byId.get("993078214971")?.amountMinorUnits).toBe(145_000);
  });

  it("skips Discount-type rows entirely (no order line, absorbed into totalDiscountsMinorUnits)", () => {
    const group: MatrixifyOrderGroup = {
      orderId: "6558604788027",
      rows: [
        row({
          "Price: Subtotal": "1000.00",
          "Price: Total Discount": "206.50",
          "Price: Total Shipping": "0.00",
          "Price: Total": "793.50",
          "Line: Type": "Line Item",
          "Line: Title": "Something",
          "Line: Quantity": "1",
          "Line: Price": "1000.00",
          "Line: Total": "1000.00",
        }),
        row({
          "Line: Type": "Discount",
          "Line: Title": "fixed_amount",
          "Line: Discount": "-206.50",
          "Line: Total": "-206.50",
        }),
      ],
    };
    const { order, lines, refunds } = normalizeMatrixifyOrderGroup(group, { syncedAt: SYNCED_AT });
    expect(lines).toHaveLength(1);
    expect(refunds).toHaveLength(0);
    expect(order.totalDiscountsMinorUnits).toBe(20_650);
  });

  it("handles an order with no Customer: ID (draft order cancelled before assignment)", () => {
    const group: MatrixifyOrderGroup = {
      orderId: "6618759561531",
      rows: [
        row({
          "Customer: ID": "",
          "Billing: Country Code": "",
          "Shipping: Country Code": "",
          "Cancelled At": "2025-04-09 18:27:44 +0530",
          "Cancel: Reason": "customer",
          "Payment: Status": "pending",
          "Price: Subtotal": "10200.00",
          "Price: Total Discount": "0.00",
          "Price: Total Shipping": "0.00",
          "Price: Total": "10200.00",
          "Line: Type": "Line Item",
          "Line: Title": "Gold alike antique pearl cluster screw bangles",
          "Line: Quantity": "2",
          "Line: Price": "2650.00",
          "Line: Total": "5300.00",
        }),
      ],
    };
    const { order } = normalizeMatrixifyOrderGroup(group, { syncedAt: SYNCED_AT });
    expect(order.customerId).toBeNull();
    expect(order.country).toBeNull();
    expect(order.cancelledAt?.toISOString()).toBe("2025-04-09T12:57:44.000Z");
  });

  it("throws if the order's Price: Total summary is missing entirely", () => {
    const group: MatrixifyOrderGroup = {
      orderId: "999",
      rows: [row({ "Line: Type": "Line Item" })],
    };
    expect(() => normalizeMatrixifyOrderGroup(group, { syncedAt: SYNCED_AT })).toThrow(
      /missing a required Price/,
    );
  });

  it("parses comma-separated product tags, dropping blanks", () => {
    const group: MatrixifyOrderGroup = {
      orderId: "1",
      rows: [
        row({
          "Price: Subtotal": "100.00",
          "Price: Total Discount": "0.00",
          "Price: Total": "100.00",
          "Line: Type": "Line Item",
          "Line: Quantity": "1",
          "Line: Price": "100.00",
          "Line: Total": "100.00",
          "Line: Product Tags": "bangle, clearance, festive",
          "Line: Product Type": "bangle",
        }),
      ],
    };
    const { lines } = normalizeMatrixifyOrderGroup(group, { syncedAt: SYNCED_AT });
    expect(lines[0].productTags).toEqual(["bangle", "clearance", "festive"]);
    expect(lines[0].productType).toBe("bangle");
  });
});
