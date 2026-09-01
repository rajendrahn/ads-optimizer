// D5 — Firestore glue for the guardrail validator. Kept separate from guardrails.ts's own pure
// decision logic (matching D1/D2/D3's own pure-module-vs-Firestore-glue-module split) — nothing
// in this file makes a guardrail DECISION, it only persists one `validateGuardrails` already made
// and shapes it into the fields D4 writes onto `recommendations/{id}`.
//
// `applyGuardrails` is the one function D4's job pipeline should call: it runs `validateGuardrails`
// (guardrails.ts), and on REJECTED, both logs the rejection (`guardrailRejections/{recommendationId}`
// — §20.2's own calibration-signal log) and returns the exact field patch D4 should write onto the
// recommendation document to downgrade it to INSUFFICIENT_DATA — this is the "clearly-named seam"
// D4 plugs into; see this module's own `GuardrailApplication` return type for its shape.

import type { Firestore } from "firebase-admin/firestore";
import { getDb, COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  guardrailRejectionLogSchema,
  type EntityRef,
  type GuardrailRejectionLog,
  type GuardrailViolation,
  type RecommendationType,
} from "@shared/schema/index.ts";
import type { ScalingEvidenceResult } from "@services/evidence/index.ts";
import type { RecommendationOutput } from "./types.ts";
import { validateGuardrails, type GuardrailDecision } from "./guardrails.ts";
import type { CanonSettings } from "@shared/canon/index.ts";

export interface LogGuardrailRejectionInput {
  db?: Firestore;
  recommendationId: string;
  namedEntity: EntityRef | null;
  decisionUnitClaimedByModel: EntityRef | null;
  decisionUnitResolved: EntityRef | null;
  recommendationType: RecommendationType | null;
  changePercent: number | null;
  decision: Extract<GuardrailDecision, { outcome: "REJECTED" }>;
  accountDataVersion: number | null;
  /** Recorded for audit only — see guardrails.ts's own module comment. Never read by
   * `validateGuardrails`; this is the ONE place it is allowed to appear at all, and only after the
   * rejection decision is already final. */
  adOptimizationKnowledgeVersion: string | null;
  now?: Date;
}

/** Writes one durable, structured entry to `guardrailRejections/{recommendationId}` — §20.2's own
 * "a rejected recommendation is logged with its rejection reason ... itself a calibration
 * signal." One document per recommendation attempt (D4 mints a fresh `recommendationId` per
 * attempt, so this is naturally append-only across retries, never overwritten in place). */
export async function logGuardrailRejection(
  input: LogGuardrailRejectionInput,
): Promise<GuardrailRejectionLog> {
  const db = input.db ?? getDb();
  const repo = createRepository<GuardrailRejectionLog>(
    db,
    COLLECTIONS.guardrailRejections,
    guardrailRejectionLogSchema,
  );
  const entry: GuardrailRejectionLog = {
    recommendationId: input.recommendationId,
    namedEntity: input.namedEntity,
    decisionUnitClaimedByModel: input.decisionUnitClaimedByModel,
    decisionUnitResolved: input.decisionUnitResolved,
    recommendationType: input.recommendationType,
    changePercent: input.changePercent,
    violations: input.decision.violations,
    reason: input.decision.reason,
    accountDataVersion: input.accountDataVersion,
    adOptimizationKnowledgeVersion: input.adOptimizationKnowledgeVersion,
    rejectedAt: input.now ?? new Date(),
  };
  await repo.set(input.recommendationId, entry);
  return entry;
}

/** The exact field patch to write onto `recommendations/{id}` when a recommendation is
 * guardrail-rejected — §20.2's "downgraded to INSUFFICIENT_DATA." Field names match
 * `@shared/schema/decisions.ts`'s `recommendationSchema` 1:1 (the same reason D3 matched
 * `RecommendationOutput`'s field names to it — D4 can spread this directly into its write). Every
 * actionable field is nulled out; only `recommendation`, `summary`/`primaryReasons` (explaining
 * WHY, for the UI) and `guardrailRejection` are populated. */
