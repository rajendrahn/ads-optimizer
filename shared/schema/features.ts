// Feature collections — §8: adFeatures, adsetFeatures, accountFeatures.
//
// Populated by C2 (base metrics), C3 (intervals/verdicts/shrinkage), C4 (change-aware +
// learning-phase). A2 only fixes the shape — "Out of scope: populating anything... their
// semantics land in C2/D2/D4" (IMPLEMENTATION_PLAN.md A2). Every numeric field below is
// nullable/partial for that reason: a real recompute may not populate every metric for
// every entity type immediately, and this is a stub, not a contract C2 must fill exactly.
//
// Ambiguity surfaced (see A2's "Notes from implementation" for the full note): §12 computes
// metrics "at ad, ad set, campaign, creative family and account level" — five levels — but
// §8 lists only three feature collections (adFeatures, adsetFeatures, accountFeatures).
// Campaign-level and creative-family-level metrics have no named collection. This schema
// stays deliberately generic (an `entityType` discriminator on one shape, reused across
// collections) so C2 can decide — store campaign features in adsetFeatures keyed by
// campaign ID with entityType "CAMPAIGN", store family features on creativeFamilies
// directly (§11.3 already lists family metrics as fields on that document), or add a fourth
// collection — without a schema change forced by this file.
//
// Second ambiguity: §14's evidence JSON example uses flat, window-suffixed field names
// (`roas28d`, `roas28dShrunk`, `cpa28d`). That is the shape of the *evidence object* D1
// assembles for the model, not necessarily the shape of the underlying feature store. This
// schema instead nests metrics under a `windows` map keyed by window label, to avoid
// hand-writing every §12 metric four times over (once per window). Flattening a nested
// feature doc into §14's flat evidence shape is a small, mechanical step for D1; the reverse
// (un-flattening 60+ ad hoc fields) would not have been. If C2 lands on the flat shape
// instead, treat this as a schema revision, not a design violation this file already made.

import { z } from "zod";
import { firestoreTimestamp } from "./common.ts";

/** §15.2: every ROAS/CPA figure carries an interval and a three-state verdict. */
export const metricWithInterval = z.object({
  value: z.number(),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
  sampleSize: z.number().int().nonnegative(), // §12: every business metric carries sampleSize
  verdict: z.enum(["ABOVE_TARGET", "BELOW_TARGET", "NOT_DISTINGUISHABLE"]).nullable(),
});
export type MetricWithInterval = z.infer<typeof metricWithInterval>;

/** §12 — one window's worth of delivery/traffic/funnel/business metrics. */
export const windowMetrics = z
  .object({
    // Delivery
    spendMinorUnits: z.number().int().nonnegative(),
    impressions: z.number().int().nonnegative(),
    reach: z.number().int().nonnegative(),
    frequency: z.number(),
    cpmMinorUnits: z.number(),
    // Traffic
    clicks: z.number().int().nonnegative(),
    ctr: z.number(),
    cpcMinorUnits: z.number(),
    landingPageViews: z.number().int().nonnegative(),
    // Funnel (from Meta actions, §7.2)
    addToCart: z.number().int().nonnegative(),
    checkoutStarted: z.number().int().nonnegative(),
    // Business
    purchases: metricWithInterval,
    metaPurchaseValueMinorUnits: z.number().int(),
    metaRoas: metricWithInterval,
    metaRoasShrunk: z.number(), // §15.3 — raw and shrunk both stored
    shopifyAttributedPurchases: z.number().int().nonnegative(),
    shopifyAttributedRevenueMinorUnits: z.number().int(),
    shopifyNetRevenueMinorUnits: z.number().int(),
    shopifyRoas: metricWithInterval,
    shopifyRoasShrunk: z.number(),
    attributionCoverageRatio: z.number(), // §6.3 — level not meaningful, drift is
    cpa: metricWithInterval,
    aov: z.number(),
    newCustomerPercent: z.number(),
    newCustomerCpaMinorUnits: z.number(),
    refundRate: z.number(),
    estimatedContributionMarginMinorUnits: z.number().int(),
  })
  .partial();
export type WindowMetrics = z.infer<typeof windowMetrics>;

/** §12 Trend — vs. previous equivalent window. §4.2: 7d is trend-only, never a gate. */
export const trendMetrics = z
  .object({
    roasChangePercent: z.number(),
    cpaChangePercent: z.number(),
    ctrChangePercent: z.number(),
    cvrChangePercent: z.number(),
    cpmChangePercent: z.number(),
    frequencyChangePercent: z.number(),
    spendVelocityChangePercent: z.number(),
    purchaseVolumeTrend: z.enum(["UP", "DOWN", "STABLE"]),
  })
  .partial();
export type TrendMetrics = z.infer<typeof trendMetrics>;

/** §13 — the `hoursSince…` / `…ChangesLastNDays` family, derived from metaChangeEvents. */
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

/** §13.1 — learning-phase state; sits high in the decision packet once D2 renders it. */
export const learningPhaseFeatures = z
  .object({
    inLearningPhase: z.boolean(),
    conversionsToExitLearning: z.number().int(),
    learningResetAt: firestoreTimestamp,
    learningResetCause: z.string(),
  })
  .partial();
export type LearningPhaseFeatures = z.infer<typeof learningPhaseFeatures>;

const windowLabel = z.enum(["7d", "14d", "28d", "56d"]);
export type WindowLabel = z.infer<typeof windowLabel>;

/**
 * Shared shape for adFeatures/{adId}, adsetFeatures/{adsetId} and accountFeatures/{accountId}.
 * `entityType` disambiguates what's stored under a given ID — see the campaign/family
 * ambiguity note at the top of this file.
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

// §8 lists three collections; all three use the same document shape today (see the
// campaign/family ambiguity note above for why there are only three).
export const adFeaturesSchema = entityFeaturesSchema;
export const adsetFeaturesSchema = entityFeaturesSchema;
export const accountFeaturesSchema = entityFeaturesSchema;
