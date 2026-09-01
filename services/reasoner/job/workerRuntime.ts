// D4 — production wiring for the reasoner worker's Cloud Tasks HTTP target. Mirrors
// services/ingest/sync/runtime.ts's own split exactly (real Firestore, real registry, real
// archiver — GENERATE_RECOMMENDATION never calls `ctx.archiver.archive`, but `runSyncTask`
// requires one, so the same lazy, no-resource-touched-until-used default is reused rather than a
// second stub type). This is the one function server.ts calls for the `/tasks/dispatch` route —
// see that file for the actual Cloud Run HTTP glue.

import { getDb } from "@shared/firestore/index.ts";
import { createDefaultRawArchiveStore } from "@services/ingest/sync/archiver.ts";
import { createFirestoreSyncStore } from "@services/ingest/sync/store.ts";
import {
  handleTaskRequest,
  type TaskDispatchRequestBody,
  type TaskDispatchResponse,
} from "@services/ingest/sync/httpHandler.ts";
import { createReasonerWorkerRegistry } from "./workerRegistry.ts";

let cachedDeps:
  | {
      syncStore: ReturnType<typeof createFirestoreSyncStore>;
      registry: ReturnType<typeof createReasonerWorkerRegistry>;
      archiver: ReturnType<typeof createDefaultRawArchiveStore>;
    }
  | undefined;

function getWorkerRuntimeDeps() {
  if (!cachedDeps) {
    cachedDeps = {
      syncStore: createFirestoreSyncStore(getDb()),
      registry: createReasonerWorkerRegistry(),
      archiver: createDefaultRawArchiveStore(),
    };
  }
  return cachedDeps;
}

/** The real Cloud Tasks dispatch entry point for the reasoner worker. See module comment. */
export async function handleReasonerTaskDispatch(
  request: TaskDispatchRequestBody,
): Promise<TaskDispatchResponse> {
  return handleTaskRequest(request, getWorkerRuntimeDeps());
}
