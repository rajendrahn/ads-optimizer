// D6 — joins `recommendations/{id}` with its `decisionPackets/{packetId}` (and, on a REJECTED
// doc, `guardrailRejections/{id}`) into one `RecommendationView` the browser can render without a
// second round trip and, crucially per §17.1, without a direct Firestore read of its own (see
// server.ts's module comment for the full resolution of that contradiction).
//
// Trusts the shape of `DecisionPacket.evidence` — D1/D2's own pipeline populates it exactly per
// `services/evidence/packetBuilder.ts`'s `evidenceRecordFor` (proven by D1/D2's own emulator
// tests), so this is a structural cast of already-produced-by-us data, not a new external input
// boundary needing its own zod re-validation.

import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  decisionPacketSchema,
  guardrailRejectionLogSchema,
  recommendationSchema,
  type DecisionPacket,
  type GuardrailRejectionLog,
  type Recommendation,
} from "@shared/schema/index.ts";
import type {
  DecisionPacketView,
  GuardrailRejectionView,
  NoDecisionUnitEvidenceView,
  NotDeliveringEvidenceView,
  RecommendationSummaryView,
  RecommendationView,
  ScalingEvidenceView,
} from "./types.ts";

export interface ViewContext {
  db: Firestore;
  /** §5.2 reporting currency — recommendation budget figures are always expressed in it by the
   * time they reach the model (D1/C1's own normalization), so it is attached once here rather
   * than re-derived per figure. */
  reportingCurrency: string;
  reportingTimezone: string;
}

function toIso(value: Date | { toDate(): Date } | string): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return value.toDate().toISOString();
}

function projectPacket(packet: DecisionPacket): DecisionPacketView {
  const base = {
    namedEntity: packet.namedEntity,
    decisionUnit: packet.decisionUnit,
    escalatedFrom: packet.escalatedFrom,
    accountDataVersion: packet.accountDataVersion,
    isStale: packet.isStale,
    createdAt: toIso(packet.createdAt),
    textRendering: packet.textRendering,
  };
  switch (packet.outcome) {
    case "EVIDENCE":
      return {
        ...base,
        outcome: "EVIDENCE",
        evidence: packet.evidence as unknown as ScalingEvidenceView,
      };
    case "NOT_DELIVERING":
      return {
        ...base,
        outcome: "NOT_DELIVERING",
        evidence: packet.evidence as unknown as NotDeliveringEvidenceView,
      };
    case "NO_DECISION_UNIT":
      return {
        ...base,
        outcome: "NO_DECISION_UNIT",
        evidence: packet.evidence as unknown as NoDecisionUnitEvidenceView,
      };
  }
}

/** Merges D4's own small `{reason, rejectedAt}` pair (always present on a REJECTED doc, per
 * generateRecommendationTask.ts) with D5's fuller, structured log (`guardrailRejections/{id}` —
 * violations with their `judgedAgainst` limits, and which decision unit the model claimed vs.
 * what D1 actually resolved). The small pair is the source of truth for *whether* a rejection
 * happened and *when*; the log is optional detail layered on top — a missing log (e.g. an older
 * doc from before D5 landed) still renders a legible, if less detailed, rejected card rather
 * than nothing. */
function projectGuardrailRejection(
  small: Recommendation["guardrailRejection"],
  log: GuardrailRejectionLog | null,
): GuardrailRejectionView | null {
  if (!small) return null;
  return {
    reason: small.reason,
    rejectedAt: toIso(small.rejectedAt),
    violations: log?.violations ?? [],
    decisionUnitClaimedByModel: log?.decisionUnitClaimedByModel ?? null,
    decisionUnitResolved: log?.decisionUnitResolved ?? null,
  };
}

/**
 * Looks up D5's `guardrailRejections/{id}` log for a REJECTED recommendation. **Not a plain
 * `.get(recommendationId)`** — the production guardrail wiring the coordinator confirmed
 * (`generateRecommendationHandler`'s `guardrailValidator: createGuardrailValidator()`, in
 * `services/reasoner/job/generateRecommendationTask.ts`, read but not modified here) goes through
 * `guardrailAdapter.ts`'s narrow seam, which — by that file's own module comment — does not have
 * the real `recommendationId` in scope and instead writes its log under a SYNTHESIZED id,
 * `adapter_{decisionUnit.type}_{decisionUnit.id}_{epochMillis}`. A direct keyed lookup by
 * `recommendationId` would therefore miss every real rejection today.
 *
 * This tries the direct lookup first (the correct, forward-compatible path — `guardrailLog.ts`'s
 * own comment names `applyGuardrails` as the higher-fidelity integration a future change could
 * wire in, which WOULD key the log by the real id, and at that point this first branch alone
 * would already be all that is needed), then falls back to a prefix query over
 * `FieldPath.documentId()` for `adapter_{type}_{id}_` — a single-field, natively-indexed range
 * query, so it needs no new composite index — taking the most recent match. Both branches are a
 * best-effort join for display, not the guardrail's own decision — a miss here never blocks
 * rendering the REJECTED card, it only means the extra per-violation detail is unavailable (see
 * `projectGuardrailRejection`).
 */
