// E2 — Outcome evaluation (§21.1, §15.3). Pure logic: given an already-accepted recommendation,
// its decision packet, and the Meta rows that MIGHT be relevant, decide whether enough evidence
// has accumulated to judge it and, if so, produce the RecommendationOutcome to store. No
// Firestore here — see recommendationOutcomeTask.ts for the glue (fetching candidates, querying
// metaInsightsDailyNormalized, writing the result).
//
// §21.1, the one rule this module exists to implement: "evaluate when the recheck conditions are
// met. Never on a fixed number of days." Revision 1 evaluated on `roas3d`, and at this account's
// volume three days is roughly two purchases — noise dressed up as a verdict. This module's own
// "not yet eligible" result is therefore not a gap to fill with a fallback timer; it is the
// correct answer for a recommendation that has not yet accumulated enough evidence to judge. If a
// future author adds a time-based fallback trigger here, that is the exact regression this step
// was written to prevent.
//
// §15.3, the second rule: comparison is against the recommendation's own SHRUNK baseline
// (`decisionPacket.evidence.windows[primaryWindow].metaRoasShrunk`), frozen at generation time —
// never the raw `metaRoas.value`, and never a baseline recomputed fresh from today's settings.
// Reading the value already stored on the packet (rather than recomputing shrinkage from current
// `statisticalThresholds`) is what makes a later correction to those thresholds change FUTURE
// recommendations' baselines without silently rewriting what a past outcome was judged against —
// the same property D5's `guardrailRejections.judgedAgainst` gives guardrail rejections.
//
// Classification reuses C3's own statistical machinery rather than inventing a second one: an
// interval is built on `roasAfter` from `additionalPurchases` using the SAME Anscombe/Poisson
// estimator (interval.ts) C3 uses for every other ROAS figure in this system, and the SAME
// `computeVerdict` (verdict.ts) that turns an interval-vs-target comparison into a three-state
// read — with `baselineShrunk` standing in for the usual fixed target. ABOVE_TARGET / BELOW_TARGET
// / NOT_DISTINGUISHABLE map onto SUCCESS / FAILURE / NEUTRAL one-for-one: NEUTRAL is a real,
// common, correct answer ("the interval still straddles the baseline — not enough evidence to call
// it either way"), not a fallback for a computation that failed.
//
// Seasonality (§21.1's amended requirement, C5): the evaluation window is checked against the
// SAME days the baseline was computed over (reconstructed from the packet's own generation time —
// see `reconstructBaselineWindow` below). When they sit in different seasonal regimes
// (`spansSeasonalBoundary`), `classification` is forced to `SEASONALLY_CONFOUNDED` — the plain
// interval-vs-baseline read is still computed and stored as `rawClassification`, never discarded,
// matching this codebase's own "carry the number, flag it, never suppress it" discipline
// (C2/C3's `shopifyDataGap`/`verdictReasonCode`, extended here to the outcome layer).
//
// Only Meta-attributed figures are used throughout (spend, purchases, purchase value) — never
// `shopifyRoas`/`shopifyRoasShrunk`. This isn't a workaround for the Shopify order-data hole
// (2025-12-14 -> ~2026-07-02, C1/C2) so much as the same reality #4 discipline D1 already applies
// (`evidenceAssembler.ts`: "eligibleToScale's own gates use ONLY Meta-attributed metaRoas/cpa,
// never shopifyRoas"): at ~0.02% Shopify attribution coverage (B7), a per-ad/ad-set
// Shopify-attributed ROAS is not a usable signal at all, gap or no gap. Because this module never
// reads a Shopify-derived figure, it never touches C2's `GapAware<T>` wrapper and therefore never
// needs (and never calls) `unsafeIgnoreGap` — an evaluation window overlapping the order-data hole
// simply has no Shopify-derived number to be tempted to use in the first place.

import {
  recommendationOutcomeSchema,
  windowLabel,
  type DecisionPacket,
  type MetaInsightsDailyNormalized,
  type Recommendation,
  type RecommendationOutcome,
  type ReportingDay,
  type WindowLabel,
} from "@shared/schema/index.ts";
import { addCalendarDays, toReportingDay } from "@shared/canon/index.ts";
import {
  aggregateMetaWindow,
  daysInRange,
  windowEnding,
  type DayRange,
} from "@services/analytics/features/index.ts";
import {
  poissonCountInterval,
  scaleIntervalByCount,
  computeVerdict,
} from "@services/analytics/statistics/index.ts";
import { z } from "zod";

