// The candidate safe action range and eligibility gate (D1's fourth deliverable). This is a
// PROPOSAL, not an enforced guardrail — D5 enforces limits in code after the model returns
// (D1's own "Out of scope" line). Every gate here is independently reported in
// `ineligibleReasons`, not collapsed into one boolean with no explanation.
//
// The range is deliberately anchored to C4's own MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT (20%)
// rather than a second, unrelated magic number: scaling AT OR PAST that threshold immediately
// resets the ad set's learning-phase clock (C4's own model), which would be self-defeating for a
// "scale a winner" recommendation. The safe range therefore stays clear of it with a margin.

import { MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT } from "@services/analytics/changeFeatures/index.ts";
import type { Verdict } from "@services/analytics/statistics/index.ts";
import type { IneligibilityReason } from "./types.ts";

/** Stays clear of the material-change threshold (20%) by a 5-point margin, so a suggestion at
 * the top of the range still cannot itself trigger a learning reset. */
export const SAFE_RANGE_UPPER_PERCENT = MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT - 5;
/** Below this, a budget move is smaller than normal day-to-day auction/pacing variance and is
 * not a meaningful "scale" action. */
export const SAFE_RANGE_LOWER_PERCENT = 5;

export interface EligibilityInput {
  isDelivering: boolean;
  metaRoasVerdict: Verdict | null;
  cpaVerdict: Verdict | null;
  /** `null` when the decision unit is a CAMPAIGN (learning phase is not an ad/ad-set-level
   * concept there — see LearningStateEvidence's own comment) or when C4 has not yet enriched
   * this doc. `null` never blocks eligibility — only a confirmed `true` does. */
  inLearningPhase: boolean | null;
  recentMajorChanges: boolean;
  metaRoasSampleSize: number;
  minPurchaseFloor: number;
}

export interface EligibilityResult {
  eligibleToScale: boolean;
  ineligibleReasons: IneligibilityReason[];
  confidence: number;
  suggestedChangePercent: number | null;
  safeRangePercent: [number, number] | null;
}

/**
 * §15.2's verdict is literal, not direction-aware (computeVerdict's own module comment) — CPA
 * "ABOVE_TARGET" means positioned above the target NUMBER, which for a cost metric is the BAD
 * direction. This is the "is this good" judgement computeVerdict's own comment explicitly defers
 * to D1/D2 — made explicit here rather than silently assumed.
 */
export function computeEligibilityAndRange(input: EligibilityInput): EligibilityResult {
  const reasons: IneligibilityReason[] = [];
  if (!input.isDelivering) reasons.push("NOT_DELIVERING");
  if (input.metaRoasVerdict !== "ABOVE_TARGET") reasons.push("ROAS_NOT_ABOVE_TARGET");
  if (input.cpaVerdict === "ABOVE_TARGET") reasons.push("CPA_ABOVE_TARGET");
  if (input.inLearningPhase === true) reasons.push("IN_LEARNING_PHASE");
  if (input.recentMajorChanges) reasons.push("RECENT_MAJOR_CHANGE");

  if (reasons.length > 0) {
    return {
      eligibleToScale: false,
      ineligibleReasons: reasons,
      confidence: 0,
      suggestedChangePercent: null,
      safeRangePercent: null,
    };
  }

  // Confidence grows with how far above the purchase floor the sample sits, capped at 2x the
  // floor — a simple, monotonic, bounded heuristic (documented as exactly that, not a validated
  // statistical confidence figure): 0.5 right at the floor (the boundary this system already
  // treats as "just barely enough to speak with any confidence" — the same anchor C3's own
  // shrinkage pseudo-count uses), rising to 0.9 at 2x the floor.
  const excessRatio =
    input.minPurchaseFloor > 0
      ? Math.min(1, (input.metaRoasSampleSize - input.minPurchaseFloor) / input.minPurchaseFloor)
      : 1;
  const confidence = Math.max(0.5, Math.min(0.9, 0.5 + 0.4 * excessRatio));

  const suggestedChangePercent = Math.round(
    SAFE_RANGE_LOWER_PERCENT + confidence * (SAFE_RANGE_UPPER_PERCENT - SAFE_RANGE_LOWER_PERCENT),
  );

  return {
    eligibleToScale: true,
    ineligibleReasons: [],
    confidence,
    suggestedChangePercent,
    safeRangePercent: [SAFE_RANGE_LOWER_PERCENT, SAFE_RANGE_UPPER_PERCENT],
  };
}
