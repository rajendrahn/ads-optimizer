// Pure Shopify Webhook (REST-shaped delivery payload) -> Firestore normalization — the
// webhook-delivery counterpart of ../orders/graphqlNormalize.ts (ongoing GraphQL sync) and
// ../orders/csvNormalize.ts (Matrixify backfill). B5's notes flagged this as the thing B6
// should check rather than assume: "B6 should check whether webhook payloads (a different
// delivery mechanism, historically REST-shaped even for GraphQL-API apps) still carry these
// fields before assuming this gap is permanent" (landingSite/referringSite — see below).
//
// This does NOT reuse graphqlNormalize.ts's function directly — a webhook delivery payload has
// a genuinely different shape (plain numeric IDs, snake_case fields, REST's classic Order/Refund
// resource) than a GraphQL query response node (global "gid://..." IDs, camelCase, `*Set`
// money wrappers) — but it writes the exact same shared/schema/shopify.ts types, through the
// exact same version guard, as both other sources. `shopifyOrderSchema.source` already has a
// "WEBHOOK" enum value reserved for this (added by A2/B5, unused until now).
//
// landingSite/referringSite: unlike the GraphQL Admin API (graphqlNormalize.ts's module comment
// — `Order.landingSite`/`.referringSite` were confirmed live to not exist in that schema for
// this store), Shopify's REST-shaped webhook delivery payload for order topics is documented to
// still carry `landing_site`/`referring_site` as plain JSON fields — webhook payload shape has
// historically been independent of which Admin API surface (REST vs GraphQL) a merchant
// otherwise queries. **This is NOT verified against a real delivery from this store** — B6's
// safety constraints forbid registering the webhook subscription against the live store, so no
// real payload has actually been inspected, only Shopify's public webhook payload
// documentation/schema. It is read here opportunistically (`payload.landing_site ?? null`): if
// this holds on the first real delivery, B7's attribution join immediately gains post-backfill
// coverage with no code change; if it doesn't, this stays null exactly as GRAPHQL_SYNC already
// does today, and nothing regresses either way. **Confirm against a real delivery before relying
// on it** — flagged again in this step's final report and in IMPLEMENTATION_PLAN.md.

import { parseDecimalToMinorUnits } from "@shared/canon/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
  type ShopifyOrder,
  type ShopifyOrderLine,
  type ShopifyRefund,
} from "@shared/schema/index.ts";

export interface RawWebhookMoneySet {
  shop_money?: { amount: string; currency_code?: string };
}

export interface RawWebhookLineItem {
  id: number | string;
  product_id: number | string | null;
  variant_id: number | string | null;
  sku: string | null;
  title: string | null;
  quantity: number;
  price: string; // decimal string, e.g. "1499.00"
}

export interface RawWebhookTransaction {
  amount: string;
  kind: string; // "refund" | "sale" | "capture" | "void" | "authorization" | ...
  status: string; // "success" | "pending" | "failure" | "error"
  currency?: string;
}

export interface RawWebhookRefundLineItem {
  subtotal: string;
  total_tax: string;
  subtotal_set?: RawWebhookMoneySet;
}

/** The shape common to both delivery mechanisms for a refund: the standalone `refunds/create`
 * topic's payload, and an order payload's embedded `refunds[]` entries. */
export interface RawWebhookOrderRefund {
  id: number | string;
  order_id?: number | string;
  created_at: string;
  note?: string | null;
  transactions?: RawWebhookTransaction[];
  refund_line_items?: RawWebhookRefundLineItem[];
}

/** The standalone `refunds/create` webhook topic's payload — same shape as an order's embedded
 * refund entry, but `order_id` is always present (it's the only way to know which order this
 * refund belongs to when the refund arrives on its own, decoupled from any order payload). */
export interface RawWebhookRefundPayload extends RawWebhookOrderRefund {
  order_id: number | string;
}

export interface RawWebhookOrderPayload {
  id: number | string;
  name: string | null;
  order_number?: number | string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  customer: { id: number | string } | null;
  billing_address: { country_code?: string | null } | null;
  shipping_address: { country_code?: string | null } | null;
  subtotal_price: string;
  total_discounts: string;
  total_price: string;
  total_shipping_price_set?: RawWebhookMoneySet | null;
  shipping_lines?: { price: string }[];
  landing_site?: string | null;
  referring_site?: string | null;
  line_items: RawWebhookLineItem[];
  refunds?: RawWebhookOrderRefund[];
}

function idString(id: number | string): string {
  return String(id);
}

function moneyMinorUnits(amount: string, currency: string): number {
  return parseDecimalToMinorUnits(amount, currency).amountMinorUnits;
}

function shippingMinorUnits(node: RawWebhookOrderPayload, currency: string): number | null {
  const setAmount = node.total_shipping_price_set?.shop_money?.amount;
  if (setAmount != null) return moneyMinorUnits(setAmount, currency);
  if (node.shipping_lines && node.shipping_lines.length > 0) {
    return node.shipping_lines.reduce(
      (sum, line) => sum + moneyMinorUnits(line.price, currency),
      0,
    );
  }
  return null;
}

/**
 * Sums a refund event's actual money movement. Neither delivery shape has a single top-level
 * "amount refunded" field — the authoritative figure is the sum of `transactions[]` that
 * actually moved money back (`kind: "refund"`, `status: "success"`; matches how a Shopify
 * refund's real cash impact is computed elsewhere in the Admin API ecosystem). Falls back to
 * summing `refund_line_items[].subtotal + total_tax` (the product/tax value refunded, excluding
 * shipping) when no successful refund transaction is present — covers a pure restock/exchange
 * refund that moves no cash at all. Not verified against a real delivery from this store (see
 * module comment) — flagged for confirmation against the first live payload.
 */
