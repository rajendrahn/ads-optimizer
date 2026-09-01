// D4 — §16.1's job pipeline, request half: "the API writes recommendations/{id} with status
// PENDING, enqueues the work on Cloud Run via Cloud Tasks, and the client subscribes with
// onSnapshot." This is that write-and-enqueue, framework-agnostic (no HTTP types here — see
// apiHandler.ts for the thin request-in/response-out wrapper an actual API route calls).
//
// Mirrors decisionPacketStore.ts's `generateAndCacheDecisionPacket` in spirit (a plain,
// on-demand, per-request function, not a task) and taskQueue.ts's own module comment on why
// `taskId` reuse matters: passing `recommendationId` as the Cloud Tasks task id/`runSyncTask`
// idempotency key means a duplicate delivery of the SAME logical request collapses onto the SAME
// `syncRuns` doc and short-circuits after the first successful run — this step never needed to
// invent its own idempotency layer, B1's already covers it.

import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, getDb, upsertWithVersionGuard } from "@shared/firestore/index.ts";
import { recommendationSchema, type Recommendation } from "@shared/schema/index.ts";
import type { ScalableEntityRef } from "@services/evidence/index.ts";
import type { TaskQueueClient } from "@services/ingest/sync/taskQueue.ts";
import { GENERATE_RECOMMENDATION } from "@services/ingest/sync/taskTypes.ts";

export interface RequestRecommendationOptions {
  db?: Firestore;
  queue: TaskQueueClient;
  namedEntity: ScalableEntityRef;
  requestedBy?: string | null;
  requestedQuestion?: string | null;
  now?: Date;
  /** Test-only override — every real caller should let this default to a fresh UUID. Exposed so
   * a test can assert against a known id without threading the return value through. */
  recommendationId?: string;
}

export interface RequestRecommendationResult {
  recommendationId: string;
}

/**
 * Writes `recommendations/{id}` as PENDING, then enqueues `GENERATE_RECOMMENDATION`. Returns as
 * soon as both complete — never calls the model, never blocks on it. That is the entire point of
 * this being a job (§16.1): a Firebase Hosting rewrite times out at 60 seconds and a Fable 5 turn
 * can run for minutes; this function's own critical path is two small Firestore/Cloud-Tasks
 * round trips, comfortably sub-second.
 */
export async function requestRecommendation(
  options: RequestRecommendationOptions,
): Promise<RequestRecommendationResult> {
  const db = options.db ?? getDb();
  const recommendationId = options.recommendationId ?? randomUUID();
  const now = options.now ?? new Date();

  const pending: Recommendation = {
    recommendationId,
    status: "PENDING",
    packetId: null,
    decisionUnit: null,
    recommendation: null,
    currentBudgetMinorUnits: null,
    recommendedBudgetMinorUnits: null,
    changePercent: null,
    confidence: null,
    summary: null,
    primaryReasons: null,
    risks: null,
    doNotDo: null,
    recheckConditions: null,
    guardrailRejection: null,
    accountDataVersionAtGeneration: null,
    requestedBy: options.requestedBy ?? null,
    requestedQuestion: options.requestedQuestion ?? null,
    errorMessage: null,
    provenance: null,
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    rejectedByUserAt: null,
  };

  const outcome = await upsertWithVersionGuard<Recommendation>({
    db,
    collectionName: COLLECTIONS.recommendations,
    docId: recommendationId,
    incoming: pending,
    schema: recommendationSchema,
    getUpdatedAt: (doc) => doc.updatedAt,
  });
  if (outcome.action === "rejected") {
    // Unreachable in real use — recommendationId is a fresh UUID (or a test-supplied one never
    // reused across calls), so there is never a pre-existing doc to lose a version race against.
    // Surfaced loudly rather than assumed away.
    throw new Error(
      `requestRecommendation: unexpected version-guard rejection writing a brand-new recommendations/${recommendationId} — id collision?`,
    );
  }

  await options.queue.enqueue({
    taskType: GENERATE_RECOMMENDATION,
    payload: { recommendationId, namedEntity: options.namedEntity },
    taskId: recommendationId,
  });

  return { recommendationId };
}
