// "Compare against what actually happened afterward" (E1's own deliverable list) — computes the
// ACTUAL outcome for a strategy's chosen decision unit over the post-T horizon window, and a
// Brier score component (§21.2: "Score confidence with a Brier score") for strategies that made
// a calibrated probability claim.
//
// No leakage concern applies on this side deliberately: the actual outcome is ground truth by
// definition — it is what we are checking the decision AGAINST, never an input to the decision
// itself. Reconstructing it still goes through the same `PointInTimeArchiveReader`, just
// constructed with a LATER `asOfInstant` (T + horizon, or "everything archived so far" for a
// caller that wants the fullest available ground truth) — the type itself doesn't know or care
// whether it's being used as the decision boundary or the evaluation boundary; that is a matter
// of which instant the CALLER passes to `PointInTimeArchiveReader.create`, not a second, laxer
// code path.

import {
  aggregateMetaWindow,
  type DayRange,
  type MetaWindowTotals,
} from "@services/analytics/features/index.ts";
import {
  computeVerdict,
  poissonCountInterval,
  scaleIntervalByCount,
  type Verdict,
} from "@services/analytics/statistics/index.ts";
import type { MetaInsightsDailyNormalized } from "@shared/schema/index.ts";
import type { BacktestRecommendation } from "./strategies.ts";

export interface ActualOutcome {
  decisionUnit: { type: "ADSET"; id: string } | null;
  window: DayRange;
  meta: MetaWindowTotals | null;
  metaRoas: number | null;
  verdict: Verdict | null;
  /** True when the post-period metaRoas verdict came back ABOVE_TARGET — the "did scaling this
   * look like it paid off" indicator an INCREASE_BUDGET recommendation is scored against. `null`
   * when there's no decision unit to score (the strategy answered INSUFFICIENT_DATA). */
  scaledSuccessfully: boolean | null;
}

export function computeActualOutcome(
  recommendation: BacktestRecommendation,
  allRowsInHorizon: readonly MetaInsightsDailyNormalized[],
  window: DayRange,
  reportingCurrency: string,
  targetRoas: number,
  intervalZScore: number,
  minPurchaseFloor: number,
): ActualOutcome {
  if (recommendation.decisionUnit === null) {
    return {
      decisionUnit: null,
      window,
      meta: null,
      metaRoas: null,
      verdict: null,
      scaledSuccessfully: null,
    };
  }

  const decisionUnitId = recommendation.decisionUnit.id;
  const rows = allRowsInHorizon.filter(
    (r) =>
      r.adsetId === decisionUnitId &&
      r.reportingDay >= window.startDay &&
      r.reportingDay <= window.endDay,
  );
  const meta = aggregateMetaWindow(rows, reportingCurrency);
  const metaRoas =
    meta.spendMinorUnits === 0 ? null : meta.purchaseValueMinorUnits / meta.spendMinorUnits;

  let verdict: Verdict | null = null;
  if (metaRoas !== null && meta.purchases > 0) {
    const countInterval = poissonCountInterval(meta.purchases, intervalZScore);
    if (countInterval !== null) {
      const scaled = scaleIntervalByCount(
        metaRoas,
        meta.purchases,
        countInterval,
        "increasingWithCount",
      );
      // Below the purchase floor the interval is real but this system would not trust it as a
      // confident verdict either — matches C3's own "below floor -> NOT_DISTINGUISHABLE" rule
      // (windowStatistics.ts) so the outcome side is judged by the same bar the decision side was.
      verdict =
        meta.purchases < minPurchaseFloor
          ? "NOT_DISTINGUISHABLE"
          : computeVerdict(scaled.low, scaled.high, targetRoas);
    }
  } else if (metaRoas !== null && meta.purchases === 0) {
    verdict = "NOT_DISTINGUISHABLE";
  }

  return {
    decisionUnit: recommendation.decisionUnit,
    window,
    meta,
    metaRoas,
    verdict,
    scaledSuccessfully: verdict === null ? null : verdict === "ABOVE_TARGET",
  };
}

/**
 * §21.2: "Score confidence with a Brier score." Only meaningful for a strategy that (a)
 * recommended INCREASE_BUDGET and (b) stated a calibrated confidence — NAIVE never does (see
 * strategies.ts), so its component is always `null`, an honest "no probability claim to score",
 * never a fabricated one. `null` also when the recommendation itself was INSUFFICIENT_DATA/HOLD
 * (no scale prediction was made) or the actual outcome couldn't be measured
 * (`scaledSuccessfully === null`, e.g. the decision unit had zero spend in the horizon window).
 */
export function computeBrierScoreComponent(
  recommendation: BacktestRecommendation,
  outcome: ActualOutcome,
): number | null {
  if (recommendation.recommendation !== "INCREASE_BUDGET") return null;
  if (recommendation.confidence === null) return null;
  if (outcome.scaledSuccessfully === null) return null;
  const actual = outcome.scaledSuccessfully ? 1 : 0;
  const diff = recommendation.confidence - actual;
  return diff * diff;
}
