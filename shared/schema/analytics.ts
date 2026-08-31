// C1's own collections — NOT one of §8's originally named collections, added here for the same
// reason B3 added `metaInsightsReportJobs`: a genuinely new artifact this step introduces, not a
// namespace violation of §8's "one brand, one ad account, do not namespace speculatively" (that
// guidance is about business namespacing, not about a step adding the collection its own
// deliverable requires).
//
// Goal (IMPLEMENTATION_PLAN.md C1): "Meta and Shopify data expressed on the same days, in the
// same currency." B3's `metaInsightsDaily` and B5's `shopifyOrders`/`shopifyRefunds` are each
// already normalized *within* their own source, but on that source's own native day (Meta: the
// ad account's configured timezone; Shopify: whatever instant `createdAt` records) and in
// whatever currency the source itself reports. C1 re-expresses each row — one in, one out, never
// merged or summed here — on the reporting day (§5.1, via `@shared/canon`'s `toReportingDay`)
// and in the reporting currency (§5.2), and stamps the timezone the mapping used. Windowed
// aggregation (summing across many days) and derived metrics are explicitly out of scope here —
// C2's job (IMPLEMENTATION_PLAN.md C1 "Out of scope").
//
// `shopifyDailyCoverage` is the one place this file DOES aggregate — not a business metric, a
// coverage diagnostic: for a reporting day with zero Shopify order rows, there is no per-order
// row to hang a "this day is inside the known data gap" flag on, so that flag needs its own
// per-day record. See that schema's own comment.

import { z } from "zod";
import { attributionProvenance, firestoreTimestamp, reportingDay } from "./common.ts";

/**
 * A money amount normalized to the reporting currency (§5.2), carrying the original
 * source-currency amount and the FX rate used to get from one to the other — "store the FX
 * rate used on that record. Never convert without recording the rate," and per C1's own brief,
 * "the FX rate stored wherever any conversion occurs." `fxRateToReportingCurrency` is always
 * present, even when no real conversion happened (`1`, `fxRateSource: "same_currency"`) — a
 * recorded 1:1 is the honest statement "no conversion was needed here," not an omission.
 * `amountMinorUnits`/`currency` are always in the reporting currency; `sourceAmountMinorUnits`/
 * `sourceCurrency` preserve what the row actually said before normalization, for audit.
 */
export const normalizedMoney = z.object({
  amountMinorUnits: z.number().int(),
  currency: z.string().length(3),
  sourceAmountMinorUnits: z.number().int(),
  sourceCurrency: z.string().length(3),
  fxRateToReportingCurrency: z.number(),
  fxRateSource: z.string().min(1),
});
export type NormalizedMoney = z.infer<typeof normalizedMoney>;

// ---------------------------------------------------------------------------------------
// metaInsightsDailyNormalized/{adId}_{reportingDay} — one row per source metaInsightsDaily row
// (§9.5's `{adId}_{date}` key, remapped from Meta's native day onto the reporting day).
// Version-guarded like its source; `sourceUpdatedAt` is carried through from the source row
// (see shared/firestore/versionGuard.ts's module comment on what that field means for Meta
// data — our own fetch/reconciliation-run timestamp, not something Meta returns), so a re-run
// of this normalization over an unchanged underlying row is an equal-version, idempotent no-op.
// ---------------------------------------------------------------------------------------

export const metaInsightsDailyNormalizedSchema = z.object({
  adId: z.string().min(1),
  adsetId: z.string().min(1),
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  reportingDay, // §5.1 — the canon day this row was remapped onto
  reportingTimezone: z.string().min(1), // §5.1 — "stamp every daily record with the timezone"
  // The source row's own native day/timezone, kept for traceability back to metaInsightsDaily —
  // see services/analytics's module comment on how the native->reporting remap works and why
  // nativeTimezone is a documented assumption, not a value Meta returns per row.
  nativeDate: reportingDay,
  nativeTimezone: z.string().min(1),
  attribution: attributionProvenance, // §5.3 — carried through intact, never re-derived
  spend: normalizedMoney,
  purchaseValue: normalizedMoney,
  impressions: z.number().int().nonnegative(),
  reach: z.number().int().nonnegative().nullable(),
  frequency: z.number().nonnegative().nullable(),
  clicks: z.number().int().nonnegative(),
  landingPageViews: z.number().int().nonnegative(),
  addToCart: z.number().int().nonnegative(),
  initiateCheckout: z.number().int().nonnegative(),
  purchases: z.number().int().nonnegative(),
  sourceUpdatedAt: firestoreTimestamp, // version-guard field — carried from the source row
  computedAt: firestoreTimestamp,
});
export type MetaInsightsDailyNormalized = z.infer<typeof metaInsightsDailyNormalizedSchema>;

