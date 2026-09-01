// D5 — the guardrail validator (§20.2). "Guardrails enforced in code after the model returns —
// never delegated to the model."
//
// ============================================================================================
// STRUCTURAL GUARANTEE — read this before adding a parameter to `validateGuardrails`.
// ============================================================================================
// D3.1's own live injection test proved that a knowledge entry instructing the model to "ignore
// all guardrails" could not change a guardrail outcome, and the reason it held is STRUCTURAL, not
// behavioural: the validator never had a reference to the knowledge document at all
// (IMPLEMENTATION_PLAN.md D3's notes: "a knowledge entry cannot change which code path validates
// the output, because the validator has no reference to the knowledge document at all").
//
// `GuardrailInput` below is exactly three fields — `recommendation` (the model's STRUCTURED
// output only: enums, numbers, strings the model chose to write, never raw knowledge-document
// text), `evidenceResult` (D1's independently-computed evidence — resolved BEFORE the model ever
// ran, from this account's own Meta/Shopify data, with no reference to the knowledge document
// either), and `canon` (this account's settings, for the configured limits). There is no
// `knowledge`, `provenance`, `toolCallLog`, or free-text field anywhere in this module's inputs.
//
// DO NOT add one. If a future need arises to record which knowledge version produced a rejected
// recommendation, that is an AUDIT concern — record it in the rejection LOG, downstream of this
// module's decision (see guardrailLog.ts's own `adOptimizationKnowledgeVersion` parameter, which
// is written to Firestore only AFTER `validateGuardrails` has already returned a verdict, and is
// never read back into a decision). Adding a knowledge/provenance parameter here — even one
// nobody intends to branch on today — is exactly the seam a future author could accidentally wire
// a limit-relaxation into; keeping it absent from the type signature is what makes that a
// compile error instead of a code-review judgment call.
// ============================================================================================

import type { WindowLabel } from "@shared/schema/index.ts";
import type { CanonSettings } from "@shared/canon/index.ts";
import {
  resolveGuardrailThresholds,
  guardrailThresholdsSource,
  resolveStatisticalThresholds,
} from "@shared/canon/index.ts";
import type { GuardrailViolation } from "@shared/schema/index.ts";
import type { ScalableEntityRef, ScalingEvidenceResult } from "@services/evidence/index.ts";
import type { RecommendationOutput } from "./types.ts";

export interface GuardrailInput {
  /** The model's own structured output — D3's `recommendationOutputSchema`. */
  recommendation: RecommendationOutput;
  /** D1's independently-computed evidence for the SAME named entity the recommendation answers,
   * resolved by `resolveScalingEvidence` before the model ever ran. This — not anything the model
   * said, and not the knowledge document — is the "independently-computed evidence" every
   * guardrail below is judged against. */
  evidenceResult: ScalingEvidenceResult;
  canon: CanonSettings;
}

export interface GuardrailApproval {
  outcome: "APPROVED";
  /** The confidence to actually persist — always <= `recommendation.confidence`. §20.2:
   * "confidence reduced after very recent major edits, and for composite creatives." This is
   * never a read of the model's own stated confidence minus some model-reported adjustment — it
   * is computed here, independently, from D1's own evidence fields, so a model that already
   * "remembered" to lower its confidence and one that didn't are treated identically. */
  adjustedConfidence: number;
  /** Human-readable reasons an adjustment was applied, `[]` when none. */
  confidenceAdjustments: string[];
}

export interface GuardrailRejection {
  outcome: "REJECTED";
  violations: GuardrailViolation[];
  /** Every violation's message, joined — the same string persisted to both
   * `recommendations/{id}.guardrailRejection.reason` and the rejection log's own `reason` field. */
  reason: string;
}

export type GuardrailDecision = GuardrailApproval | GuardrailRejection;

function resolvedDecisionUnitOf(evidenceResult: ScalingEvidenceResult): ScalableEntityRef | null {
  if (evidenceResult.outcome === "EVIDENCE") return evidenceResult.evidence.decisionUnit;
  if (evidenceResult.outcome === "NOT_DELIVERING") return evidenceResult.decisionUnit;
  return null; // NO_DECISION_UNIT
}

function sameEntity(a: ScalableEntityRef | null, b: { type: string; id: string } | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.id === b.id;
}

/**
 * §20.2's "decision unit is not the actual budget owner -> rejected." The model is expected to
 * pass through D1's own resolution honestly (D2's packet states escalation prominently precisely
 * so it can); this catches the case where it didn't — whether from a genuine model error or,
 * hypothetically, a compromised/poisoned run that tried to name a different entity than the one
 * evidence actually supports. It is checked purely by comparing two entity refs — nothing here
 * asks WHY the model named what it named.
 */
