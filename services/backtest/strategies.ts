// The two strategies E1 compares (§21.2, §29 criterion 10). Both look at the SAME
// point-in-time-reconstructed evidence (evidence.ts) and pick, from the ad sets delivering as of
// T, exactly one to act on — matching `backtestRuns`'s own schema shape (one `decisionUnit` per
// run, not an array).
//
// SYSTEM is a deterministic stand-in for "the recommendation D3's model would have produced",
// per this step's own instruction to prefer a faked reasoner over live/faked LLM calls: since
// D1's eligibility gates (`computeEligibilityAndRange`) and D5's guardrails already bound what a
// real model's structured output is allowed to say (§20.2 — guardrails are enforced in code,
// never delegated to the model), a deterministic function of the SAME evidence the model would
// have reasoned over is a faithful, zero-cost proxy for the guardrail-bounded OUTCOME of that
// reasoning, not an attempt to imitate the model's prose. This is a documented scope choice, not
// a claim that it reproduces what Claude would literally have written — see this step's report.
//
// NAIVE is §29 criterion 10's own literal baseline: "scale whatever had the highest recent
// ROAS" — no eligibility check, no interval, no purchase floor, no guardrail. It exists
// specifically so it CAN be beaten by a strategy that checks those things.

import { computeEligibilityAndRange } from "@services/evidence/eligibility.ts";
import { resolveGuardrailThresholds, type CanonSettings } from "@shared/canon/index.ts";
import type { AdSetWindowEvidence } from "./evidence.ts";

export type BacktestActionType = "INCREASE_BUDGET" | "HOLD" | "INSUFFICIENT_DATA";

export interface BacktestRecommendation {
  strategy: "SYSTEM" | "NAIVE_HIGHEST_RECENT_ROAS";
  decisionUnit: { type: "ADSET"; id: string } | null;
  recommendation: BacktestActionType;
  changePercent: number | null;
  /** `null` when the strategy makes no calibrated probability claim (NAIVE never does — see
   * module comment). SYSTEM's is D1's own `computeEligibilityAndRange` confidence heuristic,
   * possibly further reduced by this file's own max-change-percent guardrail check. */
  confidence: number | null;
  primaryReasons: string[];
  guardrailRejected: boolean;
  guardrailReason: string | null;
}

/**
 * The one guardrail check E1 reuses in spirit from D5 (§20.2) without importing
 * `services/reasoner/` (out of scope for this step, and off-limits per the coordinator's own
 * "stay out of services/reasoner/" instruction to the concurrent guardrail-fix agent): the
 * proposed |changePercent| must not exceed the account's configured maximum. Read through the
 * SAME `resolveGuardrailThresholds` production uses — never a number hardcoded here — so a
 * settings correction changes both production and backtest behaviour together. D5's other checks
 * (decision-unit-is-budget-owner, min spend/purchases) are already covered upstream here: E1
 * never proposes a decision unit that isn't genuinely delivering, and D1's own eligibility gate
 * (reused directly below) already enforces the purchase floor before a change percent is ever
 * produced.
 */
function checkMaxChangePercent(
  changePercent: number | null,
  canon: CanonSettings,
): { rejected: boolean; reason: string | null } {
  if (changePercent === null) return { rejected: false, reason: null };
  const guardrails = resolveGuardrailThresholds(canon);
  if (Math.abs(changePercent) <= guardrails.maxChangePercent)
    return { rejected: false, reason: null };
  return {
    rejected: true,
    reason:
      `Recommended change of ${changePercent}% exceeds the configured maximum of ` +
      `${guardrails.maxChangePercent}% (guardrailThresholds.maxChangePercent).`,
  };
}

/**
 * SYSTEM strategy: among every delivering ad set, evaluate D1's real eligibility gate
 * (`computeEligibilityAndRange`) against the primary window's own verdicts, and pick the
 * eligible candidate with the highest confidence (ties broken by ad set id, for determinism).
 * `learningPhase`/`recentMajorChanges` are not reconstructed from the archive (see evidence.ts's
 * own module comment on scope) — passed as `null`/`false`, the same "no signal available, never
 * a fabricated block" honesty this codebase's own null-vs-zero discipline uses elsewhere.
 */
interface ScoredCandidate {
  evidence: AdSetWindowEvidence;
  changePercent: number;
  confidence: number;
}

