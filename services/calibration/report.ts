// E3 — combine everything into one report. Pure: takes already-fetched documents (collect.ts's
// job) and a canon fragment, returns a plain data structure (dashboardHtml.ts renders it,
// scripts/generateCalibrationReport.ts writes it to disk). No Firestore, no live call, nothing
// asynchronous — this is what lets every interesting decision in this step (which confidence to
// score, how confounded/unjudged outcomes are excluded, the minimum-n refusal) be proven with a
// plain unit test over synthetic fixtures, independent of an emulator.
//
// ⚠️ Read this before changing what counts as a "success" here — it is the single most
// consequential judgment call in this file.
//
// WHICH CONFIDENCE. Every live point is built from `recommendations/{id}.confidence` as actually
// PERSISTED — which, since the post-D6 corrective fix (see IMPLEMENTATION_PLAN.md D4/D5's own
// "Corrective update" notes), is D5's `adjustedConfidence` for a COMPLETE recommendation: the
// model's own stated confidence multiplicatively reduced for a very recent major edit (×0.6) or a
// composite creative (×0.75), never the model's raw self-report. This is deliberate, not an
// oversight: the adjusted number is the one an operator (or D6's UI) actually saw and acted on —
// calibrating the model's raw self-report would score a number nobody was ever shown, and would
// silently credit or blame D5's own guardrail heuristic for however the raw number would have
// scored on its own. **There is currently no way to recover the model's pre-adjustment confidence
// from stored data** — `recommendationSchema` has no separate field for it (D4/D5's own schema
// only ever had room for one `confidence` value, and the fix that started persisting the adjusted
// number necessarily means the raw one is gone by the time this report reads the document). A
// future step wanting a raw-vs-adjusted comparison would need to add a field and start persisting
// both from that point forward — this step does not do that: it is out of E3's own scope (E3
// calibrates outcomes, it does not touch the job pipeline's write shape), and there is no
// historical data to backfill it against regardless (see the module-level honesty note below).
//
// WHICH OUTCOMES. A live judged point requires `recommendationOutcomes/{id}.classification` to be
// `"SUCCESS"` or `"FAILURE"` — never `"SEASONALLY_CONFOUNDED"` (E2's own flag: the evaluation
// window and its baseline sit in different seasonal regimes, so scoring it would calibrate the
// calendar, exactly what §21.1's amended requirement and this step's own brief both warn against)
// and never `"NEUTRAL"` (E2's own `NOT_DISTINGUISHABLE`-mapped verdict: the evidence was
// insufficient to tell success from failure apart, which is a statement about statistical power,
// not a coin flip that happened to land on "no" — folding it in as a failure would penalize the
// system for being appropriately cautious about a small sample, exactly what this step's brief
// warns against for a DIFFERENT case (unjudged recommendations) but the same underlying principle
// applies here too). Both are counted and reported separately, never silently dropped.
//
// WHICH RECOMMENDATIONS ARE MISSING, NOT FAILING. A recommendation that was accepted and still has
// `recheckConditions` set but has no `recommendationOutcomes/{id}` document at all is UNJUDGED —
// E2 deliberately writes no document when recheck conditions are unmet or a shrunk baseline is
// unavailable (`NOT_YET_ELIGIBLE`/`SKIPPED`, both no-write outcomes — see
// services/evidence/outcomeEvaluation.ts's own module comment). This report counts that group
// explicitly and NEVER includes it in the success/failure tally — an absent outcome document is
// not a failure, it is "still waiting for enough evidence", the exact distinction §21.1 exists to
// preserve.
//
// BACKTEST'S OWN, SLIGHTLY DIFFERENT, DEFINITION OF SUCCESS. `backtestRuns` rows already carry a
// frozen `brierScoreComponent` (E1's own computation, `services/backtest/outcome.ts`). E1's
// `scaledSuccessfully` — the boolean that component is scored against — treats a
// `NOT_DISTINGUISHABLE` verdict as `false` (not excluded, unlike this file's own live-point
// handling of `NEUTRAL` above): see `outcome.ts`'s `scaledSuccessfully: verdict === null ? null :
// verdict === "ABOVE_TARGET"`. That is E1's own committed, reviewed definition, already frozen
// into every stored `brierScoreComponent` — this file reads it as-is rather than recomputing it
// under E3's own NEUTRAL-excluding rule, because rewriting a number `judgedAgainst`-style data
// says was frozen at generation time is exactly the anti-pattern this codebase has repeatedly
// rejected elsewhere (D5's `judgedAgainst`, E2's `baselineShrunk`). Consequence, stated plainly
// rather than silently blended away: pooling live and backtest points into one "combined" Brier
// score technically pools two streams that treat statistical ambiguity slightly differently. Both
// use the identical (confidence - actual)^2 formula on the same [0,1] scale, so pooling is
// numerically sound; it is the upstream definition of `actual` that differs at the margin. Flagged
// in `dataProvenance.notes` on every report this file produces, not just in this comment.

