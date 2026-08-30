// Pure Shopify GraphQL Admin API -> Firestore normalization for the ongoing incremental sync
// (§7.2, §9.3) — the GraphQL-shaped counterpart of csvNormalize.ts. No Firestore, no network.
//
// Money fields deliberately use the *original* (pre-refund) aggregates —
// `subtotalPriceSet`/`totalDiscountsSet`/`totalShippingPriceSet`/`totalPriceSet` — not
// Shopify's `current*` variants (`currentTotalPriceSet` etc., which shrink as an order is
// refunded/edited). This matches the Matrixify CSV's "Price: *" columns, which are also the
// as-placed values, not a live-adjusted figure — so `totalPriceMinorUnits` means the same thing
// for every order regardless of which source wrote it, and refund activity is visible instead
// through the separate `shopifyRefunds` collection, never by a shrinking order total.
//
// landingSite/referringSite are always null here — verified live against this store's real
// Shopify Admin API (2025-01 GraphQL): `Order.landingSite`/`.referringSite` do not exist in the
// schema, and the replacement `customerJourneySummary.firstVisit/lastVisit` is queryable but
// returns null for every real order (this store is not on Shopify Plus). See
// shared/schema/shopify.ts's field comment for the full finding and its consequence for B7.

import { parseDecimalToMinorUnits } from "@shared/canon/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
  type ShopifyOrder,
  type ShopifyOrderLine,
  type ShopifyRefund,
} from "@shared/schema/index.ts";

/** Extracts the trailing numeric id from a Shopify GraphQL global id, e.g.
 * "gid://shopify/Order/6489142231355" -> "6489142231355". Falls back to the input unchanged if
 * it isn't gid-shaped (defensive, not expected to trigger against a real API response). */
export function numericIdFromGid(gid: string): string {
  const idx = gid.lastIndexOf("/");
  return idx === -1 ? gid : gid.slice(idx + 1);
}

interface MoneySet {
  shopMoney: { amount: string; currencyCode?: string };
}

export interface RawGraphqlLineItem {
  id: string;
  title: string | null;
  sku: string | null;
  quantity: number;
  product: { id: string; productType: string | null; tags: string[] } | null;
  variant: { id: string } | null;
  originalUnitPriceSet: MoneySet;
}

export interface RawGraphqlRefund {
  id: string;
  createdAt: string;
  totalRefundedSet: MoneySet;
}

export interface RawGraphqlOrderNode {
  id: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currencyCode: string;
  customer: { id: string } | null;
  billingAddress: { countryCodeV2: string | null } | null;
  shippingAddress: { countryCodeV2: string | null } | null;
  subtotalPriceSet: MoneySet;
  totalDiscountsSet: MoneySet;
  totalShippingPriceSet: MoneySet | null;
  totalPriceSet: MoneySet;
  lineItems: { edges: { node: RawGraphqlLineItem }[] };
  refunds: RawGraphqlRefund[];
}

function moneyMinorUnits(set: MoneySet, currency: string): number {
  return parseDecimalToMinorUnits(set.shopMoney.amount, currency).amountMinorUnits;
}

export interface NormalizeGraphqlOrderResult {
  order: ShopifyOrder;
  lines: ShopifyOrderLine[];
  refunds: ShopifyRefund[];
}

export interface NormalizeGraphqlOrderCtx {
  syncedAt: Date;
}

export function normalizeGraphqlOrder(
  node: RawGraphqlOrderNode,
  ctx: NormalizeGraphqlOrderCtx,
): NormalizeGraphqlOrderResult {
  const orderId = numericIdFromGid(node.id);
  const currency = node.currencyCode;
  const sourceUpdatedAt = new Date(node.updatedAt);

  const order: ShopifyOrder = shopifyOrderSchema.parse({
    orderId,
    orderNumber: node.name,
    createdAt: new Date(node.createdAt),
    sourceUpdatedAt,
    currency,
    totalPriceMinorUnits: moneyMinorUnits(node.totalPriceSet, currency),
    subtotalPriceMinorUnits: moneyMinorUnits(node.subtotalPriceSet, currency),
    totalDiscountsMinorUnits: moneyMinorUnits(node.totalDiscountsSet, currency),
    totalShippingMinorUnits: node.totalShippingPriceSet
      ? moneyMinorUnits(node.totalShippingPriceSet, currency)
      : null,
    // Lower-cased to match the CSV path's naturally-lowercase Payment: Status values — see
    // module comment.
    financialStatus: node.displayFinancialStatus ? node.displayFinancialStatus.toLowerCase() : null,
    fulfillmentStatus: node.displayFulfillmentStatus
      ? node.displayFulfillmentStatus.toLowerCase()
      : null,
    cancelledAt: node.cancelledAt ? new Date(node.cancelledAt) : null,
    customerId: node.customer ? numericIdFromGid(node.customer.id) : null,
    isNewCustomer: null, // computed separately — see newVsRepeat.ts
    country: node.shippingAddress?.countryCodeV2 ?? node.billingAddress?.countryCodeV2 ?? null,
    landingSite: null, // not retrievable via GraphQL for this store — see module comment
    referringSite: null,
    rawAttributionTag: null, // B7's job
    resolvedAdId: null,
    resolvedCampaignId: null,
    source: "GRAPHQL_SYNC",
    syncedAt: ctx.syncedAt,
  });

  const lines: ShopifyOrderLine[] = node.lineItems.edges.map(({ node: li }) =>
    shopifyOrderLineSchema.parse({
      orderId,
      lineItemId: numericIdFromGid(li.id),
      productId: li.product ? numericIdFromGid(li.product.id) : null,
      variantId: li.variant ? numericIdFromGid(li.variant.id) : null,
      sku: li.sku,
      title: li.title,
      quantity: li.quantity,
      priceMinorUnits: moneyMinorUnits(li.originalUnitPriceSet, currency),
      currency,
      productTags: li.product && li.product.tags.length > 0 ? li.product.tags : null,
      productType: li.product?.productType || null,
      sourceUpdatedAt,
      syncedAt: ctx.syncedAt,
    }),
  );

  const refunds: ShopifyRefund[] = node.refunds.map((r) => {
    const refundCreatedAt = new Date(r.createdAt);
    return shopifyRefundSchema.parse({
      orderId,
      refundId: numericIdFromGid(r.id),
      createdAt: refundCreatedAt,
      amountMinorUnits: Math.abs(moneyMinorUnits(r.totalRefundedSet, currency)),
      currency,
      reason: null, // Shopify's GraphQL Refund type carries no reason field
      sourceUpdatedAt: refundCreatedAt, // refunds are immutable — matches the CSV path
      syncedAt: ctx.syncedAt,
    });
  });

  return { order, lines, refunds };
}
