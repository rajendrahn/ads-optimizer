// Emulator-backed coverage of B1's own "Done when" bar: "A no-op task can be enqueued,
// executed, retried on failure, and leaves correct syncRuns state." Everything here uses a
// real Firestore (the emulator) via createFirestoreSyncStore(getDb()) — no in-memory fake — to
// prove the real repository/schema wiring (shared/firestore, shared/schema) round-trips
// correctly, the way A2/A3's own *.emulator.test.ts files do.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@shared/firestore/index.ts";
import { createInMemoryTaskQueueClient } from "./taskQueue.ts";
import { createDefaultRegistry, createTaskRegistry } from "./registry.ts";
import { createFirestoreSyncStore } from "./store.ts";
import { SYNC_NOOP } from "./taskTypes.ts";
import { handleTaskRequest } from "./httpHandler.ts";
import type { RawArchiveStore } from "./archiver.ts";

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

describe("B1 done-when: enqueue -> execute -> retry -> syncRuns, against a real Firestore", () => {
  it("a no-op task enqueued via the in-memory queue executes and leaves SUCCEEDED syncRuns state", async () => {
    const db = getDb();
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    let dispatchPromise: ReturnType<typeof handleTaskRequest> | undefined;
    const queue = createInMemoryTaskQueueClient((enqueued) => {
      // Simulate what the real Cloud Tasks -> HTTP target round trip does: the queue's
      // configured target receives {taskType, payload, taskId} and calls handleTaskRequest.
      // Captured (not awaited here) so the test below awaits the real promise rather than
      // guessing how long a real Firestore round trip takes.
      dispatchPromise = handleTaskRequest(enqueued, {
        syncStore,
        registry,
        archiver: dummyArchiver,
      });
    });

    const taskId = `noop_${randomUUID()}`;
    await queue.enqueue({ taskType: SYNC_NOOP, payload: {}, taskId });
    const dispatchedResponse = await dispatchPromise;

    expect(dispatchedResponse?.status).toBe(200);
    expect(dispatchedResponse?.body.status).toBe("SUCCEEDED");

    const run = await syncStore.getSyncRun(taskId);
    expect(run).not.toBeNull();
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.taskType).toBe(SYNC_NOOP);
    expect(run?.source).toBe("internal");
    expect(run?.error).toBeNull();
    expect(run?.startedAt).toBeInstanceOf(Date);
    expect(run?.finishedAt).toBeInstanceOf(Date);

    // SYNC_NOOP has no syncStateTarget — confirm no syncState document was created for it.
    const state = await syncStore.getSyncState("internal_noop");
    expect(state).toBeNull();
  });

  it("a failing task is retried and the retry succeeds, ending with correct syncRuns state", async () => {
    const db = getDb();
    const syncStore = createFirestoreSyncStore(db);
    const registry = createTaskRegistry();
    const taskId = `flaky_${randomUUID()}`;
    let attempt = 0;
    registry.register({
      taskType: "FLAKY",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient failure on first attempt");
        return { newRowCount: 3 };
      },
    });

    const firstResponse = await handleTaskRequest(
      { taskType: "FLAKY", payload: {}, taskId },
      { syncStore, registry, archiver: dummyArchiver },
    );
    expect(firstResponse.status).toBe(500); // retryable — Cloud Tasks would retry
    expect(firstResponse.body.status).toBe("FAILED");

    const afterFirst = await syncStore.getSyncRun(taskId);
    expect(afterFirst?.status).toBe("FAILED");
    expect(afterFirst?.error).toMatch(/transient failure/);

    // Cloud Tasks redelivers the same task (same taskId) on retry.
    const secondResponse = await handleTaskRequest(
      { taskType: "FLAKY", payload: {}, taskId },
      { syncStore, registry, archiver: dummyArchiver },
    );
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body.status).toBe("SUCCEEDED");

    const afterSecond = await syncStore.getSyncRun(taskId);
    expect(afterSecond?.status).toBe("SUCCEEDED");
    expect(afterSecond?.error).toBeNull();
    expect(attempt).toBe(2);
  });

  it("advances syncState.lastDataDate only on the run that succeeds, against real Firestore", async () => {
    const db = getDb();
    const syncStore = createFirestoreSyncStore(db);
    const registry = createTaskRegistry();
    const taskTypeA = "META_SYNC_INSIGHTS_TEST_A";
    const resource = `insights_test_${randomUUID()}`;
    registry.register({
      taskType: taskTypeA,
      runSource: "meta",
      syncStateTarget: { source: "meta", resource },
      handler: async () => {
        throw new Error("always fails");
      },
    });

    const stateKey = `meta_${resource}`;
    const response = await handleTaskRequest(
      { taskType: taskTypeA, payload: {}, taskId: `will-fail-${randomUUID()}` },
      { syncStore, registry, archiver: dummyArchiver },
    );
    expect(response.body.status).toBe("FAILED");
    const state = await syncStore.getSyncState(stateKey);
    expect(state).toBeNull(); // never created — failure never touches syncState
  });
});