import { aggregateBrierForPoints } from "./brier.ts";
import type { BrierResult } from "./types.ts";
import {
  computeCalibrationCurveForPoints,
  DEFAULT_CALIBRATION_BUCKET_WIDTH,
  MIN_CALIBRATION_BUCKET_SIZE,
  type CalibrationBucket,
} from "./calibrationCurve.ts";
import {
  computeOverallRejectionRate,
  computeRejectionRateOverTime,
  summarizeGuardrailViolations,
  type GuardrailViolationSummary,
  type OverallRejectionRate,
  type RejectionRatePeriod,
} from "./rejectionRate.ts";
import type { CalibrationPoint } from "./types.ts";
import type { CalibrationRawInputs } from "./collect.ts";

export interface CalibrationReportCanon {
  reportingTimezone: string;
}

export interface LiveOutcomesSummary {
  totalOutcomeDocs: number;
  successCount: number;
  failureCount: number;
  neutralCount: number;
  seasonallyConfoundedCount: number;
  /** A judged (SUCCESS/FAILURE) outcome doc whose recommendation could not be found, or whose
   * `confidence` was `null` — should not occur in practice (every COMPLETE recommendation is
   * given a numeric `adjustedConfidence` before it can be accepted), but reported explicitly
   * rather than silently dropped if it ever does. */
  excludedMissingConfidence: number;
  brier: BrierResult;
}

export interface BacktestSummary {
  totalRuns: number;
  systemRuns: number;
  naiveRuns: number;
  /** SYSTEM strategy rows scored by E1's own frozen `brierScoreComponent` (see module comment for
   * why this is read as-is, not recomputed). */
  systemBrier: BrierResult;
  /** Fraction of SYSTEM rows with a non-null `actualOutcome.scaledSuccessfully` that were `true` —
   * reported alongside NAIVE's own rate as the §29 criterion 10 baseline comparison, per E1's own
   * notes ("treat NAIVE's `scaledSuccessfully` rate as the comparison baseline instead"). */
  systemScaledSuccessRate: { n: number; rate: number | null };
  naiveScaledSuccessRate: { n: number; rate: number | null };
}

export interface UnjudgedSummary {
  /** COMPLETE, accepted, with `recheckConditions` set, but no `recommendationOutcomes/{id}` doc —
   * E2's `NOT_YET_ELIGIBLE`/`SKIPPED`, both no-write outcomes. Not a failure — see module comment. */
  acceptedNoOutcomeYet: number;
  /** COMPLETE but never accepted by a user — outside the calibration question entirely (nothing
   * was ever acted on), reported for completeness, not folded into any rate above. */
  completeNotAccepted: number;
  /** Guardrail-REJECTED — excluded from outcome evaluation by construction (recheckConditions is
   * cleared to null), reported here as a cross-reference to the rejection-rate section. */
  guardrailRejected: number;
}

export interface CalibrationCurveSection {
  bucketWidth: number;
  minBucketSize: number;
  buckets: CalibrationBucket[];
  pointCountBySource: { live: number; backtestSystem: number };
}

export interface GuardrailRejectionRateSection {
  granularity: "month";
  overall: OverallRejectionRate;
  overTime: RejectionRatePeriod[];
  violations: GuardrailViolationSummary;
}

export interface CalibrationReport {
  generatedAt: string;
  live: LiveOutcomesSummary;
  backtest: BacktestSummary;
  combinedBrier: BrierResult;
  calibrationCurve: CalibrationCurveSection;
  guardrailRejectionRate: GuardrailRejectionRateSection;
  unjudged: UnjudgedSummary;
  dataProvenance: {
    /** True only once at least one real judged point (live or backtest) exists. As of this
     * step's own implementation, this is `false` against both production (nothing has ever run)
     * and a freshly seeded emulator with no synthetic data loaded — the honest state of the
     * world today. */
    hasAnyJudgedData: boolean;
    notes: string[];
  };
}

