// Emulator-backed proof of META_SYNC_INSIGHTS: submits the async report job for the correct
// window (backfill vs. reconciliation) and writes the SUBMITTED job doc with attribution
// provenance. Every Meta call is mocked; every Firestore call is real, against the emulator.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GCP_PROJECT_ID, META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository, syncStateKey } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  metaInsightsReportJobSchema,
  syncStateSchema,
  type MetaInsightsReportJob,
} from "@shared/schema/index.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { MetaClient } from "../client.ts";
import { metaSyncInsightsHandler, metaSyncInsightsRegistration } from "./insightsSync.ts";
import { TEST_CANON } from "./testFixtures.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "insightsSync.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const archivedPayloads: unknown[] = [];
const dummyArchiver: RawArchiveStore = {
  archive: async (input) => {
    archivedPayloads.push(input);
    return { path: "unused" };
  },
  read: async () => undefined,
};

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.settings,
    COLLECTIONS.syncState,
    COLLECTIONS.metaInsightsReportJobs,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  archivedPayloads.length = 0;
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(TEST_CANON.accountId, TEST_CANON);
});

afterAll(async () => {
  await cleanupCollections();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function newClientWithSubmitFetch(reportRunId: string) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse({ report_run_id: reportRunId }),
  );
  return {
    client: new MetaClient({
      accessToken: "tok",
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    }),
    fetchImpl,
  };
}

function makeCtx(runId: string, client: MetaClient, payload: unknown = {}) {
  return {
    runId,
    taskType: "META_SYNC_INSIGHTS",
    payload,
    archiver: dummyArchiver,
    getMetaClient: async () => client,
    getShopifyClient: async () => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

describe("metaSyncInsightsHandler", () => {
  it("registration has no watermark of its own (syncStateTarget: null)", () => {
    expect(metaSyncInsightsRegistration.syncStateTarget).toBeNull();
  });

  it("backfill mode with explicit since/until submits exactly that window and writes a SUBMITTED job doc with attribution", async () => {
    const { client, fetchImpl } = newClientWithSubmitFetch("rr_backfill_1");

    const result = await metaSyncInsightsHandler(
      makeCtx("run_1", client, { mode: "backfill", since: "2026-01-01", until: "2026-01-31" }),
    );

    expect(result.summary).toMatchObject({
      reportRunId: "rr_backfill_1",
      since: "2026-01-01",
      until: "2026-01-31",
      reason: "backfill",
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(JSON.parse(body.get("time_range") as string)).toEqual({
      since: "2026-01-01",
      until: "2026-01-31",
    });
    expect(JSON.parse(body.get("action_attribution_windows") as string)).toEqual([
      "7d_click",
      "1d_view",
    ]);
    expect(body.get("level")).toBe("ad");

    const jobsRepo = createRepository(
      db,
      COLLECTIONS.metaInsightsReportJobs,
      metaInsightsReportJobSchema,
    );
    const job = (await jobsRepo.get("rr_backfill_1")) as MetaInsightsReportJob;
    expect(job.phase).toBe("SUBMITTED");
    expect(job.since).toBe("2026-01-01");
    expect(job.until).toBe("2026-01-31");
    expect(job.reason).toBe("backfill");
    expect(job.attribution).toEqual({
      attributionWindow: "7d_click_1d_view",
      purchaseActionType: "omni_purchase",
    });
    expect(job.rowsWritten).toBe(0);
    expect(job.submittedByRunId).toBe("run_1");

    expect(archivedPayloads).toHaveLength(1);
  });

  it("backfill mode with no since/until defaults to a 365-day window ending today", async () => {
    const { client } = newClientWithSubmitFetch("rr_backfill_default");

    const result = await metaSyncInsightsHandler(makeCtx("run_1", client, { mode: "backfill" }));

    const summary = result.summary as { since: string; until: string };
    const sinceDate = new Date(`${summary.since}T00:00:00Z`);
    const untilDate = new Date(`${summary.until}T00:00:00Z`);
    const daySpan = Math.round((untilDate.getTime() - sinceDate.getTime()) / 86_400_000) + 1;
    expect(daySpan).toBe(365);
  });

  it("reconciliation_incremental with an existing watermark computes the reconciliation window (not a full backfill)", async () => {
    const stateRepo = createRepository(db, COLLECTIONS.syncState, syncStateSchema);
    await stateRepo.set(syncStateKey("meta", "insights"), {
      source: "meta",
      resource: "insights",
      accountId: META_AD_ACCOUNT_ID,
      lastSuccessfulSyncAt: new Date(),
      lastDataDate: "2026-08-20",
      reconciliationDays: 14,
      attributionWindow: "7d_click_1d_view",
      status: "healthy",
      lastRunId: "prior_run",
      backfillCoverageThroughDate: null,
      knownGaps: null,
    });

    const { client } = newClientWithSubmitFetch("rr_recon_1");
    const result = await metaSyncInsightsHandler(
      makeCtx("run_2", client, { mode: "reconciliation_incremental", until: "2026-08-30" }),
    );

    // watermark 2026-08-20 + 1 day = 2026-08-21; rolling 14-day window from 2026-08-30 is
    // 2026-08-17 — the earlier (further back) of the two wins per computeReconciliationWindow.
    expect(result.summary).toMatchObject({
      since: "2026-08-17",
      until: "2026-08-30",
      reason: "reconciliation_incremental",
    });
  });

  it("reconciliation_incremental with no watermark throws rather than silently backfilling", async () => {
    const { client } = newClientWithSubmitFetch("rr_should_not_submit");
    await expect(
      metaSyncInsightsHandler(
        makeCtx("run_3", client, { mode: "reconciliation_incremental", until: "2026-08-30" }),
      ),
    ).rejects.toThrow(/no watermark|backfill/i);
  });

  it("reconciliation_deep uses the deep (60-day) window size", async () => {
    const stateRepo = createRepository(db, COLLECTIONS.syncState, syncStateSchema);
    await stateRepo.set(syncStateKey("meta", "insights"), {
      source: "meta",
      resource: "insights",
      accountId: META_AD_ACCOUNT_ID,
      lastSuccessfulSyncAt: new Date(),
      lastDataDate: "2026-08-29",
      reconciliationDays: 14,
      attributionWindow: "7d_click_1d_view",
      status: "healthy",
      lastRunId: "prior_run",
      backfillCoverageThroughDate: null,
      knownGaps: null,
    });

    const { client } = newClientWithSubmitFetch("rr_deep_1");
    const result = await metaSyncInsightsHandler(
      makeCtx("run_4", client, { mode: "reconciliation_deep", until: "2026-08-30" }),
    );

    expect(result.summary).toMatchObject({
      since: "2026-07-02",
      until: "2026-08-30",
      reason: "reconciliation_deep",
    });
  });
});
