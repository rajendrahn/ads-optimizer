// Emulator-backed proof of META_POLL_ASYNC_REPORT's state machine (§7.1, §10.2): pending ->
// retryable throw, ready -> pages and writes rows, resumable across a bounded/truncated
// invocation, idempotent once DONE, and the watermark only advances on the invocation that
// actually finishes paging. Every Meta call is mocked; every Firestore call is real, against the
// emulator.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository, syncStateKey } from "@shared/firestore/index.ts";
import {
  metaInsightsDailySchema,
  metaInsightsReportJobSchema,
  type MetaInsightsDaily,
  type MetaInsightsReportJob,
} from "@shared/schema/index.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { createTaskRegistry } from "../../sync/registry.ts";
import { runSyncTask } from "../../sync/taskWrapper.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { ApiError } from "../../http/errors.ts";
import { MetaClient } from "../client.ts";
import { metaPollAsyncReportHandler, metaPollAsyncReportRegistration } from "./pollAsyncReport.ts";
import {
  buildImmediatelyReadyFetchImpl,
  buildInsightsRows,
  buildMultiPageFetchImpl,
  buildPendingFetchImpl,
} from "./testFixtures.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "pollAsyncReport.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.metaInsightsReportJobs,
    COLLECTIONS.metaInsightsDaily,
    COLLECTIONS.syncState,
    COLLECTIONS.syncRuns,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(cleanupCollections);
afterAll(cleanupCollections);

const jobsRepo = createRepository(
  db,
  COLLECTIONS.metaInsightsReportJobs,
  metaInsightsReportJobSchema,
);
const insightsRepo = createRepository(db, COLLECTIONS.metaInsightsDaily, metaInsightsDailySchema);

