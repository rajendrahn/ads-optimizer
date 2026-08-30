// A thin get/set wrapper for metaInsightsReportJobs/{reportRunId} — mirrors
// services/ingest/sync/store.ts's own shape (a narrow structural interface, a real-Firestore
// implementation, and an in-memory fake for tests with no emulator). Wholesale overwrite, not
// version-guarded — see shared/schema/meta.ts's module comment on metaInsightsReportJobSchema.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { metaInsightsReportJobSchema, type MetaInsightsReportJob } from "@shared/schema/index.ts";

export interface ReportJobStore {
  get(reportRunId: string): Promise<MetaInsightsReportJob | null>;
  set(reportRunId: string, doc: MetaInsightsReportJob): Promise<void>;
}

export function createFirestoreReportJobStore(db: Firestore): ReportJobStore {
  const repo = createRepository<MetaInsightsReportJob>(
    db,
    COLLECTIONS.metaInsightsReportJobs,
    metaInsightsReportJobSchema,
  );
  return {
    get: (reportRunId) => repo.get(reportRunId),
    set: (reportRunId, doc) => repo.set(reportRunId, doc),
  };
}

export function createInMemoryReportJobStore(): ReportJobStore {
  const jobs = new Map<string, MetaInsightsReportJob>();
  return {
    async get(reportRunId) {
      return jobs.get(reportRunId) ?? null;
    },
    async set(reportRunId, doc) {
      jobs.set(reportRunId, doc);
    },
  };
}
