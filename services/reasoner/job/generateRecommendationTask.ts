// D4 — §16.1's job pipeline, worker half: the GENERATE_RECOMMENDATION task handler. Runs D2's
// packet builder (on-demand, cached) -> D3's reasoner (`generateRecommendation`) -> D5's
// guardrail seam (guardrailSeam.ts) -> a terminal write onto `recommendations/{id}`.
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
import { passthroughGuardrailValidator, type GuardrailValidator } from "./guardrailSeam.ts";
import { createGuardrailValidator } from "../guardrailAdapter.ts";

export interface GenerateRecommendationHandlerDeps {
  db?: Firestore;
  /** Test-only seam, threaded straight through to `generateRecommendation` — see
   * reasoner.ts/client.ts: passing a client here means no Secret Manager call and no live
   * Anthropic request happens, exactly like D3's own `reasoner.emulator.test.ts`. Never set in
   * the production registration below. */
  client?: Anthropic;
  effort?: GenerateRecommendationOptions["effort"];
  now?: () => Date;
  /** D5's plug-in point — see guardrailSeam.ts's module comment. Defaults to
   * `passthroughGuardrailValidator` until D5 lands. */
  guardrailValidator?: GuardrailValidator;
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
 * fake Anthropic client / guardrail validator / clock without touching the production
 * registration below, mirroring taskWrapper.ts's own `createMetaClientImpl`/
 * `createShopifyClientImpl` injection pattern.
 */
export function createGenerateRecommendationHandler(
  deps: GenerateRecommendationHandlerDeps = {},
): TaskHandler {
  return async (ctx) => {
    const db = deps.db ?? getDb();
    const now = deps.now ?? (() => new Date());
    const guardrailValidator = deps.guardrailValidator ?? passthroughGuardrailValidator;
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
      const { packet } = await generateAndCacheDecisionPacket({
        db,
        namedEntity: payload.namedEntity,
        now: now(),
      });

      const reasonerResult = await generateRecommendation({
        ctx: { db, canon: await loadReportingCanon({ db }) },
        packet,
        client: deps.client,
        effort: deps.effort,
        now: now(),
      });

      // §19.4 provenance -> Recommendation.provenance, field-for-field (see the schema comment
      // in shared/schema/decisions.ts) — no remapping needed, same shape D3 already produces.
      const provenance: RecommendationProvenance = reasonerResult.provenance;

      // D5's seam. Deliberately called with ONLY the model's own structured output — see
      // guardrailSeam.ts's module comment for why that narrowness is the actual guarantee.
      const verdict = await guardrailValidator(reasonerResult.recommendation);

      if (verdict.verdict === "REJECTED") {
        // §20.2: "rejected and logged... downgraded to INSUFFICIENT_DATA" — the schema's own
        // `status` enum comment says the same ("REJECTED... downgraded rather than surfaced
        // as-is"). Budget fields are cleared: a rejected recommendation must never present a
        // specific budget change as though it were actionable.
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
            guardrailRejection: { reason: verdict.reason, rejectedAt: now() },
            accountDataVersionAtGeneration: packet.accountDataVersion,
            provenance,
          },
          now(),
        );
        return {
          summary: { status: "REJECTED", reason: verdict.reason },
        };
      }

      current = await writeRecommendationTransition(
        db,
        current,
        {
          status: "COMPLETE",
          packetId: packet.packetId,
          ...recommendationOutputToPatch(reasonerResult.recommendation),
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
 * Secret-Manager-backed default), and **D5's real guardrail validator**.
 *
 * Wired by the orchestrator after D5 landed. D4 and D5 were built concurrently and neither
 * touched the other's files, so this call site still defaulted to `passthroughGuardrailValidator`
 * — meaning every guardrail D5 built existed but never ran, and raw model output would have been
 * persisted as final. Tests did not catch it: D4's tests inject their own validator, and D5's
 * test its validator directly, so nothing exercised the production default.
 *
 * `createGuardrailValidator` matches `GuardrailValidator` exactly — it takes only the model's
 * structured output and closes over its own independently-resolved D1 evidence and canon, so the
 * §17.3/D3.1 guarantee still holds structurally: there is no parameter through which the
 * knowledge document could reach a guardrail decision. Re-resolving evidence rather than reusing
 * what this pipeline already fetched is deliberate — a validator that trusts its caller's inputs
 * is not independent of them. */
export const generateRecommendationHandler: TaskHandler = createGenerateRecommendationHandler({
  guardrailValidator: createGuardrailValidator(),
});

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