export function decideSystemStrategy(
  candidates: readonly AdSetWindowEvidence[],
  canon: CanonSettings,
  minPurchaseFloor: number,
): BacktestRecommendation {
  const eligible: ScoredCandidate[] = [];

  for (const c of candidates) {
    const eligibility = computeEligibilityAndRange({
      isDelivering: c.isDelivering,
      metaRoasVerdict: c.stats.metaRoas.verdict,
      cpaVerdict: c.stats.cpa.verdict,
      inLearningPhase: null,
      recentMajorChanges: false,
      metaRoasSampleSize: c.meta.purchases,
      minPurchaseFloor,
    });
    if (eligibility.eligibleToScale && eligibility.suggestedChangePercent !== null) {
      eligible.push({
        evidence: c,
        changePercent: eligibility.suggestedChangePercent,
        confidence: eligibility.confidence,
      });
    }
  }

  if (eligible.length === 0) {
    return {
      strategy: "SYSTEM",
      decisionUnit: null,
      recommendation: "INSUFFICIENT_DATA",
      changePercent: null,
      confidence: null,
      primaryReasons: [
        "No ad set among those delivering as of the point-in-time reconstruction cleared D1's " +
          "eligibility gate (ROAS above target, CPA not above target, above the purchase floor, " +
          "not below a data gap/seasonal-boundary suppression).",
      ],
      guardrailRejected: false,
      guardrailReason: null,
    };
  }

  eligible.sort(
    (a, b) => b.confidence - a.confidence || a.evidence.adsetId.localeCompare(b.evidence.adsetId),
  );
  const winner = eligible[0];

  const guardrail = checkMaxChangePercent(winner.changePercent, canon);
  if (guardrail.rejected) {
    return {
      strategy: "SYSTEM",
      decisionUnit: { type: "ADSET", id: winner.evidence.adsetId },
      recommendation: "INSUFFICIENT_DATA",
      changePercent: null,
      confidence: null,
      primaryReasons: [`Guardrail-rejected: ${guardrail.reason}`],
      guardrailRejected: true,
      guardrailReason: guardrail.reason,
    };
  }

  return {
    strategy: "SYSTEM",
    decisionUnit: { type: "ADSET", id: winner.evidence.adsetId },
    recommendation: "INCREASE_BUDGET",
    changePercent: winner.changePercent,
    confidence: winner.confidence,
    primaryReasons: [
      `Ad set ${winner.evidence.adsetId}: metaRoas verdict ABOVE_TARGET (${winner.evidence.meta.purchases} ` +
        `purchases, at/above the ${minPurchaseFloor}-purchase floor), cpa verdict not ABOVE_TARGET, delivering.`,
    ],
    guardrailRejected: false,
    guardrailReason: null,
  };
}

/**
 * §29 criterion 10's own naive baseline: whichever delivering ad set has the highest RAW
 * (unshrunk, un-interval-checked, no purchase-floor check) Meta ROAS in the given window is
 * scaled by a fixed amount — no eligibility, no guardrail. `naiveChangePercent` is deliberately
 * NOT clamped to the account's guardrail maximum, because the whole point of this baseline is
 * that it does not check — see module comment.
 */
export function decideNaiveHighestRecentRoas(
  candidates: readonly AdSetWindowEvidence[],
  naiveChangePercent: number,
): BacktestRecommendation {
  const delivering = candidates.filter((c) => c.isDelivering && c.meta.spendMinorUnits > 0);
  if (delivering.length === 0) {
    return {
      strategy: "NAIVE_HIGHEST_RECENT_ROAS",
      decisionUnit: null,
      recommendation: "INSUFFICIENT_DATA",
      changePercent: null,
      confidence: null,
      primaryReasons: ["No ad set had any Meta spend in the window — nothing to rank by ROAS."],
      guardrailRejected: false,
      guardrailReason: null,
    };
  }

  const rawRoas = (c: AdSetWindowEvidence): number =>
    c.meta.purchaseValueMinorUnits / c.meta.spendMinorUnits;

  delivering.sort((a, b) => rawRoas(b) - rawRoas(a) || a.adsetId.localeCompare(b.adsetId));
  const winner = delivering[0];

  return {
    strategy: "NAIVE_HIGHEST_RECENT_ROAS",
    decisionUnit: { type: "ADSET", id: winner.adsetId },
    recommendation: "INCREASE_BUDGET",
    changePercent: naiveChangePercent,
    confidence: null, // naive makes no calibrated probability claim — see module comment
    primaryReasons: [
      `Ad set ${winner.adsetId} had the highest raw Meta ROAS (${rawRoas(winner).toFixed(2)}x) among ` +
        "delivering ad sets in the window — no significance, purchase-floor, or guardrail check applied.",
    ],
    guardrailRejected: false,
    guardrailReason: null,
  };
}
