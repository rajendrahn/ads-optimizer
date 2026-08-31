// Reality #5: "a suppressed verdict's *reason* must be surfaced, not silently inherited." C3
// already forces NOT_DISTINGUISHABLE for three distinct reasons (below the purchase floor, a
// seasonal-boundary confound, or — for shopifyRoas only — a Shopify data-gap overlap), but the
// stored verdict itself carries only the label, not which of the three applies. This module
// reconstructs the reason from the same inputs C3's own windowStatistics.ts used, so D2 can
// render "we cannot tell" and "we cannot tell BECAUSE half this window has no Shopify data" as
// the different answers they are.

import type { Verdict } from "@services/analytics/statistics/index.ts";

export interface ExplainVerdictInput {
  /** Human label for the metric, used only in the sentence — e.g. "Meta ROAS", "CPA (Meta)",
   * "Shopify ROAS". */
  label: string;
  value: number | null;
  verdict: Verdict | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  sampleSize: number;
  minPurchaseFloor: number;
  target: number;
  spansSeasonalBoundary: boolean;
  seasonalityLabels: readonly string[];
  /** Only meaningful for shopifyRoas — C3 never gates metaRoas/cpa on the Shopify gap (reality
   * #4/#5: the gap is Shopify-only). */
  windowHasDataGap?: boolean;
  gapDays?: readonly string[];
}

function formatInterval(low: number | null, high: number | null): string {
  if (low === null || high === null) return "no interval available";
  return `[${low.toFixed(2)}, ${high.toFixed(2)}]`;
}

export function explainVerdict(input: ExplainVerdictInput): string {
  const { label } = input;

  if (input.value === null) {
    return (
      `${label} was not measured in this window — either it had zero Meta rows in range, or ` +
      `(for a Shopify-attributed figure) the ad's destination URL was found unresolvable by the ` +
      `URL-tag audit (§6.3). This is "not measured", not a real zero.`
    );
  }

  if (input.verdict === null) {
    return `${label} has a value (${input.value}) but no verdict was computed for it.`;
  }

  if (input.verdict !== "NOT_DISTINGUISHABLE") {
    const direction = input.verdict === "ABOVE_TARGET" ? "above" : "below";
    return (
      `${label} is confidently ${direction} the target of ${input.target} — interval ` +
      `${formatInterval(input.intervalLow, input.intervalHigh)} from ${input.sampleSize} purchases.`
    );
  }

  // NOT_DISTINGUISHABLE — determine which of C3's three suppression reasons actually applies,
  // checked in the same priority order windowStatistics.ts applies them (floor, then season,
  // then — shopifyRoas only — the data gap).
  if (input.sampleSize < input.minPurchaseFloor) {
    return (
      `${label} verdict is NOT_DISTINGUISHABLE — only ${input.sampleSize} purchase` +
      `${input.sampleSize === 1 ? "" : "s"} in this window, below the ${input.minPurchaseFloor}-` +
      `purchase floor needed for a confident read at this window length.`
    );
  }
  if (input.spansSeasonalBoundary) {
    const labels =
      input.seasonalityLabels.length > 0 ? input.seasonalityLabels.join(", ") : "a labelled window";
    return (
      `${label} verdict is suppressed to NOT_DISTINGUISHABLE — this window spans a seasonal ` +
      `boundary (${labels}); a festive-vs-off-season mix confounds the point estimate itself, not ` +
      `only a trend comparison.`
    );
  }
  if (input.windowHasDataGap) {
    const days =
      input.gapDays && input.gapDays.length > 0
        ? input.gapDays.slice(0, 3).join(", ")
        : "unknown days";
    const more =
      input.gapDays && input.gapDays.length > 3 ? ` (+${input.gapDays.length - 3} more)` : "";
    return (
      `${label} verdict is suppressed to NOT_DISTINGUISHABLE — this window overlaps the account's ` +
      `known Shopify data gap (e.g. ${days}${more}). The low figure reflects missing data, not a ` +
      `real revenue collapse; never treat it as a genuine low-performance signal.`
    );
  }
  return (
    `${label} verdict is NOT_DISTINGUISHABLE — the confidence interval ` +
    `${formatInterval(input.intervalLow, input.intervalHigh)} straddles the target of ${input.target} ` +
    `even with ${input.sampleSize} purchases; genuinely inconclusive, not a data-quality issue.`
  );
}
