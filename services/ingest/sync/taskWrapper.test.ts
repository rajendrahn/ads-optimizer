import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../http/errors.ts";
import type { MetaClient } from "../meta/client.ts";
import type { ShopifyClient } from "../shopify/client.ts";
import { createTaskRegistry } from "./registry.ts";
import { createInMemorySyncStore } from "./store.ts";
import { runSyncTask, type TaskHandler } from "./taskWrapper.ts";
import type { RawArchiveStore } from "./archiver.ts";

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

function fixedClock(iso: string) {
  let ms = new Date(iso).getTime();
  return () => new Date(ms++); // strictly increasing, so startedAt !== finishedAt in assertions
}

describe("runSyncTask — internal task with no syncStateTarget (SYNC_NOOP-shaped)", () => {
  it("records a RUNNING-then-SUCCEEDED syncRuns doc and never touches syncState", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => ({ newRowCount: 1, summary: { ok: true } }),
    });
    const syncStore = createInMemorySyncStore();

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-1",
      now: fixedClock("2026-08-30T00:00:00Z"),
    });

    expect(result).toEqual({
      runId: "run-1",
      status: "SUCCEEDED",
      shouldRetry: false,
      summary: { ok: true },
    });

    const run = await syncStore.getSyncRun("run-1");
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.source).toBe("internal");
    expect(run?.error).toBeNull();
    expect(run?.watermarkBefore).toBeNull();
    expect(run?.watermarkAfter).toBeNull();
    expect(run?.finishedAt).not.toBeNull();
  });
});

describe("runSyncTask — task with a syncStateTarget", () => {
  function registryWithMetaInsights(handler: TaskHandler) {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "META_SYNC_INSIGHTS",
      runSource: "meta",
      syncStateTarget: { source: "meta", resource: "insights" },
      handler,
    });
    return registry;
  }

  it("advances the watermark and writes syncState only on success", async () => {
    const registry = registryWithMetaInsights(async () => ({
      newWatermarkDate: "2026-08-30",
      newRowCount: 5,
    }));
    const syncStore = createInMemorySyncStore();

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "META_SYNC_INSIGHTS",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-2",
      now: fixedClock("2026-08-30T00:00:00Z"),
    });

    expect(result.status).toBe("SUCCEEDED");
    const state = await syncStore.getSyncState("meta_insights");
    expect(state).toMatchObject({
      source: "meta",
      resource: "insights",
      lastDataDate: "2026-08-30",
      status: "healthy",
      lastRunId: "run-2",
    });
    expect(state?.lastSuccessfulSyncAt).toBeInstanceOf(Date);

    const run = await syncStore.getSyncRun("run-2");
    expect(run?.watermarkBefore).toBeNull();
    expect(run?.watermarkAfter).toBe("2026-08-30");
  });

  it("does NOT advance the watermark or touch syncState when the handler throws", async () => {
    const registry = registryWithMetaInsights(async () => {
      throw new Error("boom");
    });
    const syncStore = createInMemorySyncStore();
    // Seed a prior successful state so we can prove it's untouched afterward.
    await syncStore.setSyncState("meta_insights", {
      source: "meta",
      resource: "insights",
      accountId: "act_1",
      lastSuccessfulSyncAt: new Date("2026-08-29T00:00:00Z"),
      lastDataDate: "2026-08-29",
      reconciliationDays: 14,
      attributionWindow: "7d_click_1d_view",
      status: "healthy",
      lastRunId: "prior-run",
    });

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "META_SYNC_INSIGHTS",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-3",
      now: fixedClock("2026-08-30T00:00:00Z"),
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toBe("boom");

    const state = await syncStore.getSyncState("meta_insights");
    expect(state?.lastDataDate).toBe("2026-08-29"); // unchanged
    expect(state?.lastRunId).toBe("prior-run"); // unchanged

    const run = await syncStore.getSyncRun("run-3");
    expect(run?.status).toBe("FAILED");
    expect(run?.watermarkBefore).toBe("2026-08-29"); // read from prior state
    expect(run?.watermarkAfter).toBeNull();
  });

  it("classifySyncStatus reports no_new_data when the handler reports zero rows", async () => {
    const registry = registryWithMetaInsights(async () => ({
      newWatermarkDate: "2026-08-30",
      newRowCount: 0,
    }));
    const syncStore = createInMemorySyncStore();
    await runSyncTask({
      syncStore,
      registry,
      taskType: "META_SYNC_INSIGHTS",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-4",
      now: fixedClock("2026-08-30T00:00:00Z"),
    });
    const state = await syncStore.getSyncState("meta_insights");
    expect(state?.status).toBe("no_new_data");
  });
});

