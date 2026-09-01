// D6 — runtime wiring for the web API. Assembles: the Firestore handle, the reporting canon
// (currency/timezone shown on every card per §24), the auth verifier, and a task dispatcher for
// GENERATE_RECOMMENDATION.
//
// **No real Cloud Tasks queue is created or pointed at anywhere in this file** — this step's
// safety constraints forbid provisioning cloud resources, and D4 already left that seam
// (`apiRuntime.ts`'s `createDefaultTaskQueueClient`) as an explicit, deploy-time, operator-wired
// thing "not called anywhere in this step's own tests." This file mirrors that choice: `enqueue`
// records the task (`createInMemoryTaskQueueClient`, B1's own in-memory client) and this module's
// own `dispatch` runs it in-process, one call, right after the recommendation is written — see
// handlers.ts for why that ordering matters (the `namedEntity` patch race). An operator who wants
// this to run for real across two Cloud Run services swaps this file's `queue`/`dispatch` for
// `apiRuntime.ts`'s real `createDefaultTaskQueueClient` and lets Cloud Tasks call the deployed
// worker's `/tasks/dispatch` instead — no other file changes.
//
// Two reasoner modes, chosen by `ANTHROPIC_LIVE`:
//   - unset (the default, and this step's own tests): a scripted fake Anthropic client
//     (demoReasoner.ts) stands in for the model — no live API call — but the REAL D1/D2 evidence
//     pipeline and the REAL D5 guardrail validator (`createGuardrailValidator`, imported read-only
//     from services/reasoner/index.ts) still run, so a demo request can genuinely land on any of
//     EVIDENCE / NOT_DELIVERING / NO_DECISION_UNIT / REJECTED / FAILED.
//   - "1": the real, unmodified production handler (`generateRecommendationHandler` from
//     services/reasoner/job/generateRecommendationTask.ts) — a real Anthropic key resolved from
//     Secret Manager, the real guardrail. For an operator who has real credentials and wants to
//     run this locally without deploying Cloud Run.

import type { Firestore } from "firebase-admin/firestore";
import {
  getDb,
  COLLECTIONS,
  createRepository,
  decisionPacketKey,
} from "@shared/firestore/index.ts";
import { loadReportingCanon } from "@shared/canon/index.ts";
import { decisionPacketSchema, type DecisionPacket } from "@shared/schema/index.ts";
import { createGuardrailValidator } from "@services/reasoner/index.ts";
import {
  createGenerateRecommendationHandler,
  generateRecommendationHandler,
} from "@services/reasoner/job/generateRecommendationTask.ts";
import type { GenerateRecommendationPayload } from "@services/reasoner/job/types.ts";
import { createTaskRegistry, type TaskRegistry } from "@services/ingest/sync/registry.ts";
import { runSyncTask } from "@services/ingest/sync/taskWrapper.ts";
import { createFirestoreSyncStore } from "@services/ingest/sync/store.ts";
import {
  createInMemoryTaskQueueClient,
  type TaskQueueClient,
} from "@services/ingest/sync/taskQueue.ts";
import { GENERATE_RECOMMENDATION } from "@services/ingest/sync/taskTypes.ts";
import type { RawArchiveStore } from "@services/ingest/sync/archiver.ts";
import { createDemoAnthropicClient } from "./demoReasoner.ts";
import { getAuthVerifier, type AuthVerifierLike } from "./auth.ts";

/** GENERATE_RECOMMENDATION never archives a raw payload (D4's own note: "runSyncTask requires
 * one, so the same lazy, no-resource-touched-until-used default is reused rather than a second
 * stub type") — this mirrors that with a genuine no-op rather than reaching for
 * `createDefaultRawArchiveStore()`, which would need a real GCS bucket this step must not touch. */
const noopArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

export interface WebServerDeps {
  db: Firestore;
  reportingCurrency: string;
  reportingTimezone: string;
  authVerifier: AuthVerifierLike;
  /** Records a GENERATE_RECOMMENDATION task — passed straight to D4's own unmodified
   * `requestRecommendation`. */
  queue: TaskQueueClient;
  /** Runs the ONE most-recently-enqueued task to completion, in-process. Never throws into the
   * caller — a genuine model/reasoner failure is a legitimate FAILED state on the document
   * itself (D4's own contract), not an API-level error; this function's job is only to make sure
   * that transition actually happens, and to log if the run itself could not even be dispatched
   * (e.g. a malformed payload). */
  dispatchLatest(): Promise<void>;
}

let cached: WebServerDeps | undefined;

/**
 * Builds the demo registry. The scripted fake Anthropic client's `create()` (demoReasoner.ts) is
 * only ever invoked from WITHIN `generateRecommendation` (D3's reasoner.ts) — which itself only
 * runs after `generateAndCacheDecisionPacket` has already built and written the packet
 * (`generateRecommendationTask.ts`'s own ordering) — so a fresh, per-call Firestore read of
 * `decisionPackets/{decisionPacketKey(currentNamedEntity)}`, done lazily at the moment `create()`
 * actually fires, always sees THIS attempt's own packet, never a stale one from a previous
 * request. `currentNamedEntity` is set immediately before delegating to the real handler and
 * cleared in a `finally`, so two requests dispatched back-to-back (never concurrently — this
 * module only ever runs one task at a time, see `dispatchLatest`) can't cross-contaminate.
 */
