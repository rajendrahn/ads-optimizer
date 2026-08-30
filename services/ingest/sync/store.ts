// The task wrapper's own bookkeeping store — get/set for exactly the two documents it owns,
// `syncState/{source}_{resource}` and `syncRuns/{runId}` (shared/schema/sync.ts, A2).
//
// A narrow structural interface, not A2's `Repository<T>` directly — same reasoning as
// versionGuard's `VersionGuardFirestoreLike` and A4's `SecretManagerClientLike`: it lets
// taskWrapper.ts's own logic (idempotency, the success/failure branches, watermark handling)
// be unit-tested against a hand-rolled in-memory fake, with no emulator, no real `Firestore`
// value anywhere in that test file. `createFirestoreSyncStore` is the real implementation,
// built on `createRepository` (shared/firestore/repository.ts) — a real `Firestore` instance
// satisfies it automatically, no adapter needed at the call site; it's what
// `taskWrapper.emulator.test.ts` and (later) B2–B8's real callers use.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  syncRunSchema,
  syncStateSchema,
  type SyncRun,
  type SyncState,
} from "@shared/schema/index.ts";

export interface SyncStore {
  getSyncRun(runId: string): Promise<SyncRun | null>;
  setSyncRun(runId: string, doc: SyncRun): Promise<void>;
  getSyncState(key: string): Promise<SyncState | null>;
  setSyncState(key: string, doc: SyncState): Promise<void>;
}

/** The real implementation — pass a live `Firestore` (e.g. `getDb()`). */
export function createFirestoreSyncStore(db: Firestore): SyncStore {
  const syncRuns = createRepository<SyncRun>(db, COLLECTIONS.syncRuns, syncRunSchema);
  const syncState = createRepository<SyncState>(db, COLLECTIONS.syncState, syncStateSchema);
  return {
    getSyncRun: (runId) => syncRuns.get(runId),
    setSyncRun: (runId, doc) => syncRuns.set(runId, doc),
    getSyncState: (key) => syncState.get(key),
    setSyncState: (key, doc) => syncState.set(key, doc),
  };
}

/** Test-only in-memory implementation — no Firestore, no emulator. */
export function createInMemorySyncStore(): SyncStore {
  const runs = new Map<string, SyncRun>();
  const states = new Map<string, SyncState>();
  return {
    async getSyncRun(runId) {
      return runs.get(runId) ?? null;
    },
    async setSyncRun(runId, doc) {
      runs.set(runId, doc);
    },
    async getSyncState(key) {
      return states.get(key) ?? null;
    },
    async setSyncState(key, doc) {
      states.set(key, doc);
    },
  };
}
