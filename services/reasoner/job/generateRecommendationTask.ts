// D4 — §16.1's job pipeline, worker half: the GENERATE_RECOMMENDATION task handler. Runs D2's
// packet builder (on-demand, cached) -> D3's reasoner (`generateRecommendation`) -> D5's real
// guardrail application (`applyGuardrails`, ../guardrailLog.ts) -> a terminal write onto
// `recommendations/{id}`.
//
// ⚠️ **Corrective note (post-D6, pre-Phase-E).** D4 and D5 were built concurrently; D4 originally
// defined a deliberately narrow injection seam (`guardrailSeam.ts`, since deleted) that only
// D5's structured model output — not `recommendationId` — could pass through, and D5 shipped an
// adapter (`guardrailAdapter.ts`, since deleted) conforming to it. That adapter had no real
// `recommendationId` in scope and synthesized one (`adapter_{type}_{id}_{timestamp}`) for the
// `guardrailRejections/{id}` log §20.2 calls E3's own calibration signal — making that log
// unjoinable to the recommendation it rejected. **Fixed:** this handler now calls `applyGuardrails`
// directly, with the real `recommendationId`/`namedEntity`/`accountDataVersion`/
// `adOptimizationKnowledgeVersion` already in scope in this very function — see the call site
// below. The log is now keyed by the real `recommendationId`, no synthesis, no fallback query
// needed on the read side (`web/server/viewModel.ts` was updated to match). There is now exactly
// ONE guardrail integration path in production; see IMPLEMENTATION_PLAN.md D4/D5's notes for the
// full history of why two existed and why that was the bug, not a feature.
//
// Registered into B1's task framework exactly like every other derived/internal task
// (decisionPacketStore.ts's own `markDecisionPacketsStaleRegistration` is the closest precedent:
// Firestore-backed, `runSource: "internal"`, `syncStateTarget: null` — no watermark, this is a
// per-request unit of work, not a windowed sync). `runSyncTask` (taskWrapper.ts) gives this
// handler, for free, exactly what §16.1/this step's own "Done when" needs:
//   - idempotency: a duplicate Cloud Tasks delivery of the same `taskId` (== recommendationId,
//     see request.ts) short-circuits without re-running the model a second time;
//   - structured error recording in `syncRuns` on top of the `errorMessage` this handler itself
//     stamps onto the `recommendations/{id}` doc (see the catch block below) — two independent,
//     complementary failure logs, matching every other task type in this codebase;
//   - retry semantics per Cloud Tasks queue config (this handler does not special-case
//     retryability — see "Ambiguities resolved" in IMPLEMENTATION_PLAN.md D4's own notes).
//
// **Progress states on the document** (§16.1 "gives progress states for free" + this step's own
// "surfaced on the document for the client to observe" deliverable): every transition below is a
// real, individually-observable Firestore write — a client subscribed via `onSnapshot` on
// `recommendations/{id}` sees PENDING -> GENERATING -> (COMPLETE | REJECTED | FAILED), never a
// silent jump from PENDING straight to a terminal state.