function checkDecisionUnit(
  recommendation: RecommendationOutput,
  evidenceResult: ScalingEvidenceResult,
): GuardrailViolation[] {
  const claimed = recommendation.decisionUnit;
  if (claimed === null) return []; // an honest "no decision unit" claim needs no check
  const resolved = resolvedDecisionUnitOf(evidenceResult);
  if (resolved === null) {
    const detail =
      evidenceResult.outcome === "NO_DECISION_UNIT" ? evidenceResult.detail : "unknown";
    return [
      {
        code: "NO_DECISION_UNIT",
        message:
          `Model named decision unit ${claimed.type}/${claimed.id}, but the independently-resolved ` +
          `evidence engine (D1) found no budget owner for this question at all: ${detail}`,
        judgedAgainst: null,
      },
    ];
  }
  if (!sameEntity(resolved, claimed)) {
    return [
      {
        code: "DECISION_UNIT_NOT_BUDGET_OWNER",
        message:
          `Model named decision unit ${claimed.type}/${claimed.id}, but the independently-resolved ` +
          `budget owner (D1) is ${resolved.type}/${resolved.id}. A recommendation may only act on ` +
          `the entity that actually owns the budget being changed.`,
        judgedAgainst: null,
      },
    ];
  }
  return [];
}

/**
 * §20.2's "minimum spend and purchase requirements not met -> rejected" — plus, structurally
 * folded into the same check, D1's own NOT_DELIVERING/NO_DECISION_UNIT outcomes (reality #2/#3):
 * a recommendation cannot be judged against "the primary window's spend and purchases" when
 * there IS no primary window with real evidence behind it. Skipped entirely when the model
 * already, honestly, answered `INSUFFICIENT_DATA` — there is nothing to downgrade further.
 */
function checkEvidenceSufficiency(
  recommendation: RecommendationOutput,
  evidenceResult: ScalingEvidenceResult,
  canon: CanonSettings,
): GuardrailViolation[] {
  if (recommendation.recommendation === "INSUFFICIENT_DATA") return [];

  if (evidenceResult.outcome === "NO_DECISION_UNIT") {
    // Already caught by checkDecisionUnit whenever the model named a unit; if it named none but
    // still proposed an action, that is itself evidence-insufficiency.
    if (recommendation.decisionUnit === null) {
      return [
        {
          code: "NO_DECISION_UNIT",
          message:
            `Model proposed "${recommendation.recommendation}" without naming a decision unit, but ` +
            `the independently-resolved evidence engine (D1) found no budget owner at all: ` +
            `${evidenceResult.detail}`,
          judgedAgainst: null,
        },
      ];
    }
    return [];
  }

  if (evidenceResult.outcome === "NOT_DELIVERING") {
    return [
      {
        code: "NOT_DELIVERING",
        message:
          `Decision unit ${evidenceResult.decisionUnit.type}/${evidenceResult.decisionUnit.id} has ` +
          `zero spend and zero impressions in its primary window — there is no evidence to support ` +
          `"${recommendation.recommendation}".`,
        judgedAgainst: null,
      },
    ];
  }

  // outcome === "EVIDENCE" — independently re-check the primary window's own spend/purchases
  // against configured minimums, never trusting the model's own summary of them.
  const evidence = evidenceResult.evidence;
  const primaryWindow: WindowLabel = evidence.primaryWindow;
  const windowEvidence = evidence.evidence.windows[primaryWindow];
  const actualSpend = windowEvidence?.spendMinorUnits ?? 0;
  const actualPurchases = windowEvidence?.metaRoas.purchases ?? 0;

  const stats = resolveStatisticalThresholds(canon);
  const guardrails = resolveGuardrailThresholds(canon);
  const source = guardrailThresholdsSource(canon);
  const purchaseFloor = stats.minPurchaseFloors[primaryWindow];
  const spendFloor = guardrails.minSpendMinorUnits[primaryWindow];

  const violations: GuardrailViolation[] = [];
  if (purchaseFloor !== undefined && actualPurchases < purchaseFloor) {
    violations.push({
      code: "MIN_PURCHASES_NOT_MET",
      message:
        `Primary window (${primaryWindow}) has ${actualPurchases} purchase(s), below the ` +
        `configured minimum of ${purchaseFloor} (statisticalThresholds.minPurchaseFloors.` +
        `${primaryWindow}, source: ${evidence.targets.source}).`,
      judgedAgainst: {
        field: `statisticalThresholds.minPurchaseFloors.${primaryWindow}`,
        limit: purchaseFloor,
        source: evidence.targets.source,
        actual: actualPurchases,
      },
    });
  }
  if (spendFloor !== undefined && actualSpend < spendFloor) {
    violations.push({
      code: "MIN_SPEND_NOT_MET",
      message:
        `Primary window (${primaryWindow}) has ${actualSpend} minor units of spend, below the ` +
        `configured minimum of ${spendFloor} (guardrailThresholds.minSpendMinorUnits.` +
        `${primaryWindow}, source: ${source}).`,
      judgedAgainst: {
        field: `guardrailThresholds.minSpendMinorUnits.${primaryWindow}`,
        limit: spendFloor,
        source,
        actual: actualSpend,
      },
    });
  }
  return violations;
}

