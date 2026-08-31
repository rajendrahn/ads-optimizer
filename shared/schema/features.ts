// Feature collections — §8: adFeatures, adsetFeatures, accountFeatures; plus C2's own
// creativeFamilyFeatures (see the ambiguity note below).
//
// Populated by C2 (base metrics — this step), C3 (intervals/verdicts/shrinkage), C4
// (change-aware + learning-phase). A2 only fixed the shape — "Out of scope: populating
// anything... their semantics land in C2/D2/D4" (IMPLEMENTATION_PLAN.md A2). Every numeric
// field below stays nullable/partial even after C2: a real recompute may not populate every
// metric for every entity type (e.g. `blendedMerAccountOnly` is only ever non-null at ACCOUNT
// level; a Shopify-derived figure is null for an ad the URL-tag audit says is unresolvable —
// see C2's own module comment on why "null" and "zero" must never be conflated here).
//
// Ambiguity #1, surfaced by A2, RESOLVED BY C2: §12 computes metrics "at ad, ad set, campaign,
// creative family and account level" — five levels — but §8 lists only three feature
// collections. C2's decision: AD -> adFeatures, ADSET -> adsetFeatures, CAMPAIGN ->
// adsetFeatures (keyed by campaign id, entityType "CAMPAIGN" — A2's own suggested resolution),
// ACCOUNT -> accountFeatures, and CREATIVE_FAMILY -> a new `creativeFamilyFeatures` collection
// (not one of §8's names — same category of addition as B3's metaInsightsReportJobs / B7's
// adUrlTagAudits / C1's four analytics collections, each documented the same way there). A
// family's `familyId` (an assetHash, or `composite_{creativeId}`) is not guaranteed disjoint
// from a numeric Meta ad/adset/campaign ID in the abstract, so piggybacking family features
// onto adFeatures (A2's other suggested option) was rejected in favour of a collision-free
// dedicated collection — cheap, and one less thing for a future reader to reason about. §11.3's
// family-only fields (`familyAgeDays`, `totalHistoricalSpendMinorUnits`, `activeAdsCount`,
// `fatigueScore`) stay on `creativeFamilies` itself, per B8's own explicit hand-off note ("C2
// should populate the rest of §11.3's metrics onto these same creativeFamilies docs") — this
// collection carries the §12 *windowed* metric set (delivery/traffic/funnel/business/trend),
// which the flat `creativeFamilySchema` has no shape for.
//
// Ambiguity #2 (A2's own note, left as-is): §14's evidence JSON example uses flat,
// window-suffixed field names (`roas28d`, `roas28dShrunk`, `cpa28d`) — the shape of the
// *evidence object* D1 assembles, not necessarily the feature-store document. This schema
// keeps A2's `windows` map keyed by window label; flattening into §14's shape at evidence-
// build time is D1's small, mechanical step.

import { z } from "zod";
import { attributionProvenance, firestoreTimestamp, reportingDay } from "./common.ts";

/**
 * §15.2: every ROAS/CPA figure carries an interval and a three-state verdict.
 *
 * `value` is nullable — a deliberate C2 tightening of A2's original (non-nullable) shape,
 * safe because nothing had written to these collections yet (adFeatures/adsetFeatures/
 * accountFeatures/creativeFamilyFeatures were all empty). This is required by §6.3's own
 * binding rule, restated in IMPLEMENTATION_PLAN.md B7 and C2: "never silently report zero
 * revenue" for an ad the URL-tag audit says is unresolvable — that is a genuinely unmeasured
 * figure, not a measured zero, and a non-nullable `value` had no way to say so. C2 sets
 * `value: null` (never `0`) for exactly that case; every other metric that legitimately had
 * no purchases in a window is a real, measured `0`.
 */
export const metricWithInterval = z.object({
  value: z.number().nullable(),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
  sampleSize: z.number().int().nonnegative(), // §12: every business metric carries sampleSize
  verdict: z.enum(["ABOVE_TARGET", "BELOW_TARGET", "NOT_DISTINGUISHABLE"]).nullable(),
});
export type MetricWithInterval = z.infer<typeof metricWithInterval>;

/**
 * The gap-safety flag every Shopify-derived figure in a window carries (IMPLEMENTATION_PLAN.md
 * C1's gap-marking note, and C2's own binding requirement). One object per window rather than
 * one flag per field: every Shopify-sourced field in a given `WindowMetrics` object was derived
 * from the exact same `[startDay, endDay]` range, so they share one gap verdict by construction
 * — see `services/analytics/features/shopifyWindowAggregate.ts`'s module comment for how this
 * is made structural (a caller cannot obtain a Shopify window total without this coming back
 * attached to it) rather than a convention a future author has to remember. Applies ONLY to the
 * Shopify-sourced fields on `windowMetrics` — `shopifyAttributedPurchases`,
 * `shopifyAttributedRevenueMinorUnits`, `shopifyNetRevenueMinorUnits`, `shopifyRoas`(+Shrunk),
 * `aov`, `newCustomerPercent`, `newCustomerCpaMinorUnits`, `refundRate`,
 * `estimatedContributionMarginMinorUnits`, `blendedMerAccountOnly` — and to
 * `attributionCoverageRatio` only via its Shopify-derived numerator. Every Meta-sourced field
 * (spend, impressions, clicks, ctr, cpm, frequency, metaRoas, metaPurchaseValue, funnel counts)
 * is computed from `metaInsightsDailyNormalized` alone and is genuinely unaffected by a Shopify
 * coverage gap — §6.3/C1's own explicit point.
 */
