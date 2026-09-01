// EVALUATE_RECOMMENDATION_OUTCOME — §21.1, the Firestore glue around outcomeEvaluation.ts's pure
// `computeRecommendationOutcome`. Firestore-only, no live Meta/Shopify/Anthropic call, no
// watermark of its own — the same "internal, no syncState target" shape as C3's
// COMPUTE_STATISTICS/C4's ENRICH_CHANGE_FEATURES/D2's MARK_DECISION_PACKETS_STALE.
//
// What this task does, once per run:
//   1. Find every COMPLETE, user-accepted recommendation with real recheckConditions/decisionUnit/
//      packetId, that isn't already evaluated (no recommendationOutcomes/{id} doc yet).
//   2. For each, fetch its decision packet and the metaInsightsDailyNormalized rows that could
//      fall inside its evaluation window, and hand both to outcomeEvaluation.ts.
//   3. Write a recommendationOutcomes/{id} doc ONLY when the pure function says EVALUATED.
//      NOT_YET_ELIGIBLE and SKIPPED both write nothing — the whole point of §21.1 is that an
//      unjudged recommendation stays unjudged (no doc, not a doc with a null classification) until
//      real evidence says otherwise. Idempotent by construction: a recommendation already carrying
//      an outcome doc is filtered out of the candidate set before any work happens on it, so a
//      re-run (or a duplicate Cloud Tasks delivery) never re-evaluates or overwrites one.
//
// Query shape: this account's scale is small (§10.1's own "a few thousand small reads and writes,
// well under a second" reasoning, reused throughout B/C/D) — a single `status == "COMPLETE"`
// equality query (no composite index needed) plus a full `recommendationOutcomes` scan to build
// the already-evaluated set, both read once per run; everything else (acceptedAt/recheckConditions/
// decisionUnit/packetId/recommendation-type filters) happens in memory, matching C1/C2/C3's own
// "full read pass, filter in memory" precedent. The metaInsightsDailyNormalized read per candidate
// is a single-field `reportingDay` range query (no entity equality in the Firestore query at all —
// filtered to the decision unit in memory inside outcomeEvaluation.ts), so no new composite index
// is needed there either.

import { getDb, COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  loadReportingCanon,
  resolveStatisticalThresholds,
  toReportingDay,
  addCalendarDays,
} from "@shared/canon/index.ts";
import {
  decisionPacketSchema,
  metaInsightsDailyNormalizedSchema,
  recommendationOutcomeSchema,
  recommendationSchema,
  type DecisionPacket,
  type MetaInsightsDailyNormalized,
  type Recommendation,
  type RecommendationOutcome,
  type ReportingDay,
} from "@shared/schema/index.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import { seasonalityContextFor } from "@services/analytics/seasonality/index.ts";
import { EVALUATE_RECOMMENDATION_OUTCOME } from "@services/ingest/sync/taskTypes.ts";
import { computeRecommendationOutcome } from "./outcomeEvaluation.ts";

export interface EvaluateRecommendationOutcomesPayload {
  /** Overrides "yesterday, in the reporting timezone" — matches C2/D1's own default. Test-only in
   * practice for the same reason RecomputeFeaturesPayload's own fields are. */
  asOfDay?: ReportingDay;
  /** ISO instant overriding `new Date()` — test-only. */
  now?: string;
}

function parsePayload(raw: unknown): EvaluateRecommendationOutcomesPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as EvaluateRecommendationOutcomesPayload;
}

/** A recommendation is even worth looking at only once it is COMPLETE, user-accepted, and still
 * carries the fields an evaluation needs — a REJECTED (guardrail) recommendation has
 * `recheckConditions`/budget fields cleared to `null` by D4 and is naturally excluded here without
 * this task ever reading `guardrailRejections` at all. (That collection is keyed by the real
 * `recommendationId` as of the concurrent guardrail-log fix — querying it on the
 * `recommendationId` FIELD, never the doc id, would be the safe read either way, but this task has
 * no need to read it in the first place: REJECTED status plus null recheckConditions already say
 * everything this task needs to know.) */
