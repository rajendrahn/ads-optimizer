// D2's Firestore glue: build a packet (packetBuilder.ts, pure) for a named entity, cache it
// (§10.1's "and cache it"), and mark previously-cached packets stale once accountDataVersion has
// moved past them. Two independent operations, both small and Firestore-only:
//
//   - `generateAndCacheDecisionPacket` — on-demand, per-entity, exactly like D1's own
//     `resolveScalingEvidence` (which this calls directly rather than re-deriving anything). Not
//     registered as a Cloud Tasks task type, for the same reason D1 gave for its own entry point:
//     nothing here is a scheduled/queued unit of ingestion or recompute work (§10.2) — it is the
//     read-and-cache path D3's tools call directly when a question names an entity.
//   - `markStalePackets` / `MARK_DECISION_PACKETS_STALE` — IS registered as a task type, because
//     unlike packet generation this genuinely is the shape §10.2 means: an internal, Firestore-
//     only, no-live-call, no-watermark bulk pass over many documents, run after a sync (the
//     design's own §10.1 flow diagram literally chains it after "bump accountDataVersion"), the
//     same shape as C3's COMPUTE_STATISTICS and C4's ENRICH_CHANGE_FEATURES. Following those two
//     steps' own precedent (a sync-orchestrator concept that doesn't exist yet in this codebase —
//     `scalingEvidenceEngine.emulator.test.ts`'s own `runFullPipeline()` invokes
//     RECOMPUTE_FEATURES/COMPUTE_STATISTICS/ENRICH_CHANGE_FEATURES explicitly, in order, rather
//     than one task auto-chaining into the next), this task is registered and independently
//     invokable but nothing yet calls it automatically after a real sync run — that chaining is
//     D4's job-pipeline concern, not D2's. Flagged explicitly per §0.2's own instruction to raise
//     rather than silently diverge.