/**
 * §20.2's "budget change above the configured maximum percentage -> rejected." Checked
 * unconditionally whenever the model supplied a non-null `changePercent`, regardless of what
 * `recommendation` type it attached to that number — the number itself is what carries the risk
 * (a Meta learning-phase reset, C4/D1's own reasoning), not the label the model gave it.
 */
function checkMaxChangePercent(
  recommendation: RecommendationOutput,
  canon: CanonSettings,
): GuardrailViolation[] {
  if (recommendation.changePercent === null) return [];
  const guardrails = resolveGuardrailThresholds(canon);
  const source = guardrailThresholdsSource(canon);
  const actual = Math.abs(recommendation.changePercent);
  if (actual <= guardrails.maxChangePercent) return [];
  return [
    {
      code: "MAX_CHANGE_PERCENT_EXCEEDED",
      message:
        `Recommended change of ${recommendation.changePercent}% exceeds the configured maximum ` +
        `of ${guardrails.maxChangePercent}% (guardrailThresholds.maxChangePercent, source: ${source}).`,
      judgedAgainst: {
        field: "guardrailThresholds.maxChangePercent",
        limit: guardrails.maxChangePercent,
        source,
        actual,
      },
    },
  ];
}

/** §20.2's "confidence reduced after very recent major edits, and for composite creatives" —
 * computed only when there IS real evidence to reduce confidence about; NOT_DELIVERING/
 * NO_DECISION_UNIT recommendations are rejected outright by `checkEvidenceSufficiency` before this
 * ever runs on them (via `validateGuardrails`'s own short-circuit on any violation). */
function computeAdjustedConfidence(
  recommendation: RecommendationOutput,
  evidenceResult: ScalingEvidenceResult,
  canon: CanonSettings,
): { adjustedConfidence: number; confidenceAdjustments: string[] } {
  let confidence = recommendation.confidence;
  const adjustments: string[] = [];

  if (evidenceResult.outcome === "EVIDENCE") {
    const guardrails = resolveGuardrailThresholds(canon);
    const evidence = evidenceResult.evidence;

    if (evidence.evidence.recentChanges.recentMajorChanges) {
      const m = guardrails.confidencePenalty.recentMajorChangeMultiplier;
      confidence *= m;
      adjustments.push(
        `reduced ×${m} for a recent major change on this decision unit ` +
          `(evidence.recentChanges.recentMajorChanges = true)`,
      );
    }

    const fatigue = evidence.evidence.creativeFatigue;
    if (fatigue.applicable && fatigue.creativeType === "COMPOSITE") {
      const m = guardrails.confidencePenalty.compositeCreativeMultiplier;
      confidence *= m;
      adjustments.push(
        `reduced ×${m} for a composite/dynamic creative (not eligible for family fatigue scoring, ` +
          `§7.3)`,
      );
    }
  }

  return {
    adjustedConfidence: Math.max(0, Math.min(1, confidence)),
    confidenceAdjustments: adjustments,
  };
}

/**
 * The guardrail validator itself. Runs every §20.2 check in code, after the model has already
 * returned its structured output, and returns either an APPROVED decision (with the confidence
 * this system will actually persist — possibly lower than what the model reported) or a REJECTED
 * one (every independently-true violation, never just the first).
 */
export function validateGuardrails(input: GuardrailInput): GuardrailDecision {
  const { recommendation, evidenceResult, canon } = input;

  const violations: GuardrailViolation[] = [
    ...checkDecisionUnit(recommendation, evidenceResult),
    ...checkEvidenceSufficiency(recommendation, evidenceResult, canon),
    ...checkMaxChangePercent(recommendation, canon),
  ];

  if (violations.length > 0) {
    return {
      outcome: "REJECTED",
      violations,
      reason: violations.map((v) => v.message).join(" | "),
    };
  }

  const { adjustedConfidence, confidenceAdjustments } = computeAdjustedConfidence(
    recommendation,
    evidenceResult,
    canon,
  );
  return { outcome: "APPROVED", adjustedConfidence, confidenceAdjustments };
}