export function refundAmountMinorUnits(refund: RawWebhookOrderRefund, currency: string): number {
  const transactions = refund.transactions ?? [];
  const fromTransactions = transactions
    .filter((t) => t.kind === "refund" && t.status === "success")
    .reduce((sum, t) => sum + Math.abs(moneyMinorUnits(t.amount, currency)), 0);
  if (fromTransactions > 0) return fromTransactions;

  const lineItems = refund.refund_line_items ?? [];
  return lineItems.reduce(
    (sum, li) =>
      sum + moneyMinorUnits(li.subtotal, currency) + moneyMinorUnits(li.total_tax, currency),
    0,
  );
}

/**
 * A standalone `refunds/create` payload carries no top-level `currency` field (unlike an order
 * payload) — resolve it from whichever nested money data is present: a transaction's own
 * `currency`, falling back to a refund line item's `subtotal_set.shop_money.currency_code`.
 * Returns `null` (never throws) when neither is present — the caller (processTask.ts) turns
 * that into a clear terminal error rather than guessing a currency.
 */
export function resolveRefundCurrency(refund: RawWebhookOrderRefund): string | null {
  const fromTransaction = (refund.transactions ?? []).find((t) => !!t.currency)?.currency;
  if (fromTransaction) return fromTransaction;
  const fromLineItem = (refund.refund_line_items ?? []).find(
    (li) => !!li.subtotal_set?.shop_money?.currency_code,
  )?.subtotal_set?.shop_money?.currency_code;
  return fromLineItem ?? null;
}

export interface NormalizeWebhookCtx {
  syncedAt: Date;
}

export interface NormalizeWebhookOrderResult {
  order: ShopifyOrder;
  lines: ShopifyOrderLine[];
  refunds: ShopifyRefund[];
}

export function normalizeWebhookOrder(
  node: RawWebhookOrderPayload,
  ctx: NormalizeWebhookCtx,
): NormalizeWebhookOrderResult {
  const orderId = idString(node.id);
  const currency = node.currency;
  const sourceUpdatedAt = new Date(node.updated_at);

  const order: ShopifyOrder = shopifyOrderSchema.parse({
    orderId,
    orderNumber: node.name ?? (node.order_number != null ? String(node.order_number) : null),
    createdAt: new Date(node.created_at),
    sourceUpdatedAt,
    currency,
    totalPriceMinorUnits: moneyMinorUnits(node.total_price, currency),
    subtotalPriceMinorUnits: moneyMinorUnits(node.subtotal_price, currency),
    totalDiscountsMinorUnits: moneyMinorUnits(node.total_discounts, currency),
    totalShippingMinorUnits: shippingMinorUnits(node, currency),
    // REST webhook payloads' financial_status/fulfillment_status are already lowercase
    // snake_case ("paid", "partially_refunded", ...) — matches the CSV/GraphQL convention
    // established in graphqlNormalize.ts, no case conversion needed here.
    financialStatus: node.financial_status ?? null,
    fulfillmentStatus: node.fulfillment_status ?? null,
    cancelledAt: node.cancelled_at ? new Date(node.cancelled_at) : null,
    customerId: node.customer ? idString(node.customer.id) : null,
    // Computed separately — see ../orders/newVsRepeat.ts. Left null here exactly as
    // GRAPHQL_SYNC does; the next SHOPIFY_SYNC_ORDERS run's full recompute fills it in.
    isNewCustomer: null,
    country: node.shipping_address?.country_code ?? node.billing_address?.country_code ?? null,
    // See module comment — opportunistically captured, not yet verified against a real
    // delivery from this store.
    landingSite: node.landing_site ?? null,
    referringSite: node.referring_site ?? null,
    rawAttributionTag: null, // B7's job
    resolvedAdId: null,
    resolvedCampaignId: null,
    source: "WEBHOOK",
    syncedAt: ctx.syncedAt,
  });

  const lines: ShopifyOrderLine[] = node.line_items.map((li) =>
    shopifyOrderLineSchema.parse({
      orderId,
      lineItemId: idString(li.id),
      productId: li.product_id != null ? idString(li.product_id) : null,
      variantId: li.variant_id != null ? idString(li.variant_id) : null,
      sku: li.sku,
      title: li.title,
      quantity: li.quantity,
      priceMinorUnits: moneyMinorUnits(li.price, currency),
      currency,
      // A webhook order payload's line_items carry no product tags/type (that needs a
      // separate Product fetch, out of scope here) — null, not a fabricated guess. The next
      // GRAPHQL_SYNC run for this order will fill these in.
      productTags: null,
      productType: null,
      sourceUpdatedAt,
      syncedAt: ctx.syncedAt,
    }),
  );

  const refunds: ShopifyRefund[] = (node.refunds ?? []).map((r) =>
    normalizeWebhookRefund(r, orderId, currency, ctx),
  );

  return { order, lines, refunds };
}

export function normalizeWebhookRefund(
  refund: RawWebhookOrderRefund,
  orderId: string,
  currency: string,
  ctx: NormalizeWebhookCtx,
): ShopifyRefund {
  const createdAt = new Date(refund.created_at);
  return shopifyRefundSchema.parse({
    orderId,
    refundId: idString(refund.id),
    createdAt,
    amountMinorUnits: refundAmountMinorUnits(refund, currency),
    currency,
    // Shopify's Refund resource carries no structured "reason" field (matches
    // graphqlNormalize.ts's same observation about the GraphQL Refund type) — `note` is free
    // text, not a reason code, so it's not repurposed as one.
    reason: null,
    sourceUpdatedAt: createdAt, // refunds are immutable — matches graphqlNormalize.ts/CSV path
    syncedAt: ctx.syncedAt,
  });
}