import type { Firestore } from "firebase-admin/firestore";
import type Anthropic from "@anthropic-ai/sdk";
import {
  COLLECTIONS,
  createRepository,
  getDb,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { loadReportingCanon } from "@shared/canon/index.ts";
import {
  recommendationSchema,
  type Recommendation,
  type RecommendationProvenance,
} from "@shared/schema/index.ts";
import { generateAndCacheDecisionPacket } from "@services/evidence/index.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import { GENERATE_RECOMMENDATION } from "@services/ingest/sync/taskTypes.ts";
import { generateRecommendation, type GenerateRecommendationOptions } from "../reasoner.ts";
import type { RecommendationOutput } from "../types.ts";
import { generateRecommendationPayloadSchema } from "./types.ts";
import { applyGuardrails } from "../guardrailLog.ts";

export interface GenerateRecommendationHandlerDeps {
  db?: Firestore;
  /** Test-only seam, threaded straight through to `generateRecommendation` — see
   * reasoner.ts/client.ts: passing a client here means no Secret Manager call and no live
   * Anthropic request happens, exactly like D3's own `reasoner.emulator.test.ts`. Never set in
   * the production registration below. */
  client?: Anthropic;
  effort?: GenerateRecommendationOptions["effort"];
  now?: () => Date;
}

/** Maps D3's own structured output straight onto `Recommendation`'s fields — D3's own note:
 * "matching them field-for-field means D4 can assign this step's output straight into the
 * recommendations/{id} document it writes with no remapping." This is that assignment. */
function recommendationOutputToPatch(output: RecommendationOutput): Partial<Recommendation> {
  return {
    decisionUnit: output.decisionUnit,
    recommendation: output.recommendation,
    currentBudgetMinorUnits: output.currentBudgetMinorUnits,
    recommendedBudgetMinorUnits: output.recommendedBudgetMinorUnits,
    changePercent: output.changePercent,
    confidence: output.confidence,
    summary: output.summary,
    primaryReasons: output.primaryReasons,
    risks: output.risks,
    doNotDo: output.doNotDo,
    recheckConditions: output.recheckConditions,
  };
}

/**
 * One transition, one Firestore write, version-guarded on `updatedAt` (the same monotonic-write
 * discipline A2 established everywhere else — see versionGuard.ts's own module comment). In the
 * normal single-writer flow this handler is the only thing ever transitioning THIS
 * recommendationId (idempotency above means a duplicate delivery never re-enters this function
 * at all), so a rejection here would mean something else raced this doc — surfaced loudly rather
 * than silently dropped.
 */
async function writeRecommendationTransition(
  db: Firestore,
  current: Recommendation,
  patch: Partial<Recommendation>,
  now: Date,
): Promise<Recommendation> {
  const next: Recommendation = { ...current, ...patch, updatedAt: now };
  const outcome = await upsertWithVersionGuard<Recommendation>({
    db,
    collectionName: COLLECTIONS.recommendations,
    docId: next.recommendationId,
    incoming: next,
    schema: recommendationSchema,
    getUpdatedAt: (doc) => doc.updatedAt,
  });
  if (outcome.action === "rejected") {
    throw new Error(
      `GENERATE_RECOMMENDATION: version-guard rejected a status transition on recommendations/${next.recommendationId} — a concurrent writer raced this document`,
    );
  }
  return outcome.data;
}

/**
 * Builds the task handler. A plain factory (not a module-level constant) so tests can inject a
 * fake Anthropic client / clock without touching the production registration below, mirroring
 * taskWrapper.ts's own `createMetaClientImpl`/`createShopifyClientImpl` injection pattern.
 *
 * There is deliberately no injectable guardrail seam any more (see this module's own corrective
 * note above) — `applyGuardrails` (D5's real §20.2 logic) always runs, for every caller of this
 * factory including every test. A test that wants a REJECTED outcome gets one honestly, by
 * seeding evidence/a model output that a real guardrail rejects (see
 * generateRecommendationTask.emulator.test.ts's own test 4), not by injecting a stand-in — the
 * whole point of this fix is that there is exactly one guardrail code path, so nothing can test
 * green against a fake one while production runs a different one.
 */
export function createGenerateRecommendationHandler(
  deps: GenerateRecommendationHandlerDeps = {},
): TaskHandler {
  return async (ctx) => {
    const db = deps.db ?? getDb();
    const now = deps.now ?? (() => new Date());
    const payload = generateRecommendationPayloadSchema.parse(ctx.payload);

    const recRepo = createRepository<Recommendation>(
      db,
      COLLECTIONS.recommendations,
      recommendationSchema,
    );
    const existing = await recRepo.get(payload.recommendationId);
    if (!existing) {
      // Not retryable by fixing anything here — the doc genuinely doesn't exist. Either
      // request.ts's own write hasn't landed yet (shouldn't happen: it writes before enqueuing)
      // or this task was dispatched by hand with a bogus id. Thrown, not silently returned, so
      // syncRuns records the failure — there is no recommendations/{id} doc to write an
      // errorMessage onto in this one case.
      throw new Error(
        `GENERATE_RECOMMENDATION: no recommendations/${payload.recommendationId} document exists — it must be written PENDING before this task is enqueued (see request.ts)`,
      );
    }

    let current = await writeRecommendationTransition(
      db,
      existing,
      { status: "GENERATING" },
      now(),
    );

    try {
      const canon = await loadReportingCanon({ db });

      const { packet, evidenceResult } = await generateAndCacheDecisionPacket({
        db,
        namedEntity: payload.namedEntity,
        now: now(),
      });

      const reasonerResult = await generateRecommendation({
        ctx: { db, canon },
        packet,
        client: deps.client,
        effort: deps.effort,
        now: now(),
      });

      // §19.4 provenance -> Recommendation.provenance, field-for-field (see the schema comment
      // in shared/schema/decisions.ts) — no remapping needed, same shape D3 already produces.
      const provenance: RecommendationProvenance = reasonerResult.provenance;

      const guardrailNow = now();

      // D5's real guardrail application (§20.2), called directly — the recommendationId,
      // namedEntity, accountDataVersion and knowledge version are all already in scope right
      // here, so `guardrailRejections/{recommendationId}` is keyed on the REAL id (see this
      // module's own corrective note above; no more synthesized id, no more fallback query
      // needed on the read side).
      //
      // `evidenceResult` is D1's own `resolveScalingEvidence` output, captured by
      // `generateAndCacheDecisionPacket` BEFORE `generateRecommendation` (the model) ran above —
      // reused here as-is, never re-derived from anything the model claimed. That is what keeps
      // this "independently-resolved evidence" in the sense §20.2/D5 require: it comes from D1's
      // own Meta/Shopify-sourced Firestore read, not from the model's output, even though it is
      // not re-fetched a second time from Firestore at this exact call site.
      const application = await applyGuardrails({
        db,
        recommendationId: payload.recommendationId,
        namedEntity: packet.namedEntity,
        recommendation: reasonerResult.recommendation,
        evidenceResult,
        canon,
        accountDataVersion: packet.accountDataVersion,
        adOptimizationKnowledgeVersion: provenance.adOptimizationKnowledgeVersion,
        now: guardrailNow,
      });

      if (application.outcome === "REJECTED") {
        // §20.2: "rejected and logged... downgraded to INSUFFICIENT_DATA" — the schema's own
        // `status` enum comment says the same ("REJECTED... downgraded rather than surfaced
        // as-is"). Budget fields are cleared: a rejected recommendation must never present a
        // specific budget change as though it were actionable. The model's own summary/
        // primaryReasons/risks/doNotDo are KEPT, not overwritten with `applyGuardrails`' own
        // `recommendationPatch` text (D4's own "Ambiguities resolved" #4 — the rejection log
        // is itself §20.2's own calibration signal, and a reviewer benefits from seeing WHY the
        // model proposed what it did, not just that it was rejected) — so this handler builds
        // its own patch here rather than spreading `application.recommendationPatch` wholesale.
        current = await writeRecommendationTransition(
          db,
          current,
          {
            status: "REJECTED",
            packetId: packet.packetId,
            decisionUnit: reasonerResult.recommendation.decisionUnit,
            recommendation: "INSUFFICIENT_DATA",
            currentBudgetMinorUnits: null,
            recommendedBudgetMinorUnits: null,
            changePercent: null,
            confidence: reasonerResult.recommendation.confidence,
            summary: reasonerResult.recommendation.summary,
            primaryReasons: reasonerResult.recommendation.primaryReasons,
            risks: reasonerResult.recommendation.risks,
            doNotDo: reasonerResult.recommendation.doNotDo,
            recheckConditions: null,
            guardrailRejection: { reason: application.reason, rejectedAt: guardrailNow },
            accountDataVersionAtGeneration: packet.accountDataVersion,
            provenance,
          },
          now(),
        );
        return {
          summary: { status: "REJECTED", reason: application.reason },
        };
      }

      current = await writeRecommendationTransition(
        db,
        current,
        {
          status: "COMPLETE",
          packetId: packet.packetId,
          ...recommendationOutputToPatch(reasonerResult.recommendation),
          // D5's own confidence adjustment (recent-major-change / composite-creative penalties,
          // §20.2) persisted in place of the model's own raw `confidence` — never the reverse;
          // see guardrailLog.ts's `GuardrailApplication.adjustedConfidence` doc. The narrow
          // adapter this replaces (see corrective note above) silently dropped this adjustment
          // entirely, since its `GuardrailVerdict` had no field for it — persisted recommendations
          // never actually reflected D5's confidence penalties until this fix.
          confidence: application.adjustedConfidence,
          guardrailRejection: null,
          accountDataVersionAtGeneration: packet.accountDataVersion,
          provenance,
        },
        now(),
      );
      return {
        summary: {
          status: "COMPLETE",
          recommendation: reasonerResult.recommendation.recommendation,
        },
      };
    } catch (err) {
      // §D4's own "Done when": "a worker failure leaves a legible error state rather than a
      // stuck PENDING." The doc is already past PENDING (GENERATING, written above) — this is
      // the terminal write. errorMessage carries the real cause; the same error is rethrown
      // below so syncRuns records it too (taskWrapper.ts's own structured error recording) and
      // Cloud Tasks' own retry policy still applies (see "Ambiguities resolved" — this handler
      // deliberately does not override retry classification).
      const message = err instanceof Error ? err.message : String(err);
      await writeRecommendationTransition(
        db,
        current,
        { status: "FAILED", errorMessage: message },
        now(),
      );
      throw err;
    }
  };
}

/** The production handler — real Firestore, real Anthropic client (via reasoner.ts's own
 * Secret-Manager-backed default), and D5's real guardrail application (`applyGuardrails`), which
 * is now `createGenerateRecommendationHandler`'s own unconditional internal behaviour, not an
 * injected option — see this module's own corrective note at the top of the file.
 *
 * **History, so this isn't rediscovered as a new bug.** D4 and D5 were built concurrently. D4
 * originally left a `guardrailValidator` option here (default: an always-accepting passthrough),
 * and D5 shipped an adapter (`createGuardrailValidator`, `guardrailAdapter.ts`) conforming to
 * D4's own deliberately narrow `GuardrailValidator` seam. When they were wired together, this
 * call site used that adapter — real guardrail enforcement, but with a fatal flaw: the adapter's
 * narrow seam had no `recommendationId` in scope, so its rejection log was written under a
 * SYNTHESIZED id (`adapter_{type}_{id}_{timestamp}`), unjoinable to the recommendation it
 * rejected (§20.2 calls that log E3's own calibration signal) — `web/server/viewModel.ts` grew a
 * fallback prefix-query workaround just to find those entries at all. Neither D4's nor D5's own
 * tests caught it because each injected its own stand-in validator; nothing exercised the
 * production default (the exact same class of gap C2/C5's seasonality provider hit before this).
 *
 * **The fix.** `applyGuardrails` (guardrailLog.ts) is called directly inside
 * `createGenerateRecommendationHandler`'s own try block, where `recommendationId`/`namedEntity`/
 * `accountDataVersion`/`adOptimizationKnowledgeVersion` are already in scope — no seam, no
 * adapter, no synthesized id. `guardrailSeam.ts` and `guardrailAdapter.ts` are deleted; there is
 * now exactly one guardrail integration path, and it is this one. The knowledge-document
 * exclusion guarantee still holds — not via this seam (which never enforced it) but structurally,
 * via `validateGuardrails`'s own input type (`{recommendation, evidenceResult, canon}`, no
 * knowledge/provenance field — `guardrails.test.ts`'s own `TS2353` compile-error test proves it).
 *
 * `generateRecommendationTask.emulator.test.ts`'s own test 4b proves the production DEFAULT
 * enforces guardrails — the test this whole class of bug needed and never had. It cannot literally
 * invoke this exact exported constant (that would require a live Anthropic call via
 * reasoner.ts's own Secret-Manager-backed default client, forbidden by this codebase's own "no
 * live model call in tests" rule); instead it builds a handler via `createGenerateRecommendationHandler({
 * client: <fake> })` — overriding ONLY the Anthropic client, the one override every other test in
 * this file already uses to avoid a live call — and passes no guardrail-related option at all,
 * because none exists any more. Since `generateRecommendationHandler` above is exactly
 * `createGenerateRecommendationHandler()` with every option left at its default, and the factory
 * has no parameter through which a caller could swap out or bypass `applyGuardrails`, a handler
 * built this way exercises the IDENTICAL guardrail code path production does — the only
 * difference is which object answers `client.beta.messages.create`. */
export const generateRecommendationHandler: TaskHandler = createGenerateRecommendationHandler();

/** Registered into `createDefaultRegistry()` (services/ingest/sync/registry.ts). `runSource:
 * "internal"` and `syncStateTarget: null` for the same reason `MARK_DECISION_PACKETS_STALE`
 * (D2) and `RECOMPUTE_FEATURES` (C2) use them: this is per-request derived work with no
 * external-source watermark of its own. */
export const generateRecommendationRegistration: TaskRegistration = {
  taskType: GENERATE_RECOMMENDATION,
  runSource: "internal",
  syncStateTarget: null,
  handler: generateRecommendationHandler,
};
