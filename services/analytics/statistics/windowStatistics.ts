// C3's pure computational core — combines interval.ts/verdict.ts/shrinkage.ts over one already-
// computed WindowMetrics (C2's output) plus the account-level mean for the same window, producing
// exactly the fields C3 owns: intervals on purchases/metaRoas/shopifyRoas/cpa, three-state
// verdicts, and shrunk ROAS values. No Firestore here — computeStatisticsTask.ts is the
// enrichment pass that calls this once per entity/window and writes the result back as a
// targeted partial update (see that file's own module comment for why "targeted" is load-bearing
// — a concurrently-running C4 pass touches other fields on the exact same documents).
//
// Two suppression rules are enforced HERE, not left to whoever reads the verdict later, because
// §15's own framing is that a gap-affected or seasonally-confounded window "must not receive a
// confident verdict" — not "should be interpreted cautiously by a downstream reader":
//
//   1. Gap-affected Shopify data (C1/C2's `shopifyDataGap.windowHasDataGap`) never yields a
//      confident `shopifyRoas` verdict — the account's real Shopify hole
//      ([2025-12-14, ~2026-07-02), C1/C2's own notes) makes any window straddling it look exactly
//      like a revenue collapse; `metaRoas`/`cpa` are Meta-sourced and structurally unaffected, so
//      they are NOT gated by this (matching C2's own established discipline).
//   2. A window whose comparison baseline sits in a different seasonal regime
//      (`seasonality.spansSeasonalBoundary`, C5's own field) never yields a confident verdict for
//      ANY metric in that window — a festive-vs-off-season mix is a confound on the point
//      estimate itself, not only on a trend comparison, so this applies to `metaRoas`/`cpa` too,
//      not only the Shopify-sourced figures. C5 currently returns `demandIndex: null` for every
//      real label (n=1 history per label) — nothing here depends on that index being a number;
//      `spansSeasonalBoundary` is a plain boolean C5 always computes.
//
// Neither suppression rule hides the underlying number: `intervalLow`/`intervalHigh` are still
// computed and stored (or left `null` only when the raw value itself is `null`/unmeasured) — only
// the verdict is forced to NOT_DISTINGUISHABLE. §15/C2's shared discipline throughout this
// codebase is "carry the number, flag it, never suppress it", and the gap/seasonality context
// already sits right next to these fields in the same window object for exactly this reason.

import type { VerdictReasonCode, WindowMetrics } from "@shared/schema/index.ts";
import { poissonCountInterval, scaleIntervalByCount } from "./interval.ts";
import { computeVerdict, type Verdict } from "./verdict.ts";
import { shrinkTowardAccountMean } from "./shrinkage.ts";

export interface AccountMeansForWindow {
  metaRoas: number | null;
  shopifyRoas: number | null;
}

export interface WindowStatisticalThresholds {
  minPurchaseFloor: number;
  targetRoas: number;
  targetCpaMinorUnits: number;
  intervalZScore: number;
}

export interface MetricStatPatch {
  intervalLow: number | null;
  intervalHigh: number | null;
  verdict: Verdict | null;
  /** WHY `verdict` is `NOT_DISTINGUISHABLE`, recorded HERE at the point of decision — see the
   * module comment and `shared/schema/features.ts`'s `verdictReasonCode` doc comment. `null` for
   * a confident verdict, an unmeasured value, or a NOT_DISTINGUISHABLE verdict none of the three
   * rules forced (the interval genuinely straddles the target). Never `undefined` — this is a
   * freshly computed in-memory patch, not a possibly-older stored document. */
  verdictReasonCode: VerdictReasonCode | null;
}

export interface WindowStatisticsPatch {
  purchasesInterval: { intervalLow: number | null; intervalHigh: number | null };
  metaRoas: MetricStatPatch;
  metaRoasShrunk: number | null;
  shopifyRoas: MetricStatPatch;
  shopifyRoasShrunk: number | null;
  cpa: MetricStatPatch;
}

function nullMetricPatch(): MetricStatPatch {
  return { intervalLow: null, intervalHigh: null, verdict: null, verdictReasonCode: null };
}

/**
 * Which suppression rule applies, in the fixed priority order the module comment documents
 * (floor, then season, then — shopifyRoas only, via `windowHasDataGap` always being `false` for
 * metaRoas/cpa callers — the Shopify gap). This is the ONE place that priority order is encoded;
 * `verdictExplain.ts` used to replicate it independently from the same three booleans (the
 * fragility IMPLEMENTATION_PLAN.md D1's orchestrator note flagged) — it now only renders the code
 * this function returns.
 */
function reasonCodeFor(
  belowFloor: boolean,
  spansSeasonalBoundary: boolean,
  windowHasDataGap: boolean,
): VerdictReasonCode | null {
  if (belowFloor) return "BELOW_FLOOR";
  if (spansSeasonalBoundary) return "SEASONAL_BOUNDARY";
  if (windowHasDataGap) return "DATA_GAP";
  return null;
}