import type { Firestore } from "firebase-admin/firestore";
import {
  getDb,
  COLLECTIONS,
  createRepository,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { loadReportingCanon } from "@shared/canon/index.ts";
import {
  accountFeaturesSchema,
  decisionPacketSchema,
  type DecisionPacket,
  type EntityFeatures,
} from "@shared/schema/index.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import { buildDecisionPacket } from "./packetBuilder.ts";
import { resolveScalingEvidence } from "./scalingEvidenceEngine.ts";
import type { ScalableEntityRef, ScalingEvidenceResult } from "./types.ts";

/** The account's current monotonic `accountDataVersion` (§10.1) — the same
 * `accountFeatures/{accountId}` document `accountDataVersion.ts` (C2) already reads, here read
 * as "the version as of right now" rather than "+1 for the next recompute run". `0` when no
 * RECOMPUTE_FEATURES run has ever completed (first-ever run, or a fresh emulator) — every packet
 * built before then is honestly stamped `accountDataVersion: 0`, never a fabricated positive
 * number. */
async function readCurrentAccountDataVersion(db: Firestore, accountId: string): Promise<number> {
  const repo = createRepository<EntityFeatures>(
    db,
    COLLECTIONS.accountFeatures,
    accountFeaturesSchema,
  );
  const doc = await repo.get(accountId);
  return doc?.accountDataVersion ?? 0;
}

export interface GenerateAndCacheDecisionPacketOptions {
  db?: Firestore;
  namedEntity: ScalableEntityRef;
  accountId?: string;
  now?: Date;
}

export interface GenerateAndCacheDecisionPacketResult {
  packet: DecisionPacket;
  /** "written" unless a fresher packet (by `createdAt`) was already cached for this entity,
   * in which case the write is rejected and the ALREADY-CACHED packet is returned instead —
   * `upsertWithVersionGuard`'s own out-of-order-write protection (§9.5), reused here so a slow
   * regeneration can never clobber a fresher one that finished first. */
  action: "written" | "rejected-kept-existing";
  /** D1's own typed `resolveScalingEvidence` result — the SAME call whose output `buildDecisionPacket`
   * below turned into `packet.evidence`'s untyped `Record<string, unknown>` (Firestore's own
   * shape, JSON-round-tripped to drop `undefined`). Returned here too, still fully typed, so a
   * caller that needs to re-validate against it (D4's job pipeline, feeding D5's
   * `applyGuardrails`) does not have to reconstruct `ScalingEvidenceResult` from the packet's
   * untyped blob via an unsafe cast, and does not have to re-resolve evidence a second time
   * either — this IS the independently-computed-before-the-model-ran evidence D5's guardrail
   * must validate against (see guardrailLog.ts's own `ApplyGuardrailsInput.evidenceResult` doc),
   * never re-derived from anything the model said. On the `"rejected-kept-existing"` branch this
   * is still THIS call's own fresh resolution (not the existing packet's, which may be older) —
   * the more current of the two, and the correct one for a guardrail to judge against regardless
   * of which packet ends up cached. */
  evidenceResult: ScalingEvidenceResult;
}

/**
 * D1 (`resolveScalingEvidence`) -> D2 (`buildDecisionPacket`) -> cache (`upsertWithVersionGuard`,
 * keyed by `createdAt` since `decisionPacketSchema` has no `sourceUpdatedAt` field to default to)
 * — end to end, for one named entity. This is the function D3's tools call.
 */
export async function generateAndCacheDecisionPacket(
  options: GenerateAndCacheDecisionPacketOptions,
): Promise<GenerateAndCacheDecisionPacketResult> {
  const db = options.db ?? getDb();
  const canon = await loadReportingCanon({ db, accountId: options.accountId });
  const currentAccountDataVersion = await readCurrentAccountDataVersion(db, canon.accountId);

  const result = await resolveScalingEvidence({
    db,
    namedEntity: options.namedEntity,
    accountId: options.accountId,
  });

  const packet = buildDecisionPacket({
    namedEntity: options.namedEntity,
    result,
    currentAccountDataVersion,
    now: options.now ?? new Date(),
  });

  const outcome = await upsertWithVersionGuard<DecisionPacket>({
    db,
    collectionName: COLLECTIONS.decisionPackets,
    docId: packet.packetId,
    incoming: packet,
    schema: decisionPacketSchema,
    getUpdatedAt: (doc) => doc.createdAt,
  });

  if (outcome.action === "rejected") {
    const existing = await createRepository<DecisionPacket>(
      db,
      COLLECTIONS.decisionPackets,
      decisionPacketSchema,
    ).get(packet.packetId);
    return { packet: existing ?? packet, action: "rejected-kept-existing", evidenceResult: result };
  }
  return { packet: outcome.data, action: "written", evidenceResult: result };
}

export interface MarkStalePacketsResult {
  currentAccountDataVersion: number;
  /** How many NOT-YET-stale packets were checked against the current version. */
  checked: number;
  /** How many of those were behind the current version and just got flipped. */
  markedStale: number;
}

/**
 * §10.1's "mark all decision packets stale" step, run on demand (also wired to the
 * MARK_DECISION_PACKETS_STALE task type below). Only ever touches packets with `isStale: false`
 * (already-stale ones need no write — idempotent by construction, satisfying §10.2's own
 * idempotency requirement without a separate guard) and, among those, only ones whose
 * `accountDataVersion` sits strictly behind the account's current one. Queries by `isStale ==
 * false` alone (no composite index needed) and filters the version comparison in memory — this
 * account's packet volume (well under 100 decision units, matching §10.1's own "a few thousand
 * small reads and writes... well under a second" reasoning) makes that the simpler choice over
 * adding a new composite index for a range comparison.
 */
export async function markStalePackets(
  db: Firestore,
  accountId: string,
): Promise<MarkStalePacketsResult> {
  const currentAccountDataVersion = await readCurrentAccountDataVersion(db, accountId);
  const repo = createRepository<DecisionPacket>(
    db,
    COLLECTIONS.decisionPackets,
    decisionPacketSchema,
  );
  const freshDocs = await repo.query((ref) => ref.where("isStale", "==", false));

  let markedStale = 0;
  for (const doc of freshDocs) {
    if (doc.accountDataVersion < currentAccountDataVersion) {
      await repo.set(doc.packetId, { ...doc, isStale: true });
      markedStale++;
    }
  }
  return { currentAccountDataVersion, checked: freshDocs.length, markedStale };
}

export const markDecisionPacketsStaleHandler: TaskHandler = async () => {
  const canon = await loadReportingCanon();
  const db = getDb();
  const result = await markStalePackets(db, canon.accountId);
  return {
    newRowCount: result.markedStale,
    summary: { ...result },
  };
};

/** Not in §10.2's original task-type list (that list predates this step) — D2's own addition,
 * following B5/B6/B7/B8/C1/C3/C4/C5's own precedent of extending the list rather than overloading
 * an unrelated existing task type. See this module's header comment for why this — unlike
 * `generateAndCacheDecisionPacket` — earns a task type. */
export const markDecisionPacketsStaleRegistration: TaskRegistration = {
  taskType: "MARK_DECISION_PACKETS_STALE",
  runSource: "internal",
  syncStateTarget: null,
  handler: markDecisionPacketsStaleHandler,
};