// ---------------------------------------------------------------------------------------
// shopifyOrdersNormalized/{orderId} — one row per shopifyOrders document, reportingDay derived
// directly from the order's own `createdAt` instant (no native-timezone ambiguity the way Meta
// has, since B5 already stores a real UTC instant, not a day string).
// ---------------------------------------------------------------------------------------

export const shopifyOrderNormalizedSchema = z.object({
  orderId: z.string().min(1),
  reportingDay,
  reportingTimezone: z.string().min(1),
  nativeCreatedAt: firestoreTimestamp, // = shopifyOrders.createdAt, for traceability
  totalPrice: normalizedMoney,
  subtotalPrice: normalizedMoney,
  totalDiscounts: normalizedMoney,
  totalShipping: normalizedMoney.nullable(),
  isNewCustomer: z.boolean().nullable(),
  country: z.string().nullable(),
  customerId: z.string().nullable(), // PII boundary already enforced upstream (id only) — see shopify.ts
  // Carried through verbatim from shopifyOrders — B7's join populates these upstream; C1 does
  // not resolve, join or invent an ad/campaign id.
  resolvedAdId: z.string().nullable(),
  resolvedCampaignId: z.string().nullable(),
  source: z.string(), // ShopifyOrderSource, carried through for traceability
  sourceUpdatedAt: firestoreTimestamp, // version-guard field — carried from shopifyOrders
  computedAt: firestoreTimestamp,
});
export type ShopifyOrderNormalized = z.infer<typeof shopifyOrderNormalizedSchema>;

// ---------------------------------------------------------------------------------------
// shopifyRefundsNormalized/{orderId}_{refundId} — mirrors shopifyOrdersNormalized; a refund's
// reportingDay comes from ITS OWN createdAt, not its parent order's — a refund issued days after
// the order is a distinct event on its own reporting day, deliberately not backdated to match
// the order (C2 decides how the two combine into a net-revenue metric; not C1's job).
// ---------------------------------------------------------------------------------------

export const shopifyRefundNormalizedSchema = z.object({
  orderId: z.string().min(1),
  refundId: z.string().min(1),
  reportingDay,
  reportingTimezone: z.string().min(1),
  nativeCreatedAt: firestoreTimestamp,
  amount: normalizedMoney,
  reason: z.string().nullable(),
  sourceUpdatedAt: firestoreTimestamp,
  computedAt: firestoreTimestamp,
});
export type ShopifyRefundNormalized = z.infer<typeof shopifyRefundNormalizedSchema>;

// ---------------------------------------------------------------------------------------
// shopifyDailyCoverage/{reportingDay} — B5's Dec-2025 -> ~Jul-2026 Shopify order data hole
// (`syncState/shopify_orders`'s `knownGaps`, read here, never re-derived) means some reporting
// days have zero shopifyOrders rows not because nothing happened, but because the data
// structurally cannot exist yet. A day with zero rows has nothing to stamp a gap flag onto, so
// this is a genuinely per-day (not per-order) artifact — the one place in this file that isn't
// "one normalized row per source row". `ordersObserved`/`refundsObserved` are coverage
// diagnostics (did we see the volume we'd expect), not a business metric; C2 does the real
// aggregation.
// ---------------------------------------------------------------------------------------

export const shopifyDailyCoverageSchema = z.object({
  reportingDay,
  reportingTimezone: z.string().min(1),
  accountId: z.string().min(1),
  // §5.1/B5's gap: a day fully or partially inside a recorded knownGaps entry. C2/C3 MUST treat
  // true here as "genuinely no data", never "zero activity" (IMPLEMENTATION_PLAN.md C1 brief).
  hasCoverageGap: z.boolean(),
  gapReason: z.string().nullable(), // the matching knownGaps entry's own reason, verbatim
  ordersObserved: z.number().int().nonnegative(),
  refundsObserved: z.number().int().nonnegative(),
  computedAt: firestoreTimestamp,
  // No natural source `updated_at` for a derived per-day marker — mirrors metaInsightsDaily's
  // own precedent (shared/firestore/versionGuard.ts's module comment): this is our own
  // computation timestamp, so re-running normalization for an unchanged day is an equal-version,
  // idempotent no-op.
  sourceUpdatedAt: firestoreTimestamp,
});
export type ShopifyDailyCoverage = z.infer<typeof shopifyDailyCoverageSchema>;
