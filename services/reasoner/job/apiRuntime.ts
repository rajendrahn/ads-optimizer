// D4 — production wiring for the recommendation-request API route (§16.1's "API (Cloud Run)
// writes PENDING doc, enqueues the job" box). Mirrors services/ingest/sync/runtime.ts's split:
// real Firestore, a real `CloudTasksQueueClient` built from B1's own `createDefaultTaskQueueClient`
// (services/ingest/sync/taskQueue.ts) — never constructed anywhere in this step's own tests, per
// this step's safety constraints (no real Cloud Tasks queue exists yet to point at).
//
// Deploy-time facts (which queue, which region, which worker URL to POST to, which service
// account signs the OIDC token) are deliberately NOT hardcoded here or in scripts/config.ts —
// B1's own taskQueue.ts module comment already established this precedent
// ("these are deploy-time facts this module has no way to know on its own... not called
// anywhere in this step's own tests"). They are read from environment variables instead, which is
// how Cloud Run naturally receives per-deployment configuration (`gcloud run deploy
// --set-env-vars`) — see server.ts and this step's report for the exact variable names and the
// deploy command that sets them.

import { getDb } from "@shared/firestore/index.ts";
import { createDefaultTaskQueueClient } from "@services/ingest/sync/taskQueue.ts";
import type { HandleRecommendationRequestDeps } from "./apiHandler.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `apiRuntime: missing required environment variable ${name} — see IMPLEMENTATION_PLAN.md ` +
        `D4's notes for the full list this Cloud Run service needs at deploy time.`,
    );
  }
  return value;
}

let cachedDeps: HandleRecommendationRequestDeps | undefined;

/** Constructed lazily (not at module load) so importing this file — e.g. from a test — never
 * requires the env vars to be set unless this is actually called. */
export function getApiRuntimeDeps(): HandleRecommendationRequestDeps {
  if (!cachedDeps) {
    cachedDeps = {
      db: getDb(),
      queue: createDefaultTaskQueueClient({
        location: requireEnv("RECOMMENDATION_QUEUE_LOCATION"),
        queue: requireEnv("RECOMMENDATION_QUEUE_NAME"),
        targetUrl: requireEnv("REASONER_WORKER_TASK_URL"),
        serviceAccountEmail: process.env.REASONER_WORKER_INVOKER_SERVICE_ACCOUNT,
      }),
    };
  }
  return cachedDeps;
}
