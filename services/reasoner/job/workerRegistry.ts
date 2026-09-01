// D4 — the task registry the Cloud Run reasoner worker actually dispatches through. Deliberately
// NOT `services/ingest/sync/registry.ts`'s `createDefaultRegistry()`: that registry backs the
// `functions/` Cloud Functions Gen2 sync dispatch target, and §16.1/§0.2 are explicit that the
// reasoner runs on Cloud Run, never through the Hosting-rewrite-adjacent Functions path (a Fable
// 5 turn can exceed a 60s ceiling the sync tasks never approach). Keeping this registry narrow —
// just the one task type this worker actually needs to run — also means a Cloud Run instance
// dedicated to reasoning never accidentally becomes a second place META_SYNC_ENTITIES etc. could
// be dispatched from.
//
// Reuses `createTaskRegistry`/`runSyncTask`/`handleTaskRequest` from B1's framework unchanged —
// this is a second, smaller default registry, not a second framework.

import { createTaskRegistry, type TaskRegistry } from "@services/ingest/sync/registry.ts";
import { generateRecommendationRegistration } from "./generateRecommendationTask.ts";

export function createReasonerWorkerRegistry(): TaskRegistry {
  const registry = createTaskRegistry();
  registry.register(generateRecommendationRegistration);
  return registry;
}