export const shopifyDataGapSchema = z.object({
  windowHasDataGap: z.boolean(),
  /** Every reporting day inside the window that `shopifyDailyCoverage` flagged (or had no
   * coverage row for at all — treated as a gap, not as "fine", per the aggregator's own
   * fail-safe default). Empty when `windowHasDataGap` is `false`. */
  gapDays: z.array(reportingDay),
});
export type ShopifyDataGap = z.infer<typeof shopifyDataGapSchema>;

/**
 * C5's contract, verbatim (IMPLEMENTATION_PLAN.md C2's brief: "the interface is FIXED... code
 * against exactly this"). Attached to every window C2 emits, per that same brief — "the seasonal
 * label(s) the window spans, and a windowSpansSeasonalBoundary flag" (renamed `seasonality` here
 * to nest C5's whole object rather than flattening it across several ad hoc fields).
 */
export const seasonalityContextSchema = z.object({
  labels: z.array(z.string()),
  spansSeasonalBoundary: z.boolean(),
  demandIndex: z.number().nullable(),
  demandIndexSampleSize: z.number().int().nonnegative(),
  summaryText: z.string(),
});
export type SeasonalityContextSnapshot = z.infer<typeof seasonalityContextSchema>;

/** §12 — one window's worth of delivery/traffic/funnel/business/seasonality data. */
export const windowMetrics = z
  .object({
    // §5.3: carried through from the underlying metaInsightsDailyNormalized rows verbatim, never
    // re-derived or defaulted. `null` when the window has zero Meta rows, or when the rows
    // inside it disagree (the canon changed mid-window — §5.3's "invalidate trend features that
    // span the boundary" case) — see metaWindowAggregate.ts's own comment.
    attribution: attributionProvenance.nullable(),
    // Delivery
    spendMinorUnits: z.number().int().nonnegative(),
    impressions: z.number().int().nonnegative(),
    reach: z.number().int().nonnegative(), // sum of daily reach — see C2's aggregator comment
    frequency: z.number().nullable(), // impressions / reach; null when reach is 0
    cpmMinorUnits: z.number().nullable(), // null when impressions is 0
    // Traffic
    clicks: z.number().int().nonnegative(),
    ctr: z.number().nullable(), // clicks / impressions; null when impressions is 0
    cpcMinorUnits: z.number().nullable(), // null when clicks is 0
    landingPageViews: z.number().int().nonnegative(),
    // Funnel (from Meta actions, §7.2) — counts, then the rates between them
    addToCart: z.number().int().nonnegative(),
    checkoutStarted: z.number().int().nonnegative(),
    cvr: z.number().nullable(), // purchases / clicks; null when clicks is 0
    addToCartRate: z.number().nullable(), // addToCart / landingPageViews
    checkoutStartedRate: z.number().nullable(), // checkoutStarted / addToCart
    purchaseRate: z.number().nullable(), // purchases / checkoutStarted
    // Business — Meta side (always populated; never gap-affected)
    purchases: metricWithInterval, // Meta-reported, under the pinned attribution provenance
    metaPurchaseValueMinorUnits: z.number().int(),
    metaRoas: metricWithInterval,
    metaRoasShrunk: z.number().nullable(), // §15.3 — C3's job; C2 always writes null
    // Business — Shopify side (gap-affected; see shopifyDataGapSchema's own comment for exactly
    // which of these fields it covers). `null` on an individual ad means the URL-tag audit
    // (B7) found this ad's destination URL unresolvable — excluded, never reported as zero
    // (§6.3). A real, measured zero (a resolvable ad with zero attributed orders this window)
    // is `0`, not `null`.
    shopifyAttributedPurchases: z.number().int().nonnegative().nullable(),
    shopifyAttributedRevenueMinorUnits: z.number().int().nullable(),
    shopifyNetRevenueMinorUnits: z.number().int().nullable(), // attributed revenue - attributed refunds
    shopifyRoas: metricWithInterval,
    shopifyRoasShrunk: z.number().nullable(), // §15.3 — C3's job; C2 always writes null
    shopifyDataGap: shopifyDataGapSchema,
    attributionCoverageRatio: z.number().nullable(), // §6.3 — level not meaningful, drift is
    attributionCoverageRatioIncludingNameMatch: z.number().nullable(), // upper bound, never merged
    cpa: metricWithInterval, // Meta spend / Meta-reported purchases — matches Ads Manager CPA
    aov: z.number().nullable(), // attributed gross revenue / attributed purchases
    newCustomerPercent: z.number().nullable(),
    newCustomerCpaMinorUnits: z.number().nullable(), // spend / attributed new-customer orders
    refundRate: z.number().nullable(), // attributed refund amount / attributed gross revenue
    // "Estimated" per §12's own wording — see services/analytics/features's module comment for
    // the exact (deliberately simple) formula and why: no COGS/margin-percent data exists
    // anywhere in this system yet.
    estimatedContributionMarginMinorUnits: z.number().int().nullable(),
    // §6.3's third consequence, C2's own deliverable: account-level-only (null at every other
    // entity level, and null when there was no Meta spend this window — computeBlendedMer's own
    // "undefined, not zero" convention). Uses NEITHER attribution — total Shopify revenue over
    // total Meta spend, gap-flagged the same as every other Shopify-derived figure.
    blendedMerAccountOnly: z.number().nullable(),
    // C5's contract, attached per-window (see seasonalityContextSchema's own comment). Never
    // used to adjust any metric above — descriptive context only, per C5/C2's explicit "do not
    // de-seasonalise" instruction.
    seasonality: seasonalityContextSchema,
  })
  .partial();
