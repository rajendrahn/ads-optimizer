// A thin get/set wrapper for metaEntitySyncJobs/{runId} — mirrors
// services/ingest/meta/insights/reportJobStore.ts's own shape exactly (a narrow structural
// interface, a real-Firestore implementation, and an in-memory fake for tests with no
// emulator). Wholesale overwrite, not version-guarded — see shared/schema/meta.ts's module
// comment on metaEntitySyncJobSchema.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { metaEntitySyncJobSchema, type MetaEntitySyncJob } from "@shared/schema/index.ts";

export interface EntitySyncJobStore {
  get(runId: string): Promise<MetaEntitySyncJob | null>;
  set(runId: string, doc: MetaEntitySyncJob): Promise<void>;
}

export function createFirestoreEntitySyncJobStore(db: Firestore): EntitySyncJobStore {
  const repo = createRepository<MetaEntitySyncJob>(
    db,
    COLLECTIONS.metaEntitySyncJobs,
    metaEntitySyncJobSchema,
  );
  return {
    get: (runId) => repo.get(runId),
    set: (runId, doc) => repo.set(runId, doc),
  };
}

export function createInMemoryEntitySyncJobStore(): EntitySyncJobStore {
  const jobs = new Map<string, MetaEntitySyncJob>();
  return {
    async get(runId) {
      return jobs.get(runId) ?? null;
    },
    async set(runId, doc) {
      jobs.set(runId, doc);
    },
  };
}
