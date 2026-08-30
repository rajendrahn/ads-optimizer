// Pure Matrixify-CSV -> Firestore normalization (§7.2, §9.1). No Firestore, no network — one
// order's grouped raw rows in, typed + zod-validated shared/schema objects out.
//
// Decisions this file encodes, verified against the real production export (see
// IMPLEMENTATION_PLAN.md B5 notes for the underlying inspection):
//
//   - Order-level fields (Created At, Customer: ID, Browser: Landing Page, the Price: *
//     summary columns, ...) are taken as the first non-blank value found across the group's
//     rows, in file order (`firstNonBlank`). This is correct for both patterns actually
//     observed: fields present on every row when set (Browser: *), and fields present on
//     exactly one row — always the order's first "Line Item" row, in all 10,000 real orders
//     sampled (the Price: * summary columns).
//   - Only `Line: Type: "Line Item"` rows become `shopifyOrderLines` documents — these are the
//     only rows that represent a purchased product (§7.2's "line items, product/variant/SKU").
//     "Shipping Line" rows have no product identity; "Discount" rows represent an order-level
//     discount code, already captured in `totalDiscountsMinorUnits`; "Refund Line"/"Refund
//     Shipping" rows become `shopifyRefunds` documents instead (see `groupRefundRows`), not
//     order lines.
//   - The Matrixify export has **no native Shopify line-item ID column** — Matrixify simply
//     doesn't include one, even though the header list otherwise matches §7.2. B5 synthesizes
//     one (`csvline-{n}`, 1-based position among an order's "Line Item" rows) so
//     `shopifyOrderLineKey` has something deterministic to key off of. This is stable across
//     re-imports of the *same* file (row order is deterministic) but not guaranteed stable if
//     a later, larger export reorders an order's line items relative to this one — a known,
//     accepted limitation (see IMPLEMENTATION_PLAN.md B5 notes: bounded to duplicate/orphaned
//     *line* docs within the same order, never the order document itself, and moot for any
//     order once GraphQL/webhook sync starts writing that order's lines under Shopify's own
//     real line-item IDs instead).
//   - Refund rows are grouped by `Refund: ID` (an order can have more than one refund event;
//     "Refund Line" and "Refund Shipping" rows sharing one `Refund: ID` are one refund). A
//     refund's amount is the sum of `|Line: Total|` across its rows — Matrixify has no direct
//     per-refund total column. Refunds are immutable once created in Shopify (no `updated_at`
//     of their own), so `sourceUpdatedAt` is set to the refund's own `createdAt` — the version
//     guard still works correctly (a refund is written once and never revised).
//   - `financialStatus` is lower-cased for consistency with the GraphQL path, which returns
//     Shopify's `displayFinancialStatus` upper-cased (e.g. "PAID") for the same logical value
//     the CSV already gives lower-case ("paid") — see graphqlNormalize.ts's matching comment.
//   - `country` prefers the shipping country code, falling back to billing — an explicit,
//     documented choice since the schema has one `country` field but Shopify tracks the two
//     separately.
//   - `landingSite`/`referringSite` come straight from "Browser: Landing Page"/"Browser:
//     Referrer" — for CSV-imported orders only; see shared/schema/shopify.ts's field comment
//     for why the GraphQL path can never populate these.
//   - `rawAttributionTag`, `resolvedAdId`, `resolvedCampaignId`, `isNewCustomer` are always
//     null here — B7's UTM join and B5's own separate new-vs-repeat recompute pass populate
//     them, deliberately not this function (see newVsRepeat.ts).

import { parseDecimalToMinorUnits } from "@shared/canon/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
  type ShopifyOrder,
  type ShopifyOrderLine,
  type ShopifyRefund,
} from "@shared/schema/index.ts";
import type { MatrixifyOrderGroup, MatrixifyRow } from "./csvParser.ts";
import { parseMatrixifyTimestamp, parseOptionalMatrixifyTimestamp } from "./timestamps.ts";

