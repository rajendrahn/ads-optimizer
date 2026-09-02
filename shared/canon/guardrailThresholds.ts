// D5 — guardrail thresholds. §20.2: "Guardrails are validated server-side after the model
// returns, not delegated to the model." This file is the ONE sanctioned place those limits are
// configured — services/reasoner/guardrails.ts must read them through `resolveGuardrailThresholds`
// below, never inline a number of its own, so that (a) a rejection is always judged against a
// visible, named limit and its source (settings vs. default), and (b) an operator correcting a
// limit later changes future outcomes without invalidating what a past rejection log entry says
// it was judged against at the time.
//
// Deliberately its OWN settings block, not folded into C3's `statisticalThresholds` — a
// statistical floor (§15.1, "is this verdict distinguishable from noise") and a guardrail limit
// (§20.2, "is this specific proposed action safe to let through") are different questions, even
// though one guardrail below (`minPurchaseFloors`) happens to reuse C3's own numbers rather than
// invent a second, redundant "minimum purchases" concept — see `resolveMinPurchasesGuardrail`.
// Same optional/code-default pattern as `statisticalThresholds.ts` (see that file's own module
// comment for why: `TEST_CANON` and ~13 other fixtures are typed `CanonSettings` and would break
// on a required field with no default; a wrong guardrail default still produces an HONEST
// rejection/approval, not a silently corrupted stored fact).

import { z } from "zod";
import { windowLabel, type WindowLabel } from "../schema/features.ts";
import { DEFAULT_MIN_PURCHASE_FLOORS } from "./statisticalThresholds.ts";

/**
 * The maximum |changePercent| a guardrail-approved recommendation may carry — §20.2's "budget
 * change above the configured maximum percentage -> rejected."
 *
 * Pinned to the SAME numeric value as C4's `MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT`
 * (services/analytics/changeFeatures/constants.ts) — deliberately, not coincidentally: that is
 * the magnitude C4 measured Meta itself treating as a "material" edit that restarts the
 * learning-phase clock, i.e. the actual mechanism this guardrail exists to protect against
 * (§13.1's "they give the maximum-change guardrail a real mechanism rather than a folk
 * heuristic"). D1's own candidate safe range (`services/evidence/eligibility.ts`,
 * `SAFE_RANGE_UPPER_PERCENT = MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT - 5 = 15`) already builds
 * in a 5-point margin below this same number so a suggestion at the very top of D1's own proposed
 * range still cannot itself trip this guardrail. This constant cannot literally import C4's
 * (`shared/` never imports from `services/`, by this codebase's own layering — confirmed by
 * grepping the whole `shared/` tree for a `services/` import before writing this file: there are
 * none) — kept in sync instead by a cross-file equality test,
 * `services/reasoner/guardrails.test.ts`'s "stays pinned to C4's own material-change threshold"
 * case, which fails loudly if the two are ever edited independently.
 */
export const DEFAULT_MAX_CHANGE_PERCENT = 20;

/**
 * §20.2's "minimum spend ... requirements not met -> rejected." Distinct from
 * `minPurchaseFloors` (below) — an entity can clear a purchase floor on very little spend if its
 * average order value happens to be high, and a guardrail meant to catch "not enough evidence to
 * safely act" should independently ask both questions.
 *
 * Values are `minPurchaseFloors[window] * REAL_MEASURED_ACCOUNT_CPA_MINOR_UNITS` — i.e. "would
 * clearing this window's purchase floor, at this account's own REAL measured cost-per-purchase
 * (not the ₹1,500 placeholder `targetCpaMinorUnits`), plausibly require this much spend." Grounded
 * in a real number for the same reason C3's own defaults are: not tuned to manufacture a
 * particular pass/fail rate. ₹1,761.63 (176,163 paise) is this system's own live, non-mutating
 * Meta Insights reconciliation over a real 7-day window (IMPLEMENTATION_PLAN.md C2's notes,
 * reconfirmed in C3/D2's own notes) — deliberately NOT `targetCpaMinorUnits`, which C3's own notes
 * document as a placeholder business input an operator has not yet set for this account.
 */