export type WindowMetrics = z.infer<typeof windowMetrics>;

/** §12 Trend — vs. previous equivalent window. §4.2: 7d is trend-only, never a gate — C2
 * computes trend as current-7d vs the immediately preceding 7d (see services/analytics/
 * features/trend.ts's module comment for why 7d specifically, not one of the other windows). */
export const trendMetrics = z
  .object({
    roasChangePercent: z.number().nullable(),
    cpaChangePercent: z.number().nullable(),
    ctrChangePercent: z.number().nullable(),
    cvrChangePercent: z.number().nullable(),
    cpmChangePercent: z.number().nullable(),
    frequencyChangePercent: z.number().nullable(),
    spendVelocityChangePercent: z.number().nullable(),
    purchaseVolumeTrend: z.enum(["UP", "DOWN", "STABLE"]).nullable(),
  })
  .partial();
export type TrendMetrics = z.infer<typeof trendMetrics>;

/** §13 — the `hoursSince…` / `…ChangesLastNDays` family, derived from metaChangeEvents. C4's
 * deliverable; C2 always writes `{}` (every field optional via `.partial()`). */
export const changeAwareFeatures = z
  .object({
    hoursSinceLastBudgetChange: z.number(),
    lastBudgetChangePercent: z.number(),
    budgetChangesLast7Days: z.number().int().nonnegative(),
    hoursSinceLastAudienceChange: z.number(),
    targetingChangesLast14Days: z.number().int().nonnegative(),
    hoursSinceLastCreativeChange: z.number(),
    creativeChangesLast7Days: z.number().int().nonnegative(),
    hoursSinceLastStatusChange: z.number(),
  })
  .partial();
export type ChangeAwareFeatures = z.infer<typeof changeAwareFeatures>;

/** §13.1 — learning-phase state. C4's deliverable; C2 always writes `{}`. */
export const learningPhaseFeatures = z
  .object({
    inLearningPhase: z.boolean(),
    conversionsToExitLearning: z.number().int(),
    learningResetAt: firestoreTimestamp,
    learningResetCause: z.string(),
  })
  .partial();
export type LearningPhaseFeatures = z.infer<typeof learningPhaseFeatures>;

export const windowLabel = z.enum(["7d", "14d", "28d", "56d"]);
export type WindowLabel = z.infer<typeof windowLabel>;

/**
 * Shared shape for adFeatures/{adId}, adsetFeatures/{adsetId|campaignId},
 * creativeFamilyFeatures/{familyId} and accountFeatures/{accountId}. `entityType`
 * disambiguates what's stored under a given ID — see this file's own ambiguity note.
 */
export const entityFeaturesSchema = z.object({
  entityId: z.string().min(1),
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN", "CREATIVE_FAMILY", "ACCOUNT"]),
  accountDataVersion: z.number().int().nonnegative(), // §10.1 — bumped once per sync run
  computedAt: firestoreTimestamp,
  windows: z.partialRecord(windowLabel, windowMetrics),
  trend: trendMetrics,
  changeAware: changeAwareFeatures,
  learningPhase: learningPhaseFeatures,
});
export type EntityFeatures = z.infer<typeof entityFeaturesSchema>;

// §8 lists three collections; C2 adds a fourth (creativeFamilyFeatures) — see this file's own
// ambiguity note above for why. All four use the same document shape.
export const adFeaturesSchema = entityFeaturesSchema;
export const adsetFeaturesSchema = entityFeaturesSchema;
export const accountFeaturesSchema = entityFeaturesSchema;
export const creativeFamilyFeaturesSchema = entityFeaturesSchema;