/** The one field this module needs out of `decisionPacket.evidence` (an untyped
 * `Record<string, unknown>` per A2's own "full typing is D1/D2's job" note) — validated narrowly
 * rather than cast, so a malformed or unexpectedly-shaped packet is SKIPPED with a reason instead
 * of silently reading `undefined` as a number. Deliberately does not import D1's `ScalingEvidence`
 * TS type and cast to it: a cast proves nothing at runtime, and this is exactly the kind of
 * cross-step data boundary (D1/D2 write it, E2 reads it back out of Firestore, and neither
 * module's TypeScript types are checked against the other's write path) where a real parse earns
 * its keep. */
const scalingEvidenceShapeSchema = z.object({
  primaryWindow: windowLabel,
  evidence: z.object({
    windows: z.partialRecord(windowLabel, z.object({ metaRoasShrunk: z.number().nullable() })),
  }),
});

export type SeasonalityContextForOutcome = (
  window: DayRange,
  baseline?: DayRange,
) => Promise<{
  labels: string[];
  spansSeasonalBoundary: boolean;
  demandIndex: number | null;
  demandIndexSampleSize: number;
  summaryText: string;
}>;

export interface RecommendationOutcomeComputationInput {
  /** Must be `status: "COMPLETE"`, non-null `acceptedAt`/`recheckConditions`/`decisionUnit`/
   * `packetId`, and `recommendation !== "INSUFFICIENT_DATA"` — the caller (recommendationOutcomeTask.ts)
   * filters to this shape before calling; this function re-validates rather than trusting the
   * caller, so a unit test can exercise every rejection path directly. */
  recommendation: Recommendation;
  /** The decision packet named by `recommendation.packetId`. */
  packet: DecisionPacket;
  /** Every `metaInsightsDailyNormalized` row that MIGHT fall inside the evaluation window — NOT
   * yet filtered to this decision unit or bounded to the exact crossing day (both happen inside
   * this function). The caller is expected to have already bounded the day range to
   * `[acceptedDay + 1, asOfDay]`; this function does not re-check that, only re-derives it for its
   * own day-by-day accumulation. */
  metaRowsInRange: readonly MetaInsightsDailyNormalized[];
  reportingCurrency: string;
  reportingTimezone: string;
  /** The furthest reporting day with complete data — never "today" (matches C2/D1's own "today is
   * necessarily partial" convention). */
  asOfDay: ReportingDay;
  intervalZScore: number;
  intervalZScoreSource: "settings" | "default";
  /** Stamped onto `evaluatedAt`/`createdAt` on the EVALUATED result. */
  now: Date;
  /** Injected exactly like C2's own seasonality seam (`services/analytics/features/seasonality.ts`)
   * — production passes C5's real `seasonalityContextFor`; a test passes a fake without needing
   * the real calendar collection. */
  seasonalityContextFor: SeasonalityContextForOutcome;
}

export type RecommendationOutcomeComputationResult =
  | { kind: "NOT_YET_ELIGIBLE"; reason: string }
  | { kind: "SKIPPED"; reason: string }
  | { kind: "EVALUATED"; outcome: RecommendationOutcome };

function metaRowsForDecisionUnit(
  rows: readonly MetaInsightsDailyNormalized[],
  decisionUnitType: "AD" | "ADSET" | "CAMPAIGN",
  decisionUnitId: string,
): MetaInsightsDailyNormalized[] {
  switch (decisionUnitType) {
    case "AD":
      return rows.filter((r) => r.adId === decisionUnitId);
    case "ADSET":
      return rows.filter((r) => r.adsetId === decisionUnitId);
    case "CAMPAIGN":
      return rows.filter((r) => r.campaignId === decisionUnitId);
  }
}

function groupByReportingDay(
  rows: readonly MetaInsightsDailyNormalized[],
): Map<ReportingDay, MetaInsightsDailyNormalized[]> {
  const byDay = new Map<ReportingDay, MetaInsightsDailyNormalized[]>();
  for (const row of rows) {
    const list = byDay.get(row.reportingDay);
    if (list) list.push(row);
    else byDay.set(row.reportingDay, [row]);
  }
  return byDay;
}

/** The decision unit's own primary window at the time the recommendation was GENERATED — the same
 * days `baselineShrunk` was actually computed over. Packets don't store an explicit day range, so
 * this is reconstructed from `packet.createdAt` using the SAME "asOfDay defaults to yesterday"
 * convention `RECOMPUTE_FEATURES` itself uses (recomputeFeaturesTask.ts) — a documented
 * approximation (the packet may have been generated some hours after the sync run that fed it),
 * not an exact replay of the original query. At day granularity this is off by at most one day at
 * the edge, which does not materially change which seasonal label(s) a multi-day window overlaps. */