function firstNonBlank(rows: MatrixifyRow[], column: string): string | null {
  for (const row of rows) {
    const value = row[column];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return null;
}

function parseMoney(raw: string, currency: string): number {
  return parseDecimalToMinorUnits(raw, currency).amountMinorUnits;
}

function parseProductTags(raw: string | null): string[] | null {
  if (raw === null) return null;
  const tags = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tags.length > 0 ? tags : null;
}

export interface NormalizeMatrixifyOrderCtx {
  syncedAt: Date;
}

export interface NormalizeMatrixifyOrderResult {
  order: ShopifyOrder;
  lines: ShopifyOrderLine[];
  refunds: ShopifyRefund[];
}

export function normalizeMatrixifyOrderGroup(
  group: MatrixifyOrderGroup,
  ctx: NormalizeMatrixifyOrderCtx,
): NormalizeMatrixifyOrderResult {
  const { orderId, rows } = group;

  const createdAtRaw = firstNonBlank(rows, "Created At");
  if (!createdAtRaw) {
    throw new Error(
      `normalizeMatrixifyOrderGroup: order ${orderId} has no "Created At" in any row`,
    );
  }
  const createdAt = parseMatrixifyTimestamp(createdAtRaw);
  const updatedAtRaw = firstNonBlank(rows, "Updated At");
  const sourceUpdatedAt = updatedAtRaw ? parseMatrixifyTimestamp(updatedAtRaw) : createdAt;

  const currency = firstNonBlank(rows, "Currency") ?? "INR";

  const priceTotalRaw = firstNonBlank(rows, "Price: Total");
  const priceSubtotalRaw = firstNonBlank(rows, "Price: Subtotal");
  const priceDiscountRaw = firstNonBlank(rows, "Price: Total Discount");
  if (priceTotalRaw === null || priceSubtotalRaw === null || priceDiscountRaw === null) {
    throw new Error(
      `normalizeMatrixifyOrderGroup: order ${orderId} is missing a required Price: * summary field`,
    );
  }
  const priceShippingRaw = firstNonBlank(rows, "Price: Total Shipping");

  const shippingCountry = firstNonBlank(rows, "Shipping: Country Code");
  const billingCountry = firstNonBlank(rows, "Billing: Country Code");
  const financialStatus = firstNonBlank(rows, "Payment: Status");

  const order: ShopifyOrder = shopifyOrderSchema.parse({
    orderId,
    orderNumber: firstNonBlank(rows, "Name"),
    createdAt,
    sourceUpdatedAt,
    currency,
    totalPriceMinorUnits: parseMoney(priceTotalRaw, currency),
    subtotalPriceMinorUnits: parseMoney(priceSubtotalRaw, currency),
    totalDiscountsMinorUnits: parseMoney(priceDiscountRaw, currency),
    totalShippingMinorUnits:
      priceShippingRaw !== null ? parseMoney(priceShippingRaw, currency) : null,
    financialStatus: financialStatus ? financialStatus.toLowerCase() : null,
    fulfillmentStatus: null, // not present in this export's column set
    cancelledAt: parseOptionalMatrixifyTimestamp(firstNonBlank(rows, "Cancelled At")),
    customerId: firstNonBlank(rows, "Customer: ID"),
    isNewCustomer: null, // computed separately — see newVsRepeat.ts
    country: shippingCountry ?? billingCountry,
    landingSite: firstNonBlank(rows, "Browser: Landing Page"),
    referringSite: firstNonBlank(rows, "Browser: Referrer"),
    rawAttributionTag: null, // B7's job, not B5's — see shared/schema/shopify.ts
    resolvedAdId: null,
    resolvedCampaignId: null,
    source: "MATRIXIFY_IMPORT",
    syncedAt: ctx.syncedAt,
  });

  const lines: ShopifyOrderLine[] = rows
    .filter((r) => r["Line: Type"] === "Line Item")
    .map((row, index) =>
      shopifyOrderLineSchema.parse({
        orderId,
        lineItemId: `csvline-${index + 1}`,
        productId: row["Line: Product ID"]?.trim() || null,
        variantId: row["Line: Variant ID"]?.trim() || null,
        sku: row["Line: SKU"]?.trim() || null,
        title: row["Line: Title"]?.trim() || null,
        quantity: Number(row["Line: Quantity"]?.trim() || "0"),
        priceMinorUnits: parseMoney(row["Line: Price"]?.trim() || "0", currency),
        currency,
        productTags: parseProductTags(row["Line: Product Tags"]?.trim() || null),
        productType: row["Line: Product Type"]?.trim() || null,
        sourceUpdatedAt,
        syncedAt: ctx.syncedAt,
      }),
    );

  const refunds: ShopifyRefund[] = groupRefundRows(rows).map(([refundId, refundRows]) => {
    const amountMinorUnits = refundRows.reduce((sum, row) => {
      const lineTotal = row["Line: Total"]?.trim();
      return sum + (lineTotal ? Math.abs(parseMoney(lineTotal, currency)) : 0);
    }, 0);
    const refundCreatedAtRaw = firstNonBlank(refundRows, "Refund: Created At");
    const refundCreatedAt = refundCreatedAtRaw
      ? parseMatrixifyTimestamp(refundCreatedAtRaw)
      : sourceUpdatedAt;
    return shopifyRefundSchema.parse({
      orderId,
      refundId,
      createdAt: refundCreatedAt,
      amountMinorUnits,
      currency,
      reason: null, // no refund-reason column in this export (Cancel: Reason is order-level)
      sourceUpdatedAt: refundCreatedAt, // refunds are immutable — see module comment
      syncedAt: ctx.syncedAt,
    });
  });

  return { order, lines, refunds };
}

function groupRefundRows(rows: MatrixifyRow[]): [string, MatrixifyRow[]][] {
  const byRefundId = new Map<string, MatrixifyRow[]>();
  for (const row of rows) {
    if (row["Line: Type"] !== "Refund Line" && row["Line: Type"] !== "Refund Shipping") continue;
    const refundId = row["Refund: ID"]?.trim();
    if (!refundId) continue; // not observed live, but don't fabricate an id if it's ever missing
    let group = byRefundId.get(refundId);
    if (!group) {
      group = [];
      byRefundId.set(refundId, group);
    }
    group.push(row);
  }
  return [...byRefundId.entries()];
}