function isCandidate(rec: Recommendation): boolean {
  return (
    rec.status === "COMPLETE" &&
    rec.acceptedAt !== null &&
    rec.recheckConditions !== null &&
    rec.decisionUnit !== null &&
    rec.packetId !== null &&
    rec.recommendation !== null &&
    rec.recommendation !== "INSUFFICIENT_DATA"
  );
}

export const evaluateRecommendationOutcomesHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const canon = await loadReportingCanon();
  const thresholds = resolveStatisticalThresholds(canon);
  const intervalZScoreSource: "settings" | "default" =
    canon.statisticalThresholds !== undefined ? "settings" : "default";
  const db = getDb();

  const now = payload.now ? new Date(payload.now) : new Date();
  const today = toReportingDay(now, canon.reportingTimezone);
  const asOfDay = payload.asOfDay ?? addCalendarDays(today, -1);

  const recommendationsRepo = createRepository<Recommendation>(
    db,
    COLLECTIONS.recommendations,
    recommendationSchema,
  );
  const outcomesRepo = createRepository<RecommendationOutcome>(
    db,
    COLLECTIONS.recommendationOutcomes,
    recommendationOutcomeSchema,
  );
  const packetsRepo = createRepository<DecisionPacket>(
    db,
    COLLECTIONS.decisionPackets,
    decisionPacketSchema,
  );
  const metaRepo = createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  );

  const [completeRecommendations, existingOutcomes] = await Promise.all([
    recommendationsRepo.query((r) => r.where("status", "==", "COMPLETE")),
    outcomesRepo.query((r) => r),
  ]);
  const alreadyEvaluated = new Set(existingOutcomes.map((o) => o.recommendationId));

  const candidates = completeRecommendations.filter(
    (rec) => isCandidate(rec) && !alreadyEvaluated.has(rec.recommendationId),
  );

  let evaluated = 0;
  let notYetEligible = 0;
  let skipped = 0;
  const notes: Record<string, string> = {};

  for (const rec of candidates) {
    if (rec.packetId === null || rec.acceptedAt === null) {
      // isCandidate() already guarantees this — narrows for TypeScript, defensive in practice.
      skipped++;
      continue;
    }

    const packet = await packetsRepo.get(rec.packetId);
    if (packet === null) {
      skipped++;
      notes[rec.recommendationId] = `no decisionPackets/${rec.packetId} document found`;
      continue;
    }

    const acceptedDay = toReportingDay(rec.acceptedAt, canon.reportingTimezone);
    const evalStartDay = addCalendarDays(acceptedDay, 1);
    const metaRowsInRange =
      evalStartDay > asOfDay
        ? []
        : await metaRepo.query((r) =>
            r.where("reportingDay", ">=", evalStartDay).where("reportingDay", "<=", asOfDay),
          );

    const result = await computeRecommendationOutcome({
      recommendation: rec,
      packet,
      metaRowsInRange,
      reportingCurrency: canon.reportingCurrency,
      reportingTimezone: canon.reportingTimezone,
      asOfDay,
      intervalZScore: thresholds.intervalZScore,
      intervalZScoreSource,
      now,
      seasonalityContextFor,
    });

    if (result.kind === "EVALUATED") {
      await outcomesRepo.set(rec.recommendationId, result.outcome);
      evaluated++;
    } else if (result.kind === "NOT_YET_ELIGIBLE") {
      notYetEligible++;
      notes[rec.recommendationId] = result.reason;
    } else {
      skipped++;
      notes[rec.recommendationId] = result.reason;
    }
  }

  return {
    newRowCount: evaluated,
    summary: {
      asOfDay,
      candidatesConsidered: candidates.length,
      evaluated,
      notYetEligible,
      skipped,
      notes,
    },
  };
};

export const evaluateRecommendationOutcomesRegistration: TaskRegistration = {
  taskType: EVALUATE_RECOMMENDATION_OUTCOME,
  runSource: "internal",
  syncStateTarget: null,
  handler: evaluateRecommendationOutcomesHandler,
};