describe("runSyncTask — retry semantics", () => {
  it("shouldRetry is true when the handler throws a retryable ApiError", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        throw new ApiError("rate limited", { kind: "rate_limited", retryable: true });
      },
    });
    const result = await runSyncTask({
      syncStore: createInMemorySyncStore(),
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
    });
    expect(result.status).toBe("FAILED");
    expect(result.shouldRetry).toBe(true);
  });

  it("shouldRetry is false when the handler throws a terminal ApiError", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        throw new ApiError("bad token", { kind: "unauthorized", retryable: false });
      },
    });
    const result = await runSyncTask({
      syncStore: createInMemorySyncStore(),
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
    });
    expect(result.shouldRetry).toBe(false);
  });

  it("a plain (non-ApiError) throw defaults to retryable, matching http/retry.ts's convention", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        throw new TypeError("network blew up");
      },
    });
    const result = await runSyncTask({
      syncStore: createInMemorySyncStore(),
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
    });
    expect(result.shouldRetry).toBe(true);
  });

  it("an unknown task type is a terminal failure (no point retrying)", async () => {
    const result = await runSyncTask({
      syncStore: createInMemorySyncStore(),
      registry: createTaskRegistry(),
      taskType: "DOES_NOT_EXIST",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-5",
    });
    expect(result.status).toBe("FAILED");
    expect(result.shouldRetry).toBe(false);
    expect(result.error).toMatch(/no handler registered/);
  });
});

describe("runSyncTask — idempotency", () => {
  it("a taskId already SUCCEEDED short-circuits without re-running the handler", async () => {
    const handler = vi.fn(async () => ({ newRowCount: 1 }));
    const registry = createTaskRegistry();
    registry.register({ taskType: "T", runSource: "internal", syncStateTarget: null, handler });
    const syncStore = createInMemorySyncStore();

    const first = await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "dup-1",
    });
    expect(first.status).toBe("SUCCEEDED");
    expect(handler).toHaveBeenCalledTimes(1);

    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "dup-1",
    });
    expect(second).toEqual({
      runId: "dup-1",
      status: "SKIPPED_ALREADY_SUCCEEDED",
      shouldRetry: false,
    });
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });

  it("a taskId that previously FAILED is re-attempted", async () => {
    let attempt = 0;
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("first attempt fails");
        return { newRowCount: 1 };
      },
    });
    const syncStore = createInMemorySyncStore();

    const first = await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "retry-1",
    });
    expect(first.status).toBe("FAILED");

    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "retry-1",
    });
    expect(second.status).toBe("SUCCEEDED");
    expect(attempt).toBe(2);
  });
});

describe("runSyncTask — Meta/Shopify client construction (A4 orchestrator note)", () => {
  it("constructs the Meta client at most once per run even if the handler asks for it twice", async () => {
    let constructions = 0;
    const fakeMetaClient = {} as MetaClient;
    const createMetaClientImpl = vi.fn(async () => {
      constructions += 1;
      return fakeMetaClient;
    });

    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async (ctx) => {
        const a = await ctx.getMetaClient();
        const b = await ctx.getMetaClient();
        expect(a).toBe(b);
        expect(a).toBe(fakeMetaClient);
        return {};
      },
    });

    const result = await runSyncTask({
      syncStore: createInMemorySyncStore(),
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      createMetaClientImpl,
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(constructions).toBe(1);
  });

  it("never constructs a client the handler never asks for", async () => {
    const createMetaClientImpl = vi.fn(async () => ({}) as MetaClient);
    const createShopifyClientImpl = vi.fn(async () => ({}) as ShopifyClient);
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async () => ({}),
    });

    await runSyncTask({
      syncStore: createInMemorySyncStore(),
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      createMetaClientImpl,
      createShopifyClientImpl,
    });

    expect(createMetaClientImpl).not.toHaveBeenCalled();
    expect(createShopifyClientImpl).not.toHaveBeenCalled();
  });
});

describe("runSyncTask — version-guard rejection logging (A2 orchestrator note)", () => {
  it("wires ctx.recordVersionGuardRejection into syncRuns.versionGuardRejections", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async (ctx) => {
        ctx.recordVersionGuardRejection({
          collection: "shopifyOrders",
          docId: "order_1",
          reason: "incoming older than stored",
          incomingUpdatedAt: new Date("2026-08-29T00:00:00Z"),
          currentUpdatedAt: new Date("2026-08-30T00:00:00Z"),
        });
        return {};
      },
    });
    const syncStore = createInMemorySyncStore();

    await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-vg",
    });

    const run = await syncStore.getSyncRun("run-vg");
    expect(run?.versionGuardRejections).toHaveLength(1);
    expect(run?.versionGuardRejections?.[0]).toMatchObject({
      collection: "shopifyOrders",
      docId: "order_1",
    });
    expect(run?.versionGuardRejections?.[0].loggedAt).toBeInstanceOf(Date);
  });

  it("records rejections even on a run that ultimately fails", async () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "T",
      runSource: "internal",
      syncStateTarget: null,
      handler: async (ctx) => {
        ctx.recordVersionGuardRejection({
          collection: "shopifyOrders",
          docId: "order_2",
          reason: "older",
          incomingUpdatedAt: new Date("2026-08-29T00:00:00Z"),
          currentUpdatedAt: new Date("2026-08-30T00:00:00Z"),
        });
        throw new Error("fails after the rejection");
      },
    });
    const syncStore = createInMemorySyncStore();

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "T",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run-vg-2",
    });

    expect(result.status).toBe("FAILED");
    const run = await syncStore.getSyncRun("run-vg-2");
    expect(run?.versionGuardRejections).toHaveLength(1);
  });
});
