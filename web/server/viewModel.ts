// D6 — joins `recommendations/{id}` with its `decisionPackets/{packetId}` (and, on a REJECTED
// doc, `guardrailRejections/{id}`) into one `RecommendationView` the browser can render without a
// second round trip and, crucially per §17.1, without a direct Firestore read of its own (see
// server.ts's module comment for the full resolution of that contradiction).
//
// Trusts the shape of `DecisionPacket.evidence` — D1/D2's own pipeline populates it exactly per
// `services/evidence/packetBuilder.ts`'s `evidenceRecordFor` (proven by D1/D2's own emulator
// tests), so this is a structural cast of already-produced-by-us data, not a new external input
// boundary needing its own zod re-validation.

import type { Firestore } from "firebase-admin/firestore";
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
 * Looks up D5's `guardrailRejections/{recommendationId}` log for a REJECTED recommendation — a
 * plain keyed `.get`, nothing more, now that the production path
 * (`generateRecommendationTask.ts`'s `applyGuardrails` call, called directly with the real
 * `recommendationId` — see that file's own corrective note) writes the log under the real id.
 *
 * **This used to need a fallback prefix-query.** Before that fix, production wired the guardrail
 * through a narrower adapter (`guardrailAdapter.ts`, since deleted) that had no `recommendationId`
 * in scope and synthesized one instead (`adapter_{type}_{id}_{epochMillis}`), so a plain keyed
 * lookup missed every real rejection; this function used to try the direct lookup first, then fall
 * back to a `FieldPath.documentId()` prefix-range scan for that synthesized shape. That fallback is
 * removed here, not merely left dormant: this project has never been deployed (every phase's own
 * "Status" notes confirm no cloud resource was ever created/modified), so there is no real
 * production Firestore data written under the old synthesized-id scheme to stay compatible with —
 * only test-emulator rows, which are wiped between runs. A future author who genuinely inherits a
 * database with old `adapter_*`-keyed rows (e.g. this system having actually been deployed before
 * this fix landed) would need to re-add a similar fallback, or a one-time migration, to backfill
 * `recommendationId` onto them — but that is a real, currently-nonexistent scenario, not a
 * hypothetical worth carrying speculative code for today. A miss here is a best-effort join for
 * display, not the guardrail's own decision — it never blocks rendering the REJECTED card, it only
 * means the extra per-violation detail is unavailable (see `projectGuardrailRejection`).
 */
async function findGuardrailRejectionLog(
  db: Firestore,
  recommendationId: string,
): Promise<GuardrailRejectionLog | null> {
  const repo = createRepository<GuardrailRejectionLog>(
    db,
    COLLECTIONS.guardrailRejections,
    guardrailRejectionLogSchema,
  );
  return repo.get(recommendationId);
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
    // §20.2: "every rejection logged" — D5's own durable log, now keyed by the real
    // `recommendationId` (see `findGuardrailRejectionLog`'s own comment for the history). Only
    // meaningful to fetch on a REJECTED doc. A lookup miss is harmless (rendered as no guardrail
    // detail, never an error) so no extra branch is needed here.
    rec.status === "REJECTED"
      ? findGuardrailRejectionLog(ctx.db, recommendationId)
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
