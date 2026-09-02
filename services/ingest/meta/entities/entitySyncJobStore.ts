// A thin get/set wrapper for metaEntitySyncJobs/{runId} — mirrors
// services/ingest/meta/insights/reportJobStore.ts's own shape exactly (a narrow structural
// interface, a real-Firestore implementation, and an in-memory fake for tests with no
// emulator). Wholesale overwrite, not version-guarded — see shared/schema/meta.ts's module
// comment on metaEntitySyncJobSchema.

import { ZodError } from "zod";
import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { metaEntitySyncJobSchema, type MetaEntitySyncJob } from "@shared/schema/index.ts";

export interface EntitySyncJobStore {
  get(runId: string): Promise<MetaEntitySyncJob | null>;
  set(runId: string, doc: MetaEntitySyncJob): Promise<void>;
}

/** Thrown when `metaEntitySyncJobs/{runId}` exists but fails to parse against the CURRENT
 * `metaEntitySyncJobSchema` — in practice, this session's creative-narrowing fix, which
 * reordered the phase machine (CREATIVES now runs after ADS, not before CAMPAIGNS) and added
 * several required fields (`referencedCreativeIds`, `pendingAds`, `creativesResolveIndex`,
 * `adsResolveIndex`, `campaignsResolveIndex`) a pre-fix job doc simply doesn't have. Reading
 * such a doc through the NEW schema and pressing on regardless would silently misinterpret its
 * `phase` field under a meaning it was never written with (e.g. a pre-fix doc's `phase:
 * "CREATIVES"` means "page every creative on the account"; the new code's `CREATIVES` means
 * "resolve this run's already-known referenced ids") — worse than refusing outright. Callers
 * should treat this as terminal (not retryable): the same runId will fail identically forever;
 * the fix is a NEW sync run (new runId), not a retry of this one. See shared/schema/meta.ts's
 * module comment on `metaEntitySyncJobSchema` for the full design rationale. */
export class StaleMetaEntitySyncJobError extends Error {
  constructor(runId: string, cause: unknown) {
    super(
      `metaEntitySyncJobs/${runId} was written under the pre-creative-narrowing-fix schema ` +
        `and phase order (CREATIVES first, full-account fetch) and cannot be safely resumed by ` +
        `this code — reinterpreting its saved phase under the new meaning would silently do the ` +
        `wrong thing. Start a fresh sync with a new runId. See shared/schema/meta.ts's module ` +
        `comment on metaEntitySyncJobSchema for why.`,
    );
    this.name = "StaleMetaEntitySyncJobError";
    this.cause = cause;
  }
}

export function createFirestoreEntitySyncJobStore(db: Firestore): EntitySyncJobStore {
  const repo = createRepository<MetaEntitySyncJob>(
    db,
    COLLECTIONS.metaEntitySyncJobs,
    metaEntitySyncJobSchema,
  );
  return {
    async get(runId) {
      try {
        return await repo.get(runId);
      } catch (err) {
        // repo.get() runs the stored document through metaEntitySyncJobSchema.parse() on the
        // way out (shared/firestore/repository.ts's `fromFirestore`) — a ZodError here means a
        // doc exists but predates this session's schema change. Any other error (Firestore
        // itself failing) propagates unchanged, retryable by taskWrapper's default.
        if (err instanceof ZodError) throw new StaleMetaEntitySyncJobError(runId, err);
        throw err;
      }
    },
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
