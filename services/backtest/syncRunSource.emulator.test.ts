import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { syncRunSchema, type SyncRun } from "@shared/schema/index.ts";
import { createFirestoreSyncRunSource } from "./syncRunSource.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "syncRunSource.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

describe("createFirestoreSyncRunSource — real syncRuns collection", () => {
  it("reads back every real syncRuns doc with its status and finishedAt", async () => {
    const repo = createRepository(db, COLLECTIONS.syncRuns, syncRunSchema);
    const runs: SyncRun[] = [
      {
        runId: "e1-emu-run-1",
        taskType: "META_POLL_ASYNC_REPORT",
        source: "meta",
        status: "SUCCEEDED",
        startedAt: new Date("2026-08-01T10:00:00Z"),
        finishedAt: new Date("2026-08-01T10:05:00Z"),
        error: null,
        watermarkBefore: null,
        watermarkAfter: "2026-08-01",
        versionGuardRejections: null,
      },
      {
        runId: "e1-emu-run-2",
        taskType: "META_POLL_ASYNC_REPORT",
        source: "meta",
        status: "FAILED",
        startedAt: new Date("2026-08-01T11:00:00Z"),
        finishedAt: new Date("2026-08-01T11:05:00Z"),
        error: "boom",
        watermarkBefore: null,
        watermarkAfter: null,
        versionGuardRejections: null,
      },
    ];
    for (const run of runs) await repo.set(run.runId, run);

    const source = createFirestoreSyncRunSource(db);
    const all = await source.listAllSyncRuns();
    const byId = new Map(all.map((r) => [r.runId, r]));

    expect(byId.get("e1-emu-run-1")).toEqual({
      runId: "e1-emu-run-1",
      status: "SUCCEEDED",
      finishedAt: new Date("2026-08-01T10:05:00Z"),
    });
    expect(byId.get("e1-emu-run-2")?.status).toBe("FAILED");
  });
});