function buildDemoRegistry(db: Firestore): TaskRegistry {
  const registry = createTaskRegistry();
  let currentNamedEntity: GenerateRecommendationPayload["namedEntity"] | null = null;

  const client = createDemoAnthropicClient(async () => {
    if (!currentNamedEntity) return null;
    const packetId = decisionPacketKey(currentNamedEntity.type, currentNamedEntity.id);
    return createRepository<DecisionPacket>(
      db,
      COLLECTIONS.decisionPackets,
      decisionPacketSchema,
    ).get(packetId);
  });

  registry.register({
    taskType: GENERATE_RECOMMENDATION,
    runSource: "internal",
    syncStateTarget: null,
    handler: async (ctx) => {
      const payload = ctx.payload as GenerateRecommendationPayload;
      currentNamedEntity = payload.namedEntity;
      try {
        return await createGenerateRecommendationHandler({
          db,
          client,
          guardrailValidator: createGuardrailValidator({ db }),
        })(ctx);
      } finally {
        currentNamedEntity = null;
      }
    },
  });
  return registry;
}

function buildLiveRegistry(): TaskRegistry {
  const registry = createTaskRegistry();
  registry.register({
    taskType: GENERATE_RECOMMENDATION,
    runSource: "internal",
    syncStateTarget: null,
    handler: generateRecommendationHandler,
  });
  return registry;
}

// Single-flight per taskId — the demo registry's `currentNamedEntity` closure (above) is only
// safe if exactly one GENERATE_RECOMMENDATION handler invocation is ever in flight at a time for
// a given task; two genuinely concurrent runs of the SAME taskId would race each other on that
// shared variable (and, in the live registry, D4's own version-guard would simply reject the
// loser's transition writes as "a concurrent writer raced this document"). `runSyncTask`'s own
// idempotency only protects against re-running an ALREADY-SUCCEEDED task, not two overlapping
// in-flight runs — this map closes that gap. It also means calling `dispatchLatest()` more than
// once for the same task (this module's own tests do this deliberately, to force-wait for
// completion) is not a silent no-op but genuinely AWAITS the one real run, exactly once.
const inFlightDispatches = new Map<string, Promise<void>>();

async function dispatch(
  db: Firestore,
  registry: TaskRegistry,
  task: { taskId: string; payload: unknown },
): Promise<void> {
  const existing = inFlightDispatches.get(task.taskId);
  if (existing) return existing;

  const run = (async () => {
    const syncStore = createFirestoreSyncStore(db);
    try {
      const result = await runSyncTask({
        syncStore,
        registry,
        taskType: GENERATE_RECOMMENDATION,
        payload: task.payload,
        taskId: task.taskId,
        archiver: noopArchiver,
      });
      if (result.status === "FAILED") {
        // Expected and already fully recorded — generateRecommendationTask.ts stamps FAILED +
        // errorMessage onto the recommendation doc itself before rethrowing (D4's own contract);
        // this is just process-level visibility, never re-thrown into an HTTP response no one is
        // waiting on (the create route already returned 202).
        console.warn(`[web/server] GENERATE_RECOMMENDATION ${task.taskId} failed: ${result.error}`);
      }
    } catch (err) {
      console.error(`[web/server] GENERATE_RECOMMENDATION ${task.taskId} dispatch threw`, err);
    } finally {
      inFlightDispatches.delete(task.taskId);
    }
  })();

  inFlightDispatches.set(task.taskId, run);
  return run;
}

/** Constructed lazily, once per process — mirrors D4's own `apiRuntime.ts`/`workerRuntime.ts`
 * caching. `ANTHROPIC_LIVE=1` switches the reasoner mode; every other var this needs
 * (`FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`) is read by the Admin SDK itself, the
 * same as every other step in this codebase. */
export async function getWebServerDeps(): Promise<WebServerDeps> {
  if (cached) return cached;
  const db = getDb();
  const canon = await loadReportingCanon({ db });
  const registry = process.env.ANTHROPIC_LIVE === "1" ? buildLiveRegistry() : buildDemoRegistry(db);
  const queue = createInMemoryTaskQueueClient();

  cached = {
    db,
    reportingCurrency: canon.reportingCurrency,
    reportingTimezone: canon.reportingTimezone,
    authVerifier: getAuthVerifier(),
    queue,
    dispatchLatest: async () => {
      const task = queue.enqueued[queue.enqueued.length - 1];
      if (!task) return;
      await dispatch(db, registry, task);
    },
  };
  return cached;
}

/** Test-only: clears the cached deps so a fresh test can seed a different `settings/{accountId}`
 * and rebuild against it. Callers should also call `resetReportingCanonCacheForTests()`
 * (`@shared/canon`) — this does not do that itself, matching every other cache-reset helper in
 * this codebase (each layer resets its own cache). */
export function __resetWebServerDepsForTests(): void {
  cached = undefined;
}
