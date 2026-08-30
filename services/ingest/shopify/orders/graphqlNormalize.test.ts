import { describe, expect, it } from "vitest";
import {
  normalizeGraphqlOrder,
  numericIdFromGid,
  type RawGraphqlOrderNode,
} from "./graphqlNormalize.ts";

const SYNCED_AT = new Date("2026-08-30T00:00:00Z");

describe("numericIdFromGid", () => {
  it("extracts the trailing numeric id", () => {
    expect(numericIdFromGid("gid://shopify/Order/6489142231355")).toBe("6489142231355");
    expect(numericIdFromGid("gid://shopify/LineItem/19069778198843")).toBe("19069778198843");
  });
  it("returns the input unchanged if not gid-shaped", () => {
    expect(numericIdFromGid("6489142231355")).toBe("6489142231355");
  });
});

// Shapes below mirror real live responses captured against this account's actual Shopify
// Admin API (2025-01) during B5 planning — see IMPLEMENTATION_PLAN.md B5 notes.
function realNode(over: Partial<RawGraphqlOrderNode> = {}): RawGraphqlOrderNode {
  return {
    id: "gid://shopify/Order/7674375930171",
    name: "#23008",
    createdAt: "2026-08-28T10:08:36Z",
    updatedAt: "2026-08-30T13:56:03Z",
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "INR",
    customer: { id: "gid://shopify/Customer/10436576772411" },
    billingAddress: { countryCodeV2: "AU" },
    shippingAddress: { countryCodeV2: "AU" },
    subtotalPriceSet: { shopMoney: { amount: "3598.0" } },
    totalDiscountsSet: { shopMoney: { amount: "0.0" } },
    totalShippingPriceSet: { shopMoney: { amount: "2500.0" } },
    totalPriceSet: { shopMoney: { amount: "6098.0" } },
    lineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/LineItem/19069778198843",
            title: "Exquisite Gold-Toned Necklace Set for Weddings & Festivals",
            sku: "32719",
            quantity: 1,
            product: {
              id: "gid://shopify/Product/10521502056763",
              productType: "long necklace",
              tags: ["Budgeted", "EOSS", "gold"],
            },
            variant: { id: "gid://shopify/ProductVariant/51562648240443" },
            originalUnitPriceSet: { shopMoney: { amount: "1499.0" } },
          },
        },
      ],
    },
    refunds: [],
    ...over,
  };
}

describe("normalizeGraphqlOrder", () => {
  it("normalizes a real order shape", () => {
    const { order, lines, refunds } = normalizeGraphqlOrder(realNode(), { syncedAt: SYNCED_AT });

    expect(order.orderId).toBe("7674375930171");
    expect(order.orderNumber).toBe("#23008");
    expect(order.currency).toBe("INR");
    expect(order.totalPriceMinorUnits).toBe(609_800);
    expect(order.subtotalPriceMinorUnits).toBe(359_800);
    expect(order.totalShippingMinorUnits).toBe(250_000);
    expect(order.financialStatus).toBe("paid");
    expect(order.fulfillmentStatus).toBe("fulfilled");
    expect(order.customerId).toBe("10436576772411");
    expect(order.country).toBe("AU"); // shipping preferred over billing
    expect(order.landingSite).toBeNull();
    expect(order.referringSite).toBeNull();
    expect(order.isNewCustomer).toBeNull();
    expect(order.source).toBe("GRAPHQL_SYNC");
    expect(order.createdAt.toISOString()).toBe("2026-08-28T10:08:36.000Z");
    expect(order.sourceUpdatedAt.toISOString()).toBe("2026-08-30T13:56:03.000Z");

    expect(lines).toHaveLength(1);
    expect(lines[0].lineItemId).toBe("19069778198843");
    expect(lines[0].productId).toBe("10521502056763");
    expect(lines[0].variantId).toBe("51562648240443");
    expect(lines[0].priceMinorUnits).toBe(149_900);
    expect(lines[0].productTags).toEqual(["Budgeted", "EOSS", "gold"]);
    expect(lines[0].productType).toBe("long necklace");

    expect(refunds).toHaveLength(0);
  });

  it("falls back to billing country when shipping address is absent", () => {
    const { order } = normalizeGraphqlOrder(
      realNode({ shippingAddress: null, billingAddress: { countryCodeV2: "IN" } }),
      { syncedAt: SYNCED_AT },
    );
    expect(order.country).toBe("IN");
  });

  it("handles a null customer (guest/no-customer order)", () => {
    const { order } = normalizeGraphqlOrder(realNode({ customer: null }), { syncedAt: SYNCED_AT });
    expect(order.customerId).toBeNull();
  });

  it("normalizes refunds using totalRefundedSet, taking the absolute value", () => {
    const node = realNode({
      displayFinancialStatus: "REFUNDED",
      refunds: [
        {
          id: "gid://shopify/Refund/987103330619",
          createdAt: "2025-01-15T09:18:49Z",
          totalRefundedSet: { shopMoney: { amount: "5404.4" } },
        },
      ],
    });
    const { refunds } = normalizeGraphqlOrder(node, { syncedAt: SYNCED_AT });
    expect(refunds).toHaveLength(1);
    expect(refunds[0].refundId).toBe("987103330619");
    expect(refunds[0].amountMinorUnits).toBe(540_440);
    expect(refunds[0].createdAt.toISOString()).toBe("2025-01-15T09:18:49.000Z");
  });

  it("treats a line item with no product (deleted product) as productId/variantId null", () => {
    const node = realNode({
      lineItems: {
        edges: [
          {
            node: {
              id: "gid://shopify/LineItem/1",
              title: "Deleted product",
              sku: null,
              quantity: 1,
              product: null,
              variant: null,
              originalUnitPriceSet: { shopMoney: { amount: "0.0" } },
            },
          },
        ],
      },
    });
    const { lines } = normalizeGraphqlOrder(node, { syncedAt: SYNCED_AT });
    expect(lines[0].productId).toBeNull();
    expect(lines[0].variantId).toBeNull();
    expect(lines[0].productTags).toBeNull();
    expect(lines[0].productType).toBeNull();
  });

  it("treats a missing totalShippingPriceSet as null, not zero", () => {
    const { order } = normalizeGraphqlOrder(realNode({ totalShippingPriceSet: null }), {
      syncedAt: SYNCED_AT,
    });
    expect(order.totalShippingMinorUnits).toBeNull();
  });
});
