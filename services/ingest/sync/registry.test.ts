import { describe, expect, it } from "vitest";
import { createDefaultRegistry, createTaskRegistry } from "./registry.ts";
import { SYNC_NOOP } from "./taskTypes.ts";

describe("createTaskRegistry", () => {
  it("registers and retrieves a handler by task type", () => {
    const registry = createTaskRegistry();
    const handler = async () => ({});
    registry.register({ taskType: "X", handler, runSource: "internal", syncStateTarget: null });
    expect(registry.get("X")?.handler).toBe(handler);
    expect(registry.list()).toEqual(["X"]);
  });

  it("returns undefined for an unregistered task type", () => {
    const registry = createTaskRegistry();
    expect(registry.get("NOPE")).toBeUndefined();
  });

  it("rejects registering the same task type twice", () => {
    const registry = createTaskRegistry();
    registry.register({
      taskType: "X",
      handler: async () => ({}),
      runSource: "internal",
      syncStateTarget: null,
    });
    expect(() =>
      registry.register({
        taskType: "X",
        handler: async () => ({}),
        runSource: "internal",
        syncStateTarget: null,
      }),
    ).toThrow(/already registered/);
  });
});

describe("createDefaultRegistry", () => {
  it("registers SYNC_NOOP plus B2's, B3's, B5's, B6's, B7's, B8's, C1's, C5's, C2's, C4's, C3's and D2's real task types", () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toEqual([
      SYNC_NOOP,
      "META_SYNC_ENTITIES",
      "META_SNAPSHOT_CONFIG",
      "META_SYNC_INSIGHTS",
      "META_POLL_ASYNC_REPORT",
      "SHOPIFY_IMPORT_ORDERS_CSV",
      "SHOPIFY_SYNC_ORDERS",
      "META_SYNC_CREATIVE_IDENTITY",
      "SHOPIFY_PROCESS_WEBHOOK",
      "AUDIT_AD_URL_TAGS",
      "SHOPIFY_RESOLVE_ATTRIBUTION",
      "NORMALIZE_META_INSIGHTS_DAILY",
      "NORMALIZE_SHOPIFY_DAILY",
      // C5's calendar/seasonality seed task.
      "SEED_SEASONAL_CALENDAR",
      // C2's own — the feature engine's full recompute (§10.1, §10.2).
      "RECOMPUTE_FEATURES",
      // C4's own — change-aware/learning-phase enrichment (§13, §13.1), run after
      // RECOMPUTE_FEATURES.
      "ENRICH_CHANGE_FEATURES",
      // C3's own — the statistics layer (§15): intervals/verdicts/shrinkage, also run after
      // RECOMPUTE_FEATURES, alongside C4's enrichment pass.
      "COMPUTE_STATISTICS",
      // D2's own — §10.1's "mark all decision packets stale" step, run after RECOMPUTE_FEATURES.
      "MARK_DECISION_PACKETS_STALE",
    ]);
  });

  it("SYNC_NOOP reports newRowCount:1 by default (healthy)", async () => {
    const registry = createDefaultRegistry();
    const registration = registry.get(SYNC_NOOP);
    if (!registration) throw new Error("SYNC_NOOP must be registered");
    const result = await registration.handler({
      runId: "r1",
      taskType: SYNC_NOOP,
      payload: {},
      archiver: {} as never,
      getMetaClient: async () => {
        throw new Error("should not be called");
      },
      getShopifyClient: async () => {
        throw new Error("should not be called");
      },
      recordVersionGuardRejection: () => undefined,
    });
    expect(result.newRowCount).toBe(1);
  });

  it("SYNC_NOOP reports newRowCount:0 when payload requests it", async () => {
    const registry = createDefaultRegistry();
    const registration = registry.get(SYNC_NOOP);
    if (!registration) throw new Error("SYNC_NOOP must be registered");
    const result = await registration.handler({
      runId: "r1",
      taskType: SYNC_NOOP,
      payload: { simulateNoNewData: true },
      archiver: {} as never,
      getMetaClient: async () => {
        throw new Error("should not be called");
      },
      getShopifyClient: async () => {
        throw new Error("should not be called");
      },
      recordVersionGuardRejection: () => undefined,
    });
    expect(result.newRowCount).toBe(0);
  });
});
