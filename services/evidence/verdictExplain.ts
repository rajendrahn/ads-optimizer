// Reality #5: "a suppressed verdict's *reason* must be surfaced, not silently inherited." C3
// forces NOT_DISTINGUISHABLE for three distinct reasons (below the purchase floor, a
// seasonal-boundary confound, or — for shopifyRoas only — a Shopify data-gap overlap).
//
// Which of the three applies is decided ONCE, by C3's own `windowStatistics.ts`, at the exact
// point the suppression happens, and stored on the metric as `verdictReasonCode`
// (`shared/schema/features.ts`). This module's job is ONLY to render that stored code into
// prose — it does NOT re-derive the decision from sample sizes/booleans. It used to (see
// IMPLEMENTATION_PLAN.md D1's orchestrator note): a second copy of C3's priority order, kept in
// sync only by convention, one bug fix away from attaching a confidently wrong explanation to a
// correct verdict. That copy is gone; `ExplainVerdictInput` no longer even accepts the raw
// `spansSeasonalBoundary`/`windowHasDataGap` booleans a caller might otherwise be tempted to
// recompute a decision from — only the labels/day-lists needed to render the ALREADY-DECIDED
// reason into a sentence.
//
// `verdictReasonCode` can also be `undefined` — a document written before this field existed
// (an older stored `EntityFeatures` doc; see the schema's own optional-field note, A2's
// version-guard constraint). That is handled honestly below, not guessed at.

import type { Verdict } from "@services/analytics/statistics/index.ts";
import type { VerdictReasonCode } from "@shared/schema/index.ts";

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
  /** C3's own recorded reason a NOT_DISTINGUISHABLE verdict was forced — see the module comment.
   * `null` means NOT_DISTINGUISHABLE for a genuine reason none of C3's three rules cover (the
   * interval itself straddles the target) or the metric isn't NOT_DISTINGUISHABLE at all.
   * `undefined` means an older stored document that predates this field — rendered as an honest
   * "not recorded", never guessed. Ignored entirely when `verdict !== "NOT_DISTINGUISHABLE"`. */
  verdictReasonCode?: VerdictReasonCode | null;
  /** Only used to name the actual seasonal label(s) in the sentence when
   * `verdictReasonCode === "SEASONAL_BOUNDARY"` — never used to decide whether that's the
   * reason. */
  seasonalityLabels: readonly string[];
  /** Only used to name the actual gap day(s) in the sentence when
   * `verdictReasonCode === "DATA_GAP"` — never used to decide whether that's the reason. */
  gapDays?: readonly string[];
  /** How to render `target` and the interval bounds as text. Defaults to a plain 2-decimal
   * number, which is right for a ratio metric like ROAS ("above the target of 3.00").
   *
   * ⚠️ It is NOT right for a money metric. CPA travels in integer minor units (§0.2), so the
   * default would render a ₹1,500 target as "150000" in the same sentence where the value is
   * formatted as "INR 1761.00" — producing "INR 1761.00 is confidently above the target of
   * 150000", which reads as though 1761 were BELOW the target and argues against its own
   * verdict. This packet text is what the model reasons over (§15.2), so a caller passing a
   * money metric MUST pass a matching minor-units formatter. Caught at D2 review by reading a
   * real rendered packet; no unit test would have flagged it, since each half was individually
   * correct. */
  formatValue?: (value: number) => string;
}

function formatInterval(
  low: number | null,
  high: number | null,
  fmt: (value: number) => string,
): string {
  if (low === null || high === null) return "no interval available";
  return `[${fmt(low)}, ${fmt(high)}]`;
}

export function explainVerdict(input: ExplainVerdictInput): string {
  const { label } = input;
  // See `formatValue`'s doc comment — the default is correct for ratio metrics only, and a
  // money metric must supply a minor-units formatter or the sentence contradicts its verdict.
  const fmt = input.formatValue ?? ((value: number) => value.toFixed(2));

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
      `${label} is confidently ${direction} the target of ${fmt(input.target)} — interval ` +
      `${formatInterval(input.intervalLow, input.intervalHigh, fmt)} from ${input.sampleSize} purchases.`
    );
  }

  // NOT_DISTINGUISHABLE — render the reason C3 already decided and stored, per-code. This is a
  // RENDER switch, not a decision: it does not look at sampleSize/minPurchaseFloor/gap booleans
  // to figure out which case applies — `verdictReasonCode` already says so.
  if (input.verdictReasonCode === undefined) {
    // An older stored document, written before C3 recorded this field — see the module comment.
    // Honest about not knowing, never a guessed reason (which is exactly the failure mode the
    // old re-derivation logic risked once C3's thresholds/ordering drifted from this module's).
    return (
      `${label} verdict is NOT_DISTINGUISHABLE — the specific reason was not recorded for this ` +
      `window (it predates per-window suppression-reason tracking). Treat this as "we cannot ` +
      `tell", without a stated cause; a fresh recompute will carry the reason going forward.`
    );
  }
  if (input.verdictReasonCode === "BELOW_FLOOR") {
    return (
      `${label} verdict is NOT_DISTINGUISHABLE — only ${input.sampleSize} purchase` +
      `${input.sampleSize === 1 ? "" : "s"} in this window, below the ${input.minPurchaseFloor}-` +
      `purchase floor needed for a confident read at this window length.`
    );
  }
  if (input.verdictReasonCode === "SEASONAL_BOUNDARY") {
    const labels =
      input.seasonalityLabels.length > 0 ? input.seasonalityLabels.join(", ") : "a labelled window";
    return (
      `${label} verdict is suppressed to NOT_DISTINGUISHABLE — this window spans a seasonal ` +
      `boundary (${labels}); a festive-vs-off-season mix confounds the point estimate itself, not ` +
      `only a trend comparison.`
    );
  }
  if (input.verdictReasonCode === "DATA_GAP") {
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
  // verdictReasonCode === null — a genuine "interval straddles target" read, none of C3's three
  // suppression rules in play.
  return (
    `${label} verdict is NOT_DISTINGUISHABLE — the confidence interval ` +
    `${formatInterval(input.intervalLow, input.intervalHigh, fmt)} straddles the target of ${fmt(input.target)} ` +
    `even with ${input.sampleSize} purchases; genuinely inconclusive, not a data-quality issue.`
  );
}
