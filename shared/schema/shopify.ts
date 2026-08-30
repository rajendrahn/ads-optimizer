// Shopify collections — §8: shopifyOrders, shopifyOrderLines, shopifyRefunds.
//
// Populated by B5 (Matrixify import + incremental GraphQL sync) and B6 (webhooks). All
// three are version-guarded (§9.5) — Shopify webhooks are at-least-once and unordered, so
// every write here goes through shared/firestore/versionGuard.ts, never a blind `set`.
//
// PII boundary (§17.2, and B5's explicit note): only `customerId` is stored, never name,
// email, address or phone. Those fields are dropped at parse time before anything reaches
// Firestore — this schema has no field for them, which is intentional, not an oversight.

import { z } from "zod";
import { firestoreTimestamp } from "./common.ts";

export const shopifyOrderSourceSchema = z.enum(["MATRIXIFY_IMPORT", "GRAPHQL_SYNC", "WEBHOOK"]);
export type ShopifyOrderSource = z.infer<typeof shopifyOrderSourceSchema>;

export const shopifyOrderSchema = z.object({
  orderId: z.string().min(1), // Shopify's own order ID — used directly as the doc ID
  orderNumber: z.string().nullable(),
  createdAt: firestoreTimestamp,
  sourceUpdatedAt: firestoreTimestamp, // Shopify's own `updated_at` — the version-guard field
  currency: z.string().length(3),
  totalPriceMinorUnits: z.number().int(),
  subtotalPriceMinorUnits: z.number().int(),
  totalDiscountsMinorUnits: z.number().int(),
  // Added by B5, optional/defaulted per A2's schema-evolution rule (empty collection at the
  // time this landed, so this is precautionary, not a live-migration need). Neither the
  // Matrixify CSV nor the GraphQL Admin API expose a single "shipping revenue" field on the
  // *order* the way they do subtotal/discounts/total — B5 derives it from the CSV's "Price:
  // Total Shipping" order-summary column / GraphQL's `totalShippingPriceSet`, both of which
  // are the *original* (pre-refund) shipping charge, matching how totalPriceMinorUnits etc.
  // are also original, not current, values (see B5 notes on current vs. original Shopify
  // money fields).
  totalShippingMinorUnits: z.number().int().nullable().optional(),
  financialStatus: z.string().nullable(),
  fulfillmentStatus: z.string().nullable(),
  cancelledAt: firestoreTimestamp.nullable(),
  customerId: z.string().nullable(), // PII boundary — id only, see module comment
  // Derived in B5 from each customer's full order sequence, not any single-order field
  // (§7.2 — Matrixify's own "Customer: Orders Count" is a point-in-time snapshot and would
  // misclassify historical orders). Null until that pass has run.
  isNewCustomer: z.boolean().nullable(),
  country: z.string().nullable(),
  // Raw query string, verbatim (§6.1, §7.2) — B7's join parses this. Populated for
  // MATRIXIFY_IMPORT orders straight from the CSV's "Browser: Landing Page"/"Browser:
  // Referrer" columns. **For GRAPHQL_SYNC and WEBHOOK orders these are always null** — verified
  // live against this store's real Shopify Admin API (2025-01): `Order.landingSite`/
  // `.referringSite` do not exist in the GraphQL schema at all (removed upstream of this API
  // version); the intended replacement, `Order.customerJourneySummary.firstVisit/lastVisit`,
  // is queryable but returns null for every real order sampled — this store is not on Shopify
  // Plus, and per §6.2 that summary requires it. REST still exposes these fields but is
  // off-limits per §0.2 ("REST is legacy — do not use it"). Net effect: **post-CSV-backfill
  // orders currently have no landing-page attribution data at all via any sanctioned path** —
  // B7's join only has query strings for the ~10k orders MATRIXIFY_IMPORT actually covers.
  // B6 should check whether webhook payloads (a different delivery mechanism, historically
  // REST-shaped even for GraphQL-API apps) still carry these fields before assuming this gap
  // is permanent.
  landingSite: z.string().nullable(),
  referringSite: z.string().nullable(),
  // §6.1: raw tag stored alongside the resolved ad ID, for replay without re-fetching. B5
  // deliberately leaves this null on every order it writes — parsing UTMs out of landingSite
  // is explicitly B7's job, not B5's (IMPLEMENTATION_PLAN.md B5 "Out of scope"); B7 populates
  // this alongside resolvedAdId/resolvedCampaignId when it does the join.
  rawAttributionTag: z.string().nullable(),
  resolvedAdId: z.string().nullable(), // populated by B7's join, not B5
  resolvedCampaignId: z.string().nullable(), // populated by B7's join, not B5
  source: shopifyOrderSourceSchema,
  syncedAt: firestoreTimestamp,
});
export type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;

export const shopifyOrderLineSchema = z.object({
  orderId: z.string().min(1),
  lineItemId: z.string().min(1),
  productId: z.string().nullable(),
  variantId: z.string().nullable(),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  quantity: z.number().int().nonnegative(),
  priceMinorUnits: z.number().int(),
  currency: z.string().length(3),
  productTags: z.array(z.string()).nullable(),
  // Added by B5, optional/defaulted per A2's schema-evolution rule. Cheap to capture from
  // both sources (CSV's "Line: Product Type" column, GraphQL's `product.productType`) — kept
  // alongside productTags for §7.2/§12's "product mix" metrics.
  productType: z.string().nullable().optional(),
  sourceUpdatedAt: firestoreTimestamp, // version-guard field (parent order's updated_at)
  syncedAt: firestoreTimestamp,
});
export type ShopifyOrderLine = z.infer<typeof shopifyOrderLineSchema>;

export const shopifyRefundSchema = z.object({
  orderId: z.string().min(1),
  refundId: z.string().min(1),
  createdAt: firestoreTimestamp,
  amountMinorUnits: z.number().int().nonnegative(),
  currency: z.string().length(3),
  reason: z.string().nullable(),
  sourceUpdatedAt: firestoreTimestamp, // version-guard field
  syncedAt: firestoreTimestamp,
});
export type ShopifyRefund = z.infer<typeof shopifyRefundSchema>;
