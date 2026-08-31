// §15.1 statistical thresholds — the one extension point A2/A3 both deliberately left for this
// step: "extend `canonSettingsSchema` with `.extend(...)` ... don't pre-empt C3's judgment call
// on the shape of those thresholds here" (shared/canon/settings.ts's own module comment).
//
// Deliberately OPTIONAL on the settings document, unlike A3's `modelConfig` (which is required,
// no default). Reasons, stated plainly rather than silently diverging from A3's own "throw on
// absence, never default" philosophy for the reporting canon:
//   1. `TEST_CANON` (services/ingest/meta/entities/testFixtures.ts) is a shared fixture typed
//      `: CanonSettings` and imported by ~13 test files across B2 through C5. Making this field
//      required-with-no-default would be a breaking schema change to every one of those files —
//      exactly the failure mode A2's own orchestrator note warned about ("adding a REQUIRED
//      field to a collection that already holds documents... would break writes across the whole
//      collection at once"). Optional-with-a-code-level-default avoids that blast radius
//      entirely, at the cost of this one field only.
//   2. Unlike the four original §5 fields (timezone/currency/attribution window/action type —
//      genuinely irretrievable if wrong, per §5's own "cannot be retrofitted without a rebuild"),
//      a statistical threshold is a tunable operating parameter with a defensible default an
//      operator can override, not a fact about the data that corrupts records if assumed wrong.
//      A wrong default here still produces an HONEST, if imperfectly calibrated, verdict — never
//      a silently corrupted stored fact the way a wrong timezone would.
//
// `resolveStatisticalThresholds` below is the one place the optional-vs-default resolution
// happens — callers should always go through it, never read `canon.statisticalThresholds`
// directly.

import { z } from "zod";
import { windowLabel, type WindowLabel } from "../schema/features.ts";

/**
 * Per-window minimum purchase floors (§15.1) — below this many purchases in a window, the
 * verdict is forced to `NOT_DISTINGUISHABLE` regardless of what the confidence interval alone
 * would say (see services/analytics/statistics/windowStatistics.ts). Also reused, unmodified, as
 * the shrinkage pseudo-count (§15.3) — an entity sitting exactly at its window's floor is shrunk
 * exactly halfway toward the account mean; see shrinkage.ts's own comment for why sharing this
 * one number is a deliberate simplification, not an oversight.
 *
 * Defaults below are grounded in §2.1's own volume table, not tuned to produce a target
 * distribution of verdicts (the step's own explicit instruction: "do not lower the floors to
 * manufacture verdicts"):
 *   - A Poisson count's relative standard error is ~1/sqrt(n); n=25 caps that at ~20%. 28d (the
 *     primary decision window, §4.2) is set to 30 — a small margin above that statistical
 *     minimum, because §2.1 itself notes the account's real ROAS/CPA distribution is
 *     over-dispersed relative to pure Poisson counting noise (order-value variance, weekday and
 *     festive demand swings, campaign heterogeneity), so a purely Poisson-derived minimum would
 *     understate real-world noise.
 *   - This floor is deliberately HIGHER than §2.1's own measured ad-level volume (~16-32
 *     purchases/28d, per "4-8 purchases per ad per week") and comfortably below its measured
 *     ad-set volume (~80-140/28d, per "20-35 purchases per ad set per week") — by design, so
 *     that most individual ads correctly fail the floor (§4.1's escalation path exists exactly
 *     for this) while most ad sets clear it.
 *   - 14d/7d/56d are set proportionally lower/higher, not because the statistics demand a
 *     different bar for a shorter or longer window, but because a shorter window has structurally
 *     less data available and the design itself (§4.2) already marks 7d "trend direction only,
 *     never a threshold test" and 14d "secondary" — a stricter absolute floor than 28d's own
 *     would make those windows uniformly unusable rather than merely noisier.
 */
export const DEFAULT_MIN_PURCHASE_FLOORS: Readonly<Record<WindowLabel, number>> = {
  "7d": 12,
  "14d": 20,
  "28d": 30,
  "56d": 45,
};

export const statisticalThresholdsSchema = z.object({
  minPurchaseFloors: z.record(windowLabel, z.number().int().nonnegative()),
  /**
   * §14's own worked example uses 3.0 — kept as the default here for the same reason: no real
   * business-supplied ROAS target exists anywhere in this system yet (no field for one in any
   * synced collection, matching the same "no COGS data exists yet" situation C2 documented for
   * `estimatedContributionMarginMinorUnits`). An operator should override this via
   * `settings/{accountId}.statisticalThresholds.targetRoas` once a real target is decided.
   */
  targetRoas: z.number().positive(),
  /**
   * No design section names a target CPA anywhere, unlike targetRoas (§14's example). Defaulted
   * to ₹1,500.00 (150000 paise) — a round number in the neighbourhood of, but below, the real
   * account-level CPA this system's own live reconciliation check measured (₹1,761.63 over a
   * real 7-day window, IMPLEMENTATION_PLAN.md C2's notes) — stated plainly as a placeholder
   * business input, not a validated target, exactly like C2's contribution-margin simplification.
   */
  targetCpaMinorUnits: z.number().int().positive(),
  /**
   * The z-score for the (two-sided) confidence level applied to the Poisson interval — see
   * services/analytics/statistics/interval.ts. Stored as a raw z-score, not a confidence-level
   * percentage, specifically so this module never needs an inverse-normal-CDF implementation
   * (no npm dependency for one, per this step's constraints) — 1.645 ≈ 90%, 1.96 ≈ 95%.
   */
  intervalZScore: z.number().positive(),
});
export type StatisticalThresholds = z.infer<typeof statisticalThresholdsSchema>;

export const DEFAULT_STATISTICAL_THRESHOLDS: StatisticalThresholds = {
  minPurchaseFloors: { ...DEFAULT_MIN_PURCHASE_FLOORS },
  targetRoas: 3.0,
  targetCpaMinorUnits: 150_000,
  intervalZScore: 1.645, // ~90% two-sided
};

/** The one sanctioned way to read statistical thresholds off a loaded canon — resolves the
 * optional-field-with-code-default policy described in this file's own module comment. Never
 * read `canon.statisticalThresholds` directly. */
export function resolveStatisticalThresholds(canon: {
  statisticalThresholds?: StatisticalThresholds;
}): StatisticalThresholds {
  return canon.statisticalThresholds ?? DEFAULT_STATISTICAL_THRESHOLDS;
}
