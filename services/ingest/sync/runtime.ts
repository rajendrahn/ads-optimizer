// Production wiring for the Cloud Tasks HTTP target — real Firestore, real default registry,
// real raw archive bucket. Everything `handleTaskRequest` (httpHandler.ts) needs as `deps`,
// constructed for real, with no test seams left to fill in.
//
// This is the one function functions/src/index.ts calls (via the esbuild-bundled artifact —
// see functions/scripts/bundle.mjs and functions/src/generated/syncBundle.d.ts) — that Cloud
// Function has no other reason to import shared/services at all. Splitting this out of
// httpHandler.ts keeps that file's own tests dependency-free (no real Firestore, no real
// bucket) while giving the real deploy path a single, obvious entry point.
//
// B2–B8 registering their real task handlers means extending `createDefaultRegistry()`
// (registry.ts) — this file does not hardcode SYNC_NOOP specifically, it just uses whatever
// the default registry currently contains.

import { getDb } from "@shared/firestore/index.ts";
import { createDefaultRawArchiveStore } from "./archiver.ts";
import { createDefaultRegistry } from "./registry.ts";
import { createFirestoreSyncStore } from "./store.ts";
import {
  handleTaskRequest,
  type TaskDispatchRequestBody,
  type TaskDispatchResponse,
} from "./httpHandler.ts";

let cachedDeps:
  | {
      syncStore: ReturnType<typeof createFirestoreSyncStore>;
      registry: ReturnType<typeof createDefaultRegistry>;
      archiver: ReturnType<typeof createDefaultRawArchiveStore>;
    }
  | undefined;

function getRuntimeDeps() {
  if (!cachedDeps) {
    cachedDeps = {
      syncStore: createFirestoreSyncStore(getDb()),
      registry: createDefaultRegistry(),
      archiver: createDefaultRawArchiveStore(),
    };
  }
  return cachedDeps;
}

/** The real Cloud Tasks dispatch entry point. See module comment. */
export async function handleSyncTaskDispatch(
  request: TaskDispatchRequestBody,
): Promise<TaskDispatchResponse> {
  return handleTaskRequest(request, getRuntimeDeps());
}
