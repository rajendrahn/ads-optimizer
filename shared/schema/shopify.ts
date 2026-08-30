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
  financialStatus: z.string().nullable(),
  fulfillmentStatus: z.string().nullable(),
  cancelledAt: firestoreTimestamp.nullable(),
  customerId: z.string().nullable(), // PII boundary — id only, see module comment
  // Derived in B5 from each customer's full order sequence, not any single-order field
  // (§7.2 — Matrixify's own "Customer: Orders Count" is a point-in-time snapshot and would
  // misclassify historical orders). Null until that pass has run.
  isNewCustomer: z.boolean().nullable(),
  country: z.string().nullable(),
  landingSite: z.string().nullable(), // raw query string, verbatim (§6.1, §7.2)
  referringSite: z.string().nullable(),
  rawAttributionTag: z.string().nullable(), // §6.1: raw tag stored alongside the resolved ID
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