export interface GuardrailRejectionRecommendationPatch {
  recommendation: "INSUFFICIENT_DATA";
  currentBudgetMinorUnits: null;
  recommendedBudgetMinorUnits: null;
  changePercent: null;
  confidence: null;
  summary: string;
  primaryReasons: string[];
  risks: string[];
  doNotDo: string[];
  recheckConditions: null;
  guardrailRejection: { reason: string; rejectedAt: Date };
}

function buildRejectionPatch(
  decision: Extract<GuardrailDecision, { outcome: "REJECTED" }>,
  now: Date,
): GuardrailRejectionRecommendationPatch {
  return {
    recommendation: "INSUFFICIENT_DATA",
    currentBudgetMinorUnits: null,
    recommendedBudgetMinorUnits: null,
    changePercent: null,
    confidence: null,
    summary:
      "Downgraded to INSUFFICIENT_DATA by server-side guardrail validation (§20.2) — the model's " +
      `proposed recommendation was rejected: ${decision.reason}`,
    primaryReasons: decision.violations.map((v) => v.message),
    risks: [],
    doNotDo: [],
    recheckConditions: null,
    guardrailRejection: { reason: decision.reason, rejectedAt: now },
  };
}

export type GuardrailApplication =
  | {
      outcome: "APPROVED";
      /** The confidence to persist in place of `recommendation.confidence` — see
       * guardrails.ts's `GuardrailApproval.adjustedConfidence`. */
      adjustedConfidence: number;
      confidenceAdjustments: string[];
    }
  | {
      outcome: "REJECTED";
      violations: GuardrailViolation[];
      reason: string;
      /** The field patch to write onto `recommendations/{id}` — see
       * `GuardrailRejectionRecommendationPatch`'s own doc comment. */
      recommendationPatch: GuardrailRejectionRecommendationPatch;
    };

export interface ApplyGuardrailsInput {
  db?: Firestore;
  recommendationId: string;
  namedEntity: EntityRef | null;
  recommendation: RecommendationOutput;
  evidenceResult: ScalingEvidenceResult;
  canon: CanonSettings;
  accountDataVersion: number | null;
  adOptimizationKnowledgeVersion: string | null;
  now?: Date;
}

/**
 * The seam D4's job pipeline plugs into: validate (guardrails.ts, pure), and on REJECTED, both
 * log the rejection and hand back the exact field patch to persist. Call this AFTER
 * `generateRecommendation` (D3) has returned and BEFORE writing `recommendations/{id}`'s final
 * (non-PENDING) state.
 */
export async function applyGuardrails(input: ApplyGuardrailsInput): Promise<GuardrailApplication> {
  const now = input.now ?? new Date();
  const decisionUnitResolved =
    input.evidenceResult.outcome === "EVIDENCE"
      ? input.evidenceResult.evidence.decisionUnit
      : input.evidenceResult.outcome === "NOT_DELIVERING"
        ? input.evidenceResult.decisionUnit
        : null;

  const decision = validateGuardrails({
    recommendation: input.recommendation,
    evidenceResult: input.evidenceResult,
    canon: input.canon,
  });

  if (decision.outcome === "APPROVED") {
    return {
      outcome: "APPROVED",
      adjustedConfidence: decision.adjustedConfidence,
      confidenceAdjustments: decision.confidenceAdjustments,
    };
  }

  await logGuardrailRejection({
    db: input.db,
    recommendationId: input.recommendationId,
    namedEntity: input.namedEntity,
    decisionUnitClaimedByModel: input.recommendation.decisionUnit,
    decisionUnitResolved,
    recommendationType: input.recommendation.recommendation,
    changePercent: input.recommendation.changePercent,
    decision,
    accountDataVersion: input.accountDataVersion,
    adOptimizationKnowledgeVersion: input.adOptimizationKnowledgeVersion,
    now,
  });

  return {
    outcome: "REJECTED",
    violations: decision.violations,
    reason: decision.reason,
    recommendationPatch: buildRejectionPatch(decision, now),
  };
}
