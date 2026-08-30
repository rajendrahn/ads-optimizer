import { describe, expect, it } from "vitest";
import { ApiError } from "../http/errors.ts";
import { createDefaultRegistry, createTaskRegistry } from "./registry.ts";
import { createInMemorySyncStore } from "./store.ts";
import { SYNC_NOOP } from "./taskTypes.ts";
import { handleTaskRequest } from "./httpHandler.ts";
import type { RawArchiveStore } from "./archiver.ts";

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

describe("handleTaskRequest — the Cloud Tasks HTTP target", () => {
  it("returns 200 with SUCCEEDED for the no-op task", async () => {
    const response = await handleTaskRequest(
      { taskType: SYNC_NOOP, payload: {}, taskId: "http-1" },
      {
        syncStore: createInMemorySyncStore(),
        registry: createDefaultRegistry(),
        archiver: dummyArchiver,
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("SUCCEEDED");
    expect(response.body.runId).toBe("http-1");
  });

  it("returns 200 (not 500) for a malformed body — retrying won't fix a bad request", async () => {
    const response = await handleTaskRequest(
      { taskType: "", payload: {} },
      {
        syncStore: createInMemorySyncStore(),
        registry: createDefaultRegistry(),
        archiver: dummyArchiver,
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("FAILED");
  });

  it("returns 500 when the handler fails retryably, so Cloud Tasks retries", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        throw new ApiError("rate limited", { kind: "rate_limited", retryable: true });
      },
    });
    const response = await handleTaskRequest(
      { taskType: "T", payload: {}, taskId: "http-2" },
      { syncStore: createInMemorySyncStore(), registry, archiver: dummyArchiver },
    );
    expect(response.status).toBe(500);
    expect(response.body.status).toBe("FAILED");
  });

  it("returns 200 when the handler fails terminally, so Cloud Tasks stops retrying", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        throw new ApiError("bad request", { kind: "client_error", retryable: false });
      },
    });
    const response = await handleTaskRequest(
      { taskType: "T", payload: {}, taskId: "http-3" },
      { syncStore: createInMemorySyncStore(), registry, archiver: dummyArchiver },
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("FAILED");
  });

  it("a duplicate delivery of an already-succeeded taskId is a 200 no-op", async () => {
    const syncStore = createInMemorySyncStore();
    const registry = createDefaultRegistry();
    const first = await handleTaskRequest(
      { taskType: SYNC_NOOP, payload: {}, taskId: "http-dup" },
      { syncStore, registry, archiver: dummyArchiver },
    );
    expect(first.body.status).toBe("SUCCEEDED");

    const second = await handleTaskRequest(
      { taskType: SYNC_NOOP, payload: {}, taskId: "http-dup" },
      { syncStore, registry, archiver: dummyArchiver },
    );
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("SKIPPED_ALREADY_SUCCEEDED");
  });
});