const isCandidate = (rec: {
  status: string;
  acceptedAt: unknown;
  recheckConditions: unknown;
  decisionUnit: unknown;
  packetId: unknown;
  recommendation: unknown;
}): boolean =>
  // Mirrors services/evidence/recommendationOutcomeTask.ts's own `isCandidate` predicate exactly
  // (E2, Done) — duplicated rather than importing a non-exported function from another step's
  // file, per this codebase's own convention of not reaching into another step's internals.
  rec.status === "COMPLETE" &&
  rec.acceptedAt !== null &&
  rec.recheckConditions !== null &&
  rec.decisionUnit !== null &&
  rec.packetId !== null &&
  rec.recommendation !== null &&
  rec.recommendation !== "INSUFFICIENT_DATA";

export function buildCalibrationReport(
  inputs: CalibrationRawInputs,
  canon: CalibrationReportCanon,
  now: Date = new Date(),
): CalibrationReport {
  const recommendationById = new Map(inputs.recommendations.map((r) => [r.recommendationId, r]));

  // ---- Live outcomes (E2) ----
  let successCount = 0;
  let failureCount = 0;
  let neutralCount = 0;
  let confoundedCount = 0;
  let excludedMissingConfidence = 0;
  const livePoints: CalibrationPoint[] = [];

  for (const outcome of inputs.outcomes) {
    switch (outcome.classification) {
      case "SUCCESS":
        successCount += 1;
        break;
      case "FAILURE":
        failureCount += 1;
        break;
      case "NEUTRAL":
        neutralCount += 1;
        continue; // never scored — see module comment
      case "SEASONALLY_CONFOUNDED":
        confoundedCount += 1;
        continue; // never scored — see module comment
      case null:
      default:
        continue; // not classified at all — should not occur for a written outcome doc
    }
    const rec = recommendationById.get(outcome.recommendationId);
    if (!rec || rec.confidence === null) {
      excludedMissingConfidence += 1;
      continue;
    }
    livePoints.push({
      id: outcome.recommendationId,
      confidence: rec.confidence,
      success: outcome.classification === "SUCCESS",
      source: "LIVE",
    });
  }

  const live: LiveOutcomesSummary = {
    totalOutcomeDocs: inputs.outcomes.length,
    successCount,
    failureCount,
    neutralCount,
    seasonallyConfoundedCount: confoundedCount,
    excludedMissingConfidence,
    brier: aggregateBrierForPoints(livePoints),
  };

  // ---- Backtest (E1) ----
  const systemRows = inputs.backtestRuns.filter((r) => r.strategy === "SYSTEM");
  const naiveRows = inputs.backtestRuns.filter((r) => r.strategy === "NAIVE_HIGHEST_RECENT_ROAS");

  const backtestPoints: CalibrationPoint[] = [];
  for (const row of systemRows) {
    if (row.brierScoreComponent === null) continue;
    // brierScoreComponent is only non-null when generatedRecommendation.confidence is also
    // non-null and the outcome was measurable (E1's own precondition, outcome.ts's
    // computeBrierScoreComponent) — recover the confidence/success pair that produced it rather
    // than re-deriving success from brierScoreComponent alone (which cannot be inverted: the same
    // squared-error value can come from either a correct high-confidence call or an incorrect
    // low-confidence one).
    const rec = row.generatedRecommendation as { confidence: number | null } | null;
    const outcome = row.actualOutcome as { scaledSuccessfully: boolean | null } | null;
    if (!rec || rec.confidence === null || !outcome || outcome.scaledSuccessfully === null)
      continue;
    backtestPoints.push({
      id: row.backtestRunId,
      confidence: rec.confidence,
      success: outcome.scaledSuccessfully,
      source: "BACKTEST_SYSTEM",
    });
  }

  const systemScaled = systemRows
    .map(
      (r) => (r.actualOutcome as { scaledSuccessfully: boolean | null } | null)?.scaledSuccessfully,
    )
    .filter((v): v is boolean => v === true || v === false);
  const naiveScaled = naiveRows
    .map(
      (r) => (r.actualOutcome as { scaledSuccessfully: boolean | null } | null)?.scaledSuccessfully,
    )
    .filter((v): v is boolean => v === true || v === false);

  // `backtest.systemBrier` reads E1's own FROZEN brierScoreComponent values directly, never
  // recomputing (confidence - actual)^2 from the recovered pair — the same "read the frozen
  // number, don't re-derive it" discipline this codebase applies everywhere else (D5's
  // `judgedAgainst`, E2's `baselineShrunk`). `backtestPoints` above still needs the {confidence,
  // success} PAIR (not just the scalar) to plot a calibration-curve point and to pool into
  // `combinedBrier` alongside live points — for real E1 output the two always agree (identical
  // formula, identical inputs), so this is a belt-and-braces distinction, not two competing
  // sources of truth.
  const frozenSystemBrierValues = systemRows
    .map((r) => r.brierScoreComponent)
    .filter((v): v is number => v !== null);
  const systemBrier: BrierResult =
    frozenSystemBrierValues.length === 0
      ? { n: 0, meanBrier: null }
      : {
          n: frozenSystemBrierValues.length,
          meanBrier:
            frozenSystemBrierValues.reduce((a, b) => a + b, 0) / frozenSystemBrierValues.length,
        };

  const backtest: BacktestSummary = {
    totalRuns: inputs.backtestRuns.length,
    systemRuns: systemRows.length,
    naiveRuns: naiveRows.length,
    systemBrier,
    systemScaledSuccessRate: {
      n: systemScaled.length,
      rate:
        systemScaled.length === 0
          ? null
          : systemScaled.filter(Boolean).length / systemScaled.length,
    },
    naiveScaledSuccessRate: {
      n: naiveScaled.length,
      rate:
        naiveScaled.length === 0 ? null : naiveScaled.filter(Boolean).length / naiveScaled.length,
    },
  };

  // ---- Combined Brier (live + backtest SYSTEM, pooled — see module comment) ----
  const allPoints = [...livePoints, ...backtestPoints];
  const combinedBrier = aggregateBrierForPoints(allPoints);

  // ---- Calibration curve ----
  const curveBuckets = computeCalibrationCurveForPoints(allPoints);
  const calibrationCurve: CalibrationCurveSection = {
    bucketWidth: DEFAULT_CALIBRATION_BUCKET_WIDTH,
    minBucketSize: MIN_CALIBRATION_BUCKET_SIZE,
    buckets: curveBuckets,
    pointCountBySource: { live: livePoints.length, backtestSystem: backtestPoints.length },
  };

  // ---- Guardrail rejection rate (§29 criterion 12) ----
  const attempts = inputs.recommendations.filter(
    (r): r is typeof r & { status: "COMPLETE" | "REJECTED" } =>
      r.status === "COMPLETE" || r.status === "REJECTED",
  );
  const guardrailRejectionRate: GuardrailRejectionRateSection = {
    granularity: "month",
    overall: computeOverallRejectionRate(attempts),
    overTime: computeRejectionRateOverTime(attempts, canon.reportingTimezone, "month"),
    violations: summarizeGuardrailViolations(inputs.guardrailRejections),
  };

  // ---- Unjudged / not-accepted / guardrail-rejected, all excluded from the tallies above ----
  const outcomeIds = new Set(inputs.outcomes.map((o) => o.recommendationId));
  const acceptedNoOutcomeYet = inputs.recommendations.filter(
    (r) => isCandidate(r) && !outcomeIds.has(r.recommendationId),
  ).length;
  const completeNotAccepted = inputs.recommendations.filter(
    (r) => r.status === "COMPLETE" && r.acceptedAt === null,
  ).length;
  const guardrailRejectedCount = inputs.recommendations.filter(
    (r) => r.status === "REJECTED",
  ).length;

  const notes: string[] = [
    "Live points are scored on recommendations.confidence as PERSISTED — D5's adjustedConfidence " +
      "for a COMPLETE recommendation, never the model's raw self-report (which is not separately " +
      "stored). See this file's own module comment.",
    "NEUTRAL and SEASONALLY_CONFOUNDED live outcomes are excluded from every success/failure tally " +
      "and from the calibration curve/Brier score; their counts are reported in `live` above.",
    "Backtest SYSTEM rows use E1's own frozen brierScoreComponent/scaledSuccessfully, which treats " +
      "a NOT_DISTINGUISHABLE verdict as an unsuccessful outcome (unlike this report's own NEUTRAL " +
      "handling for live outcomes, which excludes it) — `combinedBrier` pools both streams on the " +
      "same (confidence-actual)^2 scale, but the two do not define 'actual' identically at the " +
      "margin. See this file's own module comment for the full reasoning.",
    "`unjudged.acceptedNoOutcomeYet` recommendations are NOT counted as failures anywhere in this " +
      "report — an absent outcome document means E2 has not yet seen enough evidence to judge, not " +
      "that the recommendation failed.",
  ];

  return {
    generatedAt: now.toISOString(),
    live,
    backtest,
    combinedBrier,
    calibrationCurve,
    guardrailRejectionRate,
    unjudged: {
      acceptedNoOutcomeYet,
      completeNotAccepted,
      guardrailRejected: guardrailRejectedCount,
    },
    dataProvenance: {
      hasAnyJudgedData: allPoints.length > 0,
      notes,
    },
  };
}