function reconstructBaselineWindow(
  packet: DecisionPacket,
  primaryWindow: WindowLabel,
  reportingTimezone: string,
): DayRange {
  const packetGeneratedDay = toReportingDay(packet.createdAt, reportingTimezone);
  const packetAsOfDay = addCalendarDays(packetGeneratedDay, -1);
  return windowEnding(primaryWindow, packetAsOfDay);
}

export async function computeRecommendationOutcome(
  input: RecommendationOutcomeComputationInput,
): Promise<RecommendationOutcomeComputationResult> {
  const rec = input.recommendation;

  if (rec.status !== "COMPLETE") {
    return { kind: "SKIPPED", reason: `recommendation status is ${rec.status}, not COMPLETE` };
  }
  if (rec.acceptedAt === null) {
    return { kind: "SKIPPED", reason: "recommendation was never accepted" };
  }
  if (rec.recheckConditions === null) {
    return {
      kind: "SKIPPED",
      reason:
        "no recheckConditions on this recommendation (e.g. it was guardrail-rejected, whose recheckConditions D4 clears to null)",
    };
  }
  if (
    rec.recheckConditions.minimumAdditionalSpendMinorUnits === null &&
    rec.recheckConditions.minimumAdditionalPurchases === null
  ) {
    // Both thresholds null would otherwise trigger on the very first post-acceptance day
    // regardless of evidence — the opposite of §21.1's whole point. D3's structured output
    // always sets both numerically (§20.1), so this should not occur in practice; treated as a
    // defensive SKIPPED rather than a silent immediate evaluation.
    return {
      kind: "SKIPPED",
      reason:
        "recheckConditions has neither a spend nor a purchase threshold — nothing to trigger evaluation on",
    };
  }
  if (rec.decisionUnit === null) {
    return {
      kind: "SKIPPED",
      reason: "no decisionUnit — nothing to measure post-acceptance delivery for",
    };
  }
  if (rec.recommendation === "INSUFFICIENT_DATA" || rec.recommendation === null) {
    return {
      kind: "SKIPPED",
      reason: `recommendation type is ${String(rec.recommendation)} — nothing to score`,
    };
  }
  const decisionUnit = rec.decisionUnit;
  if (
    decisionUnit.type !== "AD" &&
    decisionUnit.type !== "ADSET" &&
    decisionUnit.type !== "CAMPAIGN"
  ) {
    return {
      kind: "SKIPPED",
      reason: `decisionUnit.type ${decisionUnit.type} never owns a budget — cannot be a recommendation's decision unit`,
    };
  }
  if (rec.packetId === null) {
    return { kind: "SKIPPED", reason: "no packetId on this recommendation" };
  }

  const packet = input.packet;
  if (packet.outcome !== "EVIDENCE") {
    return {
      kind: "SKIPPED",
      reason: `decision packet outcome is ${packet.outcome}, not EVIDENCE — no shrunk baseline exists to compare against (NOT_DELIVERING/NO_DECISION_UNIT recommendations are forced to INSUFFICIENT_DATA and excluded above; this branch is a defensive backstop)`,
    };
  }

  const evidenceParse = scalingEvidenceShapeSchema.safeParse(packet.evidence);
  if (!evidenceParse.success) {
    return {
      kind: "SKIPPED",
      reason:
        "decisionPacket.evidence did not match the expected ScalingEvidence shape (primaryWindow / evidence.windows[label].metaRoasShrunk)",
    };
  }
  const { primaryWindow, evidence } = evidenceParse.data;
  const baselineShrunk = evidence.windows[primaryWindow]?.metaRoasShrunk ?? null;
  if (baselineShrunk === null) {
    return {
      kind: "SKIPPED",
      reason: `no shrunk baseline at windows.${primaryWindow}.metaRoasShrunk on the packet — §15.3 forbids comparing against the raw value instead, so this outcome stays unjudged`,
    };
  }

  const acceptedDay = toReportingDay(rec.acceptedAt, input.reportingTimezone);
  const evalStartDay = addCalendarDays(acceptedDay, 1);
  if (evalStartDay > input.asOfDay) {
    return {
      kind: "NOT_YET_ELIGIBLE",
      reason: `accepted ${acceptedDay} — no complete reporting day of post-acceptance delivery exists yet (asOfDay=${input.asOfDay})`,
    };
  }

  const filteredRows = metaRowsForDecisionUnit(
    input.metaRowsInRange,
    decisionUnit.type,
    decisionUnit.id,
  );
  const byDay = groupByReportingDay(filteredRows);

  const spendThreshold = rec.recheckConditions.minimumAdditionalSpendMinorUnits;
  const purchasesThreshold = rec.recheckConditions.minimumAdditionalPurchases;

  let cumSpendMinorUnits = 0;
  let cumPurchases = 0;
  let cumPurchaseValueMinorUnits = 0;
  let crossingDay: ReportingDay | null = null;

  for (const day of daysInRange({ startDay: evalStartDay, endDay: input.asOfDay })) {
    const dayTotals = aggregateMetaWindow(byDay.get(day) ?? [], input.reportingCurrency);
    cumSpendMinorUnits += dayTotals.spendMinorUnits;
    cumPurchases += dayTotals.purchases;
    cumPurchaseValueMinorUnits += dayTotals.purchaseValueMinorUnits;

    const spendMet = spendThreshold === null || cumSpendMinorUnits >= spendThreshold;
    const purchasesMet = purchasesThreshold === null || cumPurchases >= purchasesThreshold;
    if (spendMet && purchasesMet) {
      crossingDay = day;
      break;
    }
  }

  if (crossingDay === null) {
    return {
      kind: "NOT_YET_ELIGIBLE",
      reason:
        `recheck conditions not yet met as of ${input.asOfDay} — accumulated ` +
        `additionalSpendMinorUnits=${cumSpendMinorUnits} (need ${spendThreshold ?? "n/a"}), ` +
        `additionalPurchases=${cumPurchases} (need ${purchasesThreshold ?? "n/a"})`,
    };
  }
  if (cumSpendMinorUnits === 0) {
    // Only reachable when minimumAdditionalSpendMinorUnits is null and the purchase threshold
    // alone triggered on rows with zero recorded spend — no honest ROAS to compute either way.
    return {
      kind: "SKIPPED",
      reason: "recheck conditions met with zero accumulated spend — no honest ROAS to compute",
    };
  }

  const roasAfter = cumPurchaseValueMinorUnits / cumSpendMinorUnits;
  const evaluationWindow: DayRange = { startDay: evalStartDay, endDay: crossingDay };

  const countInterval = poissonCountInterval(cumPurchases, input.intervalZScore);
  const roasInterval =
    countInterval && cumPurchases > 0
      ? scaleIntervalByCount(roasAfter, cumPurchases, countInterval, "increasingWithCount")
      : null;
  const verdict = computeVerdict(
    roasInterval?.low ?? null,
    roasInterval?.high ?? null,
    baselineShrunk,
  );
  const rawClassification: "SUCCESS" | "NEUTRAL" | "FAILURE" =
    verdict === "ABOVE_TARGET" ? "SUCCESS" : verdict === "BELOW_TARGET" ? "FAILURE" : "NEUTRAL";

  const baselineWindow = reconstructBaselineWindow(packet, primaryWindow, input.reportingTimezone);
  const evalContext = await input.seasonalityContextFor(evaluationWindow, baselineWindow);
  const baselineContext = await input.seasonalityContextFor(baselineWindow);

  const classification = evalContext.spansSeasonalBoundary
    ? "SEASONALLY_CONFOUNDED"
    : rawClassification;

  const outcome: RecommendationOutcome = recommendationOutcomeSchema.parse({
    recommendationId: rec.recommendationId,
    evaluatedAt: input.now,
    triggeredBy: "RECHECK_CONDITIONS_MET",
    additionalSpendMinorUnits: cumSpendMinorUnits,
    additionalPurchases: cumPurchases,
    roasAfter,
    baselineShrunk,
    classification,
    createdAt: input.now,
    evaluationWindow,
    baselineWindow,
    primaryWindow,
    decisionUnit,
    roasAfterInterval: roasInterval
      ? { intervalLow: roasInterval.low, intervalHigh: roasInterval.high }
      : null,
    intervalZScore: input.intervalZScore,
    intervalZScoreSource: input.intervalZScoreSource,
    rawClassification,
    seasonalContext: {
      evaluationWindowLabels: evalContext.labels,
      baselineWindowLabels: baselineContext.labels,
      spansSeasonalBoundary: evalContext.spansSeasonalBoundary,
      demandIndex: evalContext.demandIndex,
      demandIndexSampleSize: evalContext.demandIndexSampleSize,
      summaryText: evalContext.summaryText,
    },
  });

  return { kind: "EVALUATED", outcome };
}