async function findGuardrailRejectionLog(
  db: Firestore,
  recommendationId: string,
  claimedDecisionUnit: Recommendation["decisionUnit"],
): Promise<GuardrailRejectionLog | null> {
  const repo = createRepository<GuardrailRejectionLog>(
    db,
    COLLECTIONS.guardrailRejections,
    guardrailRejectionLogSchema,
  );
  const direct = await repo.get(recommendationId);
  if (direct) return direct;
  if (!claimedDecisionUnit) return null;

  // Firestore (both the emulator and the real service) rejects a descending orderBy on the
  // document id ("does not support descending key scans") — order ascending instead and take the
  // LAST match client-side. The id's own suffix is an epoch-millis decimal string, so ascending
  // document-id order is also ascending chronological order for same-length suffixes (true for
  // any two rejections within the same millisecond-precision era, which is all that matters here
  // — picking the most recent of a handful of matches, not a durable sort guarantee for its own
  // sake).
  const prefix = `adapter_${claimedDecisionUnit.type}_${claimedDecisionUnit.id}_`;
  const prefixUpperBound = prefix + String.fromCodePoint(0xf8ff);
  const rows = await repo.query((ref) =>
    ref
      .where(FieldPath.documentId(), ">=", prefix)
      .where(FieldPath.documentId(), "<", prefixUpperBound)
      .orderBy(FieldPath.documentId(), "asc"),
  );
  return rows[rows.length - 1] ?? null;
}

/**
 * Builds the full joined view for one recommendation. Returns `null` when the doc does not
 * exist — the caller turns that into a 404, never a fabricated empty card.
 */
export async function buildRecommendationView(
  ctx: ViewContext,
  recommendationId: string,
): Promise<RecommendationView | null> {
  const recRepo = createRepository<Recommendation>(
    ctx.db,
    COLLECTIONS.recommendations,
    recommendationSchema,
  );
  const rec = await recRepo.get(recommendationId);
  if (!rec) return null;

  const [packet, guardrailLog] = await Promise.all([
    rec.packetId
      ? createRepository<DecisionPacket>(
          ctx.db,
          COLLECTIONS.decisionPackets,
          decisionPacketSchema,
        ).get(rec.packetId)
      : Promise.resolve(null),
    // §20.2: "every rejection logged" — D5's own durable log. Only meaningful to fetch on a
    // REJECTED doc; see `findGuardrailRejectionLog`'s own comment for why this is not a plain
    // keyed `.get(recommendationId)`. A lookup miss is harmless (rendered as no guardrail
    // detail, never an error) so no extra branch is needed here.
    rec.status === "REJECTED"
      ? findGuardrailRejectionLog(ctx.db, recommendationId, rec.decisionUnit)
      : Promise.resolve(null),
  ]);

  return {
    recommendationId: rec.recommendationId,
    status: rec.status,
    requestedBy: rec.requestedBy,
    requestedQuestion: rec.requestedQuestion,
    namedEntity: (rec.namedEntity as RecommendationView["namedEntity"]) ?? null,
    createdAt: toIso(rec.createdAt),
    updatedAt: toIso(rec.updatedAt),
    errorMessage: rec.errorMessage,
    action: rec.recommendation,
    decisionUnit: rec.decisionUnit,
    currentBudgetMinorUnits: rec.currentBudgetMinorUnits,
    recommendedBudgetMinorUnits: rec.recommendedBudgetMinorUnits,
    currency: ctx.reportingCurrency,
    changePercent: rec.changePercent,
    confidence: rec.confidence,
    summary: rec.summary,
    primaryReasons: rec.primaryReasons,
    risks: rec.risks,
    doNotDo: rec.doNotDo,
    recheckConditions: rec.recheckConditions,
    guardrailRejection: projectGuardrailRejection(rec.guardrailRejection, guardrailLog),
    provenance: rec.provenance
      ? {
          model: rec.provenance.model,
          provider: rec.provenance.provider,
          promptVersion: rec.provenance.promptVersion,
          decisionEngineVersion: rec.provenance.decisionEngineVersion,
          featureVersion: rec.provenance.featureVersion,
          dataVersion: rec.provenance.dataVersion,
          generatedAt: rec.provenance.generatedAt,
          dataFreshThrough: rec.provenance.dataFreshThrough,
          adOptimizationKnowledgeVersion: rec.provenance.adOptimizationKnowledgeVersion,
        }
      : null,
    acceptedAt: rec.acceptedAt ? toIso(rec.acceptedAt) : null,
    rejectedByUserAt: rec.rejectedByUserAt ? toIso(rec.rejectedByUserAt) : null,
    reportingTimezone: ctx.reportingTimezone,
    packet: packet ? projectPacket(packet) : null,
  };
}

/** List summaries for the "recent questions" panel — no packet join, deliberately cheap. */
export async function listRecommendationSummaries(
  db: Firestore,
  opts: { limit: number },
): Promise<RecommendationSummaryView[]> {
  const repo = createRepository<Recommendation>(
    db,
    COLLECTIONS.recommendations,
    recommendationSchema,
  );
  const rows = await repo.query((ref) => ref.orderBy("createdAt", "desc").limit(opts.limit));
  return rows.map((rec) => ({
    recommendationId: rec.recommendationId,
    status: rec.status,
    namedEntity: (rec.namedEntity as RecommendationSummaryView["namedEntity"]) ?? null,
    requestedQuestion: rec.requestedQuestion,
    action: rec.recommendation,
    createdAt: toIso(rec.createdAt),
    updatedAt: toIso(rec.updatedAt),
  }));
}
