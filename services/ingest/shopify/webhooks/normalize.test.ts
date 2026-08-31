import { describe, expect, it } from "vitest";
import {
  normalizeWebhookOrder,
  normalizeWebhookRefund,
  refundAmountMinorUnits,
  resolveRefundCurrency,
  type RawWebhookOrderPayload,
  type RawWebhookOrderRefund,
} from "./normalize.ts";

const CTX = { syncedAt: new Date("2026-08-30T12:00:00Z") };

function baseOrder(overrides: Partial<RawWebhookOrderPayload> = {}): RawWebhookOrderPayload {
  return {
    id: 6489142231355,
    name: "#1001",
    order_number: 1001,
    created_at: "2026-08-15T10:00:00+05:30",
    updated_at: "2026-08-16T11:00:00+05:30",
    cancelled_at: null,
    currency: "INR",
    financial_status: "paid",
    fulfillment_status: "fulfilled",
    customer: { id: 9231937929531 },
    billing_address: { country_code: "IN" },
    shipping_address: { country_code: "IN" },
    subtotal_price: "1499.00",
    total_discounts: "0.00",
    total_price: "1499.00",
    total_shipping_price_set: null,
    shipping_lines: [],
    landing_site: "/products/temple-set?utm_source=meta&utm_campaign=123",
    referring_site: "https://www.instagram.com/",
    line_items: [
      {
        id: 14000000001,
        product_id: 8000000001,
        variant_id: 44000000001,
        sku: "TMP-001",
        title: "Temple Bridal Set",
        quantity: 1,
        price: "1499.00",
      },
    ],
    refunds: [],
    ...overrides,
  };
}

describe("normalizeWebhookOrder", () => {
  it("normalizes a real-shaped orders/create payload into order + lines", () => {
    const { order, lines, refunds } = normalizeWebhookOrder(baseOrder(), CTX);

    expect(order.orderId).toBe("6489142231355");
    expect(order.orderNumber).toBe("#1001");
    expect(order.currency).toBe("INR");
    expect(order.totalPriceMinorUnits).toBe(149_900);
    expect(order.subtotalPriceMinorUnits).toBe(149_900);
    expect(order.totalDiscountsMinorUnits).toBe(0);
    expect(order.financialStatus).toBe("paid");
    expect(order.fulfillmentStatus).toBe("fulfilled");
    expect(order.customerId).toBe("9231937929531");
    expect(order.country).toBe("IN");
    expect(order.isNewCustomer).toBeNull(); // deferred to newVsRepeat's recompute pass
    expect(order.rawAttributionTag).toBeNull(); // B7's job, not B6's
    expect(order.resolvedAdId).toBeNull();
    expect(order.source).toBe("WEBHOOK");
    expect(order.syncedAt).toEqual(CTX.syncedAt);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      orderId: "6489142231355",
      lineItemId: "14000000001",
      productId: "8000000001",
      variantId: "44000000001",
      sku: "TMP-001",
      quantity: 1,
      priceMinorUnits: 149_900,
      // A webhook order payload carries no product tags/type — see normalize.ts's comment.
      productTags: null,
      productType: null,
    });

    expect(refunds).toHaveLength(0);
  });

  it("captures landingSite/referringSite verbatim — the field B5 flagged as unavailable via GraphQL", () => {
    const { order } = normalizeWebhookOrder(baseOrder(), CTX);
    expect(order.landingSite).toBe("/products/temple-set?utm_source=meta&utm_campaign=123");
    expect(order.referringSite).toBe("https://www.instagram.com/");
  });

  it("nulls landingSite/referringSite when the payload doesn't carry them, rather than guessing", () => {
    const { order } = normalizeWebhookOrder(
      baseOrder({ landing_site: undefined, referring_site: undefined }),
      CTX,
    );
    expect(order.landingSite).toBeNull();
    expect(order.referringSite).toBeNull();
  });

  it("sets cancelledAt/financialStatus for an orders/cancelled-shaped payload", () => {
    const { order } = normalizeWebhookOrder(
      baseOrder({
        cancelled_at: "2026-08-17T09:00:00+05:30",
        financial_status: "voided",
        fulfillment_status: null,
      }),
      CTX,
    );
    expect(order.cancelledAt).toEqual(new Date("2026-08-17T09:00:00+05:30"));
    expect(order.financialStatus).toBe("voided");
    expect(order.fulfillmentStatus).toBeNull();
  });

  it("prefers total_shipping_price_set when present over summing shipping_lines", () => {
    const { order } = normalizeWebhookOrder(
      baseOrder({
        total_shipping_price_set: { shop_money: { amount: "99.00", currency_code: "INR" } },
        shipping_lines: [{ price: "40.00" }, { price: "10.00" }],
      }),
      CTX,
    );
    expect(order.totalShippingMinorUnits).toBe(9_900);
  });

  it("falls back to summing shipping_lines when total_shipping_price_set is absent", () => {
    const { order } = normalizeWebhookOrder(
      baseOrder({
        total_shipping_price_set: null,
        shipping_lines: [{ price: "40.00" }, { price: "10.00" }],
      }),
      CTX,
    );
    expect(order.totalShippingMinorUnits).toBe(5_000);
  });

  it("nulls shipping when neither source is present, rather than defaulting to zero", () => {
    const { order } = normalizeWebhookOrder(
      baseOrder({ total_shipping_price_set: null, shipping_lines: [] }),
      CTX,
    );
    expect(order.totalShippingMinorUnits).toBeNull();
  });

  it("treats a null customer as a null customerId (e.g. a cancelled draft order, per B5's precedent)", () => {
    const { order } = normalizeWebhookOrder(baseOrder({ customer: null }), CTX);
    expect(order.customerId).toBeNull();
  });

  it("normalizes embedded refunds using the order's own currency", () => {
    const refund: RawWebhookOrderRefund = {
      id: 900000001,
      created_at: "2026-08-18T10:00:00+05:30",
      transactions: [{ amount: "500.00", kind: "refund", status: "success", currency: "INR" }],
    };
    const { refunds } = normalizeWebhookOrder(baseOrder({ refunds: [refund] }), CTX);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      orderId: "6489142231355",
      refundId: "900000001",
      amountMinorUnits: 50_000,
      currency: "INR",
      reason: null,
    });
  });

  it("falls back to name for orderNumber when order_number is absent, and vice versa", () => {
    const { order: withName } = normalizeWebhookOrder(
      baseOrder({ name: "#77", order_number: null }),
      CTX,
    );
    expect(withName.orderNumber).toBe("#77");

    const { order: withNumberOnly } = normalizeWebhookOrder(
      baseOrder({ name: null, order_number: 88 }),
      CTX,
    );
    expect(withNumberOnly.orderNumber).toBe("88");
  });
});