// ⚠️ CORRECTED after the first real production recommendation was rejected by this guardrail.
//
// The original derivation was `minPurchaseFloors[window] * REAL_MEASURED_ACCOUNT_CPA` (₹1,761,
// the account-wide figure measured during the build). Its reasoning — "clearing the purchase
// floor at this account's real CPA would need about this much spend" — is backwards in the case
// that matters: an EFFICIENT entity reaches the purchase floor on LESS spend, and so fails the
// floor precisely because it is performing well.
//
// Observed live: ad set 120239462136610171 reached 44 purchases (above the 30 floor) at a CPA of
// ₹586, spending ₹25,764 — and was rejected for not having spent ₹52,849. The guardrail
// disqualified it for being roughly 3x more cost-efficient than the account average.
//
// Sample adequacy is ALREADY enforced, by C3's `minPurchaseFloors` — that is what "is there
// enough evidence" means here, and it is measured in purchases, not rupees. The only job left
// for a spend floor (§20.2 lists both) is to stop the system acting where the money is trivial:
// a 5-15% budget change on a near-zero spend is not a decision worth making or evaluating.
//
// So this is now an absolute, deliberately LOW materiality bar, scaled by window length rather
// than derived from any CPA. At this account's real scale (~₹700k per 28d across ~46 delivering
// ad sets, so ~₹15k each) these include ordinary ad sets and exclude only genuinely negligible
// ones. They are defaults: an operator who wants a different bar sets
// `settings/{accountId}.guardrailThresholds.minSpendMinorUnits` explicitly, and
// `resolveGuardrailThresholds` reports which source was used.
export const DEFAULT_MIN_SPEND_MINOR_UNITS: Readonly<Record<WindowLabel, number>> = {
  "7d": 250_000, // INR 2,500
  "14d": 500_000, // INR 5,000
  "28d": 1_000_000, // INR 10,000
  "56d": 2_000_000, // INR 20,000
};

/**
 * §20.2's "confidence reduced after very recent major edits, and for composite creatives" — a
 * deliberate, explicitly-documented-as-a-heuristic multiplicative penalty (never presented as a
 * validated statistical figure), matching the same framing D1's own `eligibility.ts` uses for its
 * confidence heuristic. Compounded independently when both conditions hold (order does not
 * matter — multiplication commutes).
 */
export const guardrailConfidencePenaltySchema = z.object({
  /** Applied when `evidence.recentChanges.recentMajorChanges` is true (D1's own, already-computed
   * boolean — the SAME one `RECENT_MAJOR_CHANGE` eligibility gates on, reused rather than a
   * second independently-tuned "recent" window). */
  recentMajorChangeMultiplier: z.number().min(0).max(1),
  /** Applied when the named ad's own creative family is COMPOSITE (B8's typing,
   * `eligibleForFamilyFatigueScore: false` — a dynamic/DCO creative has no single fatigue signal
   * to reason about, per §7.3). */
  compositeCreativeMultiplier: z.number().min(0).max(1),
});
export type GuardrailConfidencePenalty = z.infer<typeof guardrailConfidencePenaltySchema>;

export const DEFAULT_GUARDRAIL_CONFIDENCE_PENALTY: GuardrailConfidencePenalty = {
  recentMajorChangeMultiplier: 0.6,
  compositeCreativeMultiplier: 0.75,
};

export const guardrailThresholdsSchema = z.object({
  maxChangePercent: z.number().positive(),
  minSpendMinorUnits: z.record(windowLabel, z.number().int().nonnegative()),
  confidencePenalty: guardrailConfidencePenaltySchema,
});
export type GuardrailThresholds = z.infer<typeof guardrailThresholdsSchema>;

export const DEFAULT_GUARDRAIL_THRESHOLDS: GuardrailThresholds = {
  maxChangePercent: DEFAULT_MAX_CHANGE_PERCENT,
  minSpendMinorUnits: { ...DEFAULT_MIN_SPEND_MINOR_UNITS },
  confidencePenalty: { ...DEFAULT_GUARDRAIL_CONFIDENCE_PENALTY },
};

/** The one sanctioned way to read guardrail thresholds off a loaded canon — mirrors
 * `resolveStatisticalThresholds`'s own resolution policy exactly. Never read
 * `canon.guardrailThresholds` directly. */
export function resolveGuardrailThresholds(canon: {
  guardrailThresholds?: GuardrailThresholds;
}): GuardrailThresholds {
  return canon.guardrailThresholds ?? DEFAULT_GUARDRAIL_THRESHOLDS;
}

/** Whether the resolved thresholds came from an operator-supplied
 * `settings/{accountId}.guardrailThresholds` document or the built-in placeholder default —
 * mirrors reality #6 (D1's notes): "make it obvious which value a rejection was judged against." */
export function guardrailThresholdsSource(canon: {
  guardrailThresholds?: GuardrailThresholds;
}): "settings" | "default" {
  return canon.guardrailThresholds !== undefined ? "settings" : "default";
}
