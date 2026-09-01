// Real Firestore-backed `SyncRunSource` (pointInTimeArchive.ts) — a thin read of every
// `syncRuns` doc (B1, §10.2), full collection scan, no new composite index. Kept separate from
// pointInTimeArchive.ts itself so that file's own tests can inject a hand-rolled fake with no
// Firestore dependency at all (mirrors this codebase's own "structural interface + one real
// implementation" pattern — A2's VersionGuardFirestoreLike, A4's SecretManagerClientLike, B1's
// StorageBucketLike).

import { COLLECTIONS } from "@shared/firestore/index.ts";
import { syncRunSchema } from "@shared/schema/index.ts";
import type { SyncRunKnowledge, SyncRunSource } from "./pointInTimeArchive.ts";

/** Structural slice of `Firestore` this file actually calls — a real `Firestore` instance
 * satisfies it automatically. */
export interface SyncRunSourceFirestoreLike {
  collection(path: string): {
    get(): Promise<{ docs: { data(): unknown }[] }>;
  };
}

export function createFirestoreSyncRunSource(db: SyncRunSourceFirestoreLike): SyncRunSource {
  return {
    async listAllSyncRuns(): Promise<SyncRunKnowledge[]> {
      const snap = await db.collection(COLLECTIONS.syncRuns).get();
      const runs: SyncRunKnowledge[] = [];
      for (const doc of snap.docs) {
        const parsed = syncRunSchema.safeParse(doc.data());
        if (!parsed.success) continue; // a malformed/legacy doc teaches this reader nothing
        const run = parsed.data;
        runs.push({
          runId: run.runId,
          status: run.status,
          finishedAt: run.finishedAt,
        });
      }
      return runs;
    },
  };
}