describe("refundAmountMinorUnits", () => {
  it("sums successful refund-kind transactions", () => {
    const refund: RawWebhookOrderRefund = {
      id: 1,
      created_at: "2026-08-18T10:00:00Z",
      transactions: [
        { amount: "300.00", kind: "refund", status: "success" },
        { amount: "200.00", kind: "refund", status: "success" },
        { amount: "500.00", kind: "sale", status: "success" }, // not a refund — ignored
        { amount: "999.00", kind: "refund", status: "failure" }, // failed — ignored
      ],
    };
    expect(refundAmountMinorUnits(refund, "INR")).toBe(50_000);
  });

  it("falls back to refund_line_items subtotal+tax when no successful refund transaction exists", () => {
    const refund: RawWebhookOrderRefund = {
      id: 2,
      created_at: "2026-08-18T10:00:00Z",
      transactions: [],
      refund_line_items: [
        { subtotal: "100.00", total_tax: "18.00" },
        { subtotal: "50.00", total_tax: "9.00" },
      ],
    };
    expect(refundAmountMinorUnits(refund, "INR")).toBe(17_700);
  });

  it("returns 0 for a refund with no transactions and no line items (e.g. a pure note/restock event)", () => {
    const refund: RawWebhookOrderRefund = { id: 3, created_at: "2026-08-18T10:00:00Z" };
    expect(refundAmountMinorUnits(refund, "INR")).toBe(0);
  });
});

describe("resolveRefundCurrency", () => {
  it("resolves from a transaction's own currency field", () => {
    const refund: RawWebhookOrderRefund = {
      id: 1,
      created_at: "2026-08-18T10:00:00Z",
      transactions: [{ amount: "10.00", kind: "refund", status: "success", currency: "INR" }],
    };
    expect(resolveRefundCurrency(refund)).toBe("INR");
  });

  it("falls back to a refund line item's subtotal_set currency_code when no transaction carries one", () => {
    const refund: RawWebhookOrderRefund = {
      id: 2,
      created_at: "2026-08-18T10:00:00Z",
      refund_line_items: [
        {
          subtotal: "10.00",
          total_tax: "1.00",
          subtotal_set: { shop_money: { amount: "10.00", currency_code: "INR" } },
        },
      ],
    };
    expect(resolveRefundCurrency(refund)).toBe("INR");
  });

  it("returns null when neither source carries a currency, rather than guessing", () => {
    const refund: RawWebhookOrderRefund = { id: 3, created_at: "2026-08-18T10:00:00Z" };
    expect(resolveRefundCurrency(refund)).toBeNull();
  });
});

describe("normalizeWebhookRefund", () => {
  it("normalizes a standalone refunds/create-shaped payload", () => {
    const refund = normalizeWebhookRefund(
      {
        id: 900000002,
        created_at: "2026-08-19T08:00:00+05:30",
        transactions: [{ amount: "250.50", kind: "refund", status: "success", currency: "INR" }],
      },
      "6489142231355",
      "INR",
      CTX,
    );
    expect(refund).toMatchObject({
      orderId: "6489142231355",
      refundId: "900000002",
      amountMinorUnits: 25_050,
      currency: "INR",
      reason: null,
    });
    expect(refund.sourceUpdatedAt).toEqual(refund.createdAt); // refunds are immutable
  });
});