function baseJob(overrides: Partial<MetaInsightsReportJob> = {}): MetaInsightsReportJob {
  const now = new Date();
  return {
    reportRunId: "rr_1",
    reason: "reconciliation_incremental",
    since: "2026-08-15",
    until: "2026-08-15",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    phase: "SUBMITTED",
    pageCursor: null,
    rowsWritten: 0,
    pollAttempts: 0,
    submittedByRunId: "submit_run_1",
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeCtx(runId: string, client: MetaClient, payload: unknown) {
  return {
    runId,
    taskType: "META_POLL_ASYNC_REPORT",
    payload,
    archiver: dummyArchiver,
    getMetaClient: async () => client,
    getShopifyClient: async () => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

function noopSleepClient(fetchImpl: ReturnType<typeof vi.fn>): MetaClient {
  return new MetaClient({
    accessToken: "tok",
    fetchImpl,
    sleepImpl: vi.fn().mockResolvedValue(undefined),
  });
}

describe("metaPollAsyncReportHandler", () => {
  it("throws a terminal error when payload.reportRunId is missing", async () => {
    const client = noopSleepClient(vi.fn());
    await expect(metaPollAsyncReportHandler(makeCtx("r1", client, {}))).rejects.toMatchObject({
      kind: "client_error",
      retryable: false,
    });
  });

  it("throws a terminal error when no such job exists", async () => {
    const client = noopSleepClient(vi.fn());
    await expect(
      metaPollAsyncReportHandler(makeCtx("r1", client, { reportRunId: "does_not_exist" })),
    ).rejects.toMatchObject({ kind: "client_error", retryable: false });
  });

  it("job still pending: throws a RETRYABLE error (a plain Error, not a terminal ApiError — classifyTaskError in taskWrapper.ts defaults these retryable) and advances phase to POLLING with pollAttempts incremented", async () => {
    await jobsRepo.set("rr_1", baseJob());
    const client = noopSleepClient(buildPendingFetchImpl("rr_1"));

    let caught: unknown;
    try {
      await metaPollAsyncReportHandler(makeCtx("r1", client, { reportRunId: "rr_1" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ApiError);
    expect((caught as Error).message).toMatch(/not ready yet/);

    const job = (await jobsRepo.get("rr_1")) as MetaInsightsReportJob;
    expect(job.phase).toBe("POLLING");
    expect(job.pollAttempts).toBe(1);
  });

  it("job ready with a single complete page: pages, upserts rows, and marks DONE in one invocation", async () => {
    const rows = buildInsightsRows(["ad_1", "ad_2", "ad_3"], "2026-08-15");
    await jobsRepo.set(
      "rr_1",
      baseJob({
        attribution: { attributionWindow: "28d_click", purchaseActionType: "custom_purchase" },
      }),
    );
    const client = noopSleepClient(buildImmediatelyReadyFetchImpl("rr_1", rows));

    const result = await metaPollAsyncReportHandler(makeCtx("r1", client, { reportRunId: "rr_1" }));

    expect(result.newRowCount).toBe(3);
    expect(result.newWatermarkDate).toBe("2026-08-15");

    const job = (await jobsRepo.get("rr_1")) as MetaInsightsReportJob;
    expect(job.phase).toBe("DONE");
    expect(job.rowsWritten).toBe(3);
    expect(job.pageCursor).toBeNull();

    const doc = (await insightsRepo.get(`ad_1_2026-08-15`)) as MetaInsightsDaily;
    expect(doc.adId).toBe("ad_1");
    expect(doc.date).toBe("2026-08-15");
    // Attribution provenance comes from the JOB's pinned value, not the live canon (there is no
    // settings/{accountId} doc seeded in this test at all — proving it's never consulted here).
    expect(doc.attribution).toEqual({
      attributionWindow: "28d_click",
      purchaseActionType: "custom_purchase",
    });
    expect(doc.currency).toBe("INR");
    expect(doc.landingPageViews).toBe(3);
    expect(doc.addToCart).toBe(1);
    expect(doc.initiateCheckout).toBe(1);
  });

  it("resumable paging: a bounded invocation saves its cursor and a second invocation resumes and completes", async () => {
    const page0 = buildInsightsRows(["ad_1", "ad_2"], "2026-08-15");
    const page1 = buildInsightsRows(["ad_3", "ad_4"], "2026-08-15");
    await jobsRepo.set("rr_1", baseJob({ phase: "PAGING" })); // already past the poll step
    const client = noopSleepClient(buildMultiPageFetchImpl("rr_1", [page0, page1]));

    // First invocation: capped at 1 page per invocation, so it must NOT finish. Retryable
    // (a plain Error, not a terminal ApiError) — see the "job still pending" test above.
    let caught: unknown;
    try {
      await metaPollAsyncReportHandler(
        makeCtx("r1", client, { reportRunId: "rr_1", maxPagesPerInvocation: 1 }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ApiError);
    expect((caught as Error).message).toMatch(/more pages remaining/);

    let job = (await jobsRepo.get("rr_1")) as MetaInsightsReportJob;
    expect(job.phase).toBe("PAGING");
    expect(job.pageCursor).toBe("1");
    expect(job.rowsWritten).toBe(2);
    expect(await insightsRepo.get("ad_1_2026-08-15")).not.toBeNull();
    expect(await insightsRepo.get("ad_3_2026-08-15")).toBeNull(); // page 2 not processed yet

    // Second invocation resumes from the saved cursor and finishes.
    const result = await metaPollAsyncReportHandler(
      makeCtx("r2", client, { reportRunId: "rr_1", maxPagesPerInvocation: 1 }),
    );
    expect(result.newRowCount).toBe(2); // only THIS invocation's rows
    job = (await jobsRepo.get("rr_1")) as MetaInsightsReportJob;
    expect(job.phase).toBe("DONE");
    expect(job.rowsWritten).toBe(4); // cumulative across both invocations
    expect(await insightsRepo.get("ad_3_2026-08-15")).not.toBeNull();
  });

  it("a job already DONE is an idempotent no-op on a redelivered/duplicate poll", async () => {
    await jobsRepo.set("rr_1", baseJob({ phase: "DONE", rowsWritten: 5 }));
    const client = noopSleepClient(vi.fn());

    const result = await metaPollAsyncReportHandler(makeCtx("r1", client, { reportRunId: "rr_1" }));
    expect(result.newRowCount).toBe(0);
  });

  it("a job already FAILED throws terminally and is never resumed", async () => {
    await jobsRepo.set("rr_1", baseJob({ phase: "FAILED", lastError: "Meta reported Job Failed" }));
    const client = noopSleepClient(vi.fn());

    await expect(
      metaPollAsyncReportHandler(makeCtx("r1", client, { reportRunId: "rr_1" })),
    ).rejects.toMatchObject({ retryable: false });
  });

  it("exceeding maxPollAttempts marks the job FAILED terminally", async () => {
    await jobsRepo.set("rr_1", baseJob({ pollAttempts: 2 }));
    const client = noopSleepClient(buildPendingFetchImpl("rr_1"));

    await expect(
      metaPollAsyncReportHandler(
        makeCtx("r1", client, { reportRunId: "rr_1", maxPollAttempts: 3 }),
      ),
    ).rejects.toMatchObject({ retryable: false });

    const job = (await jobsRepo.get("rr_1")) as MetaInsightsReportJob;
    expect(job.phase).toBe("FAILED");
  });

  it("through the real task framework: syncState/meta_insights only advances on the invocation that completes paging, and each retry reuses the same syncRuns doc", async () => {
    const page0 = buildInsightsRows(["ad_1"], "2026-08-15");
    const page1 = buildInsightsRows(["ad_2"], "2026-08-15");
    await jobsRepo.set("rr_1", baseJob({ phase: "PAGING" }));
    const client = noopSleepClient(buildMultiPageFetchImpl("rr_1", [page0, page1]));

    const registry = createTaskRegistry();
    registry.register(metaPollAsyncReportRegistration);
    const syncStore = createFirestoreSyncStore(db);

    // Redelivery of the SAME Cloud Tasks task id ("poll_task_1") twice, as would happen if the
    // first invocation's "more pages remain" throw triggered a retry.
    const first = await runSyncTask({
      syncStore,
      registry,
      taskType: "META_POLL_ASYNC_REPORT",
      payload: { reportRunId: "rr_1", maxPagesPerInvocation: 1 },
      archiver: dummyArchiver,
      taskId: "poll_task_1",
      createMetaClientImpl: async () => client,
    });
    expect(first.status).toBe("FAILED");
    expect(first.shouldRetry).toBe(true);

    const stateAfterFirst = await syncStore.getSyncState(syncStateKey("meta", "insights"));
    expect(stateAfterFirst).toBeNull(); // not touched by a failed run

    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "META_POLL_ASYNC_REPORT",
      payload: { reportRunId: "rr_1", maxPagesPerInvocation: 1 },
      archiver: dummyArchiver,
      taskId: "poll_task_1", // SAME task id — a real Cloud Tasks redelivery
      createMetaClientImpl: async () => client,
    });
    expect(second.status).toBe("SUCCEEDED");

    const stateAfterSecond = await syncStore.getSyncState(syncStateKey("meta", "insights"));
    expect(stateAfterSecond?.lastDataDate).toBe("2026-08-15");
    expect(stateAfterSecond?.status).toBe("healthy");

    // Both attempts landed on the SAME syncRuns doc (overwritten), not two separate docs.
    const runDocs = await db.collection(COLLECTIONS.syncRuns).listDocuments();
    expect(runDocs).toHaveLength(1);
    expect(runDocs[0]?.id).toBe("poll_task_1");
  });
});