/**
 * One metric's interval + verdict + (when suppressed) the reason recorded at the point of
 * decision. `value === null` (C2's "not measured", e.g. an audit-unresolvable ad, or zero Meta
 * spend) always stays fully `null` — never coerced into a NOT_DISTINGUISHABLE verdict, which
 * would misrepresent "we didn't measure this" as "we measured it and couldn't tell". `n === 0` is
 * different: a real, exact zero-purchase observation, which IS a confident (if uninformative)
 * verdict — NOT_DISTINGUISHABLE, not null — but has no honest ratio-based interval to report, so
 * its bounds stay null while the verdict does not; its reason code still follows the same
 * priority order (typically `BELOW_FLOOR`, since `n === 0` is below any positive floor).
 */
function evaluateMetric(
  value: number | null,
  n: number,
  target: number,
  direction: "increasingWithCount" | "decreasingWithCount",
  z: number,
  belowFloor: boolean,
  spansSeasonalBoundary: boolean,
  windowHasDataGap: boolean,
): MetricStatPatch {
  if (value === null) return nullMetricPatch();
  if (n === 0) {
    return {
      intervalLow: null,
      intervalHigh: null,
      verdict: "NOT_DISTINGUISHABLE",
      verdictReasonCode: reasonCodeFor(belowFloor, spansSeasonalBoundary, windowHasDataGap),
    };
  }
  const countInterval = poissonCountInterval(n, z);
  if (countInterval === null) return nullMetricPatch(); // defensive; unreachable for finite n > 0, z > 0
  const scaled = scaleIntervalByCount(value, n, countInterval, direction);
  const suppress = belowFloor || spansSeasonalBoundary || windowHasDataGap;
  const verdict = suppress
    ? "NOT_DISTINGUISHABLE"
    : computeVerdict(scaled.low, scaled.high, target);
  // Only a SUPPRESSED NOT_DISTINGUISHABLE carries a reason code — a NOT_DISTINGUISHABLE verdict
  // `computeVerdict` reached on its own (the interval genuinely straddles the target, none of the
  // three rules in play) is a real, different answer and gets `null`, rendered by
  // `verdictExplain.ts` as "genuinely inconclusive", never a fabricated cause.
  const verdictReasonCode =
    verdict === "NOT_DISTINGUISHABLE"
      ? reasonCodeFor(belowFloor, spansSeasonalBoundary, windowHasDataGap)
      : null;
  return { intervalLow: scaled.low, intervalHigh: scaled.high, verdict, verdictReasonCode };
}

export function computeWindowStatistics(
  window: WindowMetrics,
  accountMeans: AccountMeansForWindow,
  thresholds: WindowStatisticalThresholds,
): WindowStatisticsPatch {
  const metaN = window.metaRoas?.sampleSize ?? window.purchases?.sampleSize ?? 0;
  const spansSeasonalBoundary = window.seasonality?.spansSeasonalBoundary ?? false;
  const metaBelowFloor = metaN < thresholds.minPurchaseFloor;

  const metaCountInterval =
    metaN > 0 ? poissonCountInterval(metaN, thresholds.intervalZScore) : null;
  const purchasesInterval =
    metaCountInterval === null
      ? { intervalLow: null, intervalHigh: null }
      : { intervalLow: metaCountInterval.low, intervalHigh: metaCountInterval.high };

  const metaRoas = evaluateMetric(
    window.metaRoas?.value ?? null,
    metaN,
    thresholds.targetRoas,
    "increasingWithCount",
    thresholds.intervalZScore,
    metaBelowFloor,
    spansSeasonalBoundary,
    false, // the Shopify gap never gates a Meta-sourced metric — see module comment, rule 1
  );
  const metaRoasShrunk = shrinkTowardAccountMean(
    window.metaRoas?.value ?? null,
    metaN,
    accountMeans.metaRoas,
    thresholds.minPurchaseFloor,
  );

  const cpa = evaluateMetric(
    window.cpa?.value ?? null,
    metaN,
    thresholds.targetCpaMinorUnits,
    "decreasingWithCount",
    thresholds.intervalZScore,
    metaBelowFloor,
    spansSeasonalBoundary,
    false, // Meta-sourced, same as metaRoas
  );

  // shopifyRoas uses ITS OWN sample size (this entity's Shopify-attributed order count for this
  // window) — never metaN. A gap-affected window's low observed count may itself be an artefact
  // of missing data rather than genuinely low volume; that is a real, documented nuance (see this
  // step's report), not something this function can distinguish from the sampleSize alone — the
  // gap suppression below is what keeps that ambiguity from ever producing a confident verdict.
  const shopifyN = window.shopifyRoas?.sampleSize ?? 0;
  const shopifyBelowFloor = shopifyN < thresholds.minPurchaseFloor;
  const windowHasDataGap = window.shopifyDataGap?.windowHasDataGap ?? false;

  const shopifyRoas = evaluateMetric(
    window.shopifyRoas?.value ?? null,
    shopifyN,
    thresholds.targetRoas,
    "increasingWithCount",
    thresholds.intervalZScore,
    shopifyBelowFloor,
    spansSeasonalBoundary,
    windowHasDataGap,
  );
  const shopifyRoasShrunk = shrinkTowardAccountMean(
    window.shopifyRoas?.value ?? null,
    shopifyN,
    accountMeans.shopifyRoas,
    thresholds.minPurchaseFloor,
  );

  return { purchasesInterval, metaRoas, metaRoasShrunk, shopifyRoas, shopifyRoasShrunk, cpa };
}
