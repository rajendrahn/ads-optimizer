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
  /** Every job not in a terminal phase (DONE/FAILED) - what a scheduled sweep advances. See
   * pollAsyncReport.ts's sweep-mode comment for why sweeping rather than chaining. */
  listInFlight(): Promise<MetaInsightsReportJob[]>;
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
    async listInFlight() {
      // Filtered client-side on `phase` rather than with a `where` clause: this collection holds
      // one document per report submission (a handful per day at most), so a full read is
      // cheaper than the composite index a query would need, and it cannot silently miss a job
      // because an index has not finished building.
      const all = await repo.query((c) => c);
      return all.filter((j) => j.phase !== "DONE" && j.phase !== "FAILED");
    },
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
    async listInFlight() {
      return [...jobs.values()].filter((j) => j.phase !== "DONE" && j.phase !== "FAILED");
    },
  };
}
