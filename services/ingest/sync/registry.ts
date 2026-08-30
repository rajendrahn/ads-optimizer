// The task-type registry — §10.2. Maps a task type name to the handler that runs it, plus the
// bookkeeping metadata `taskWrapper.ts` needs to drive `syncRuns`/`syncState` correctly: which
// `syncRuns.source` a run of this task type gets, and — for task types that actually advance a
// watermark — which `syncState/{source}_{resource}` document to update on success.
//
// Not every task type touches `syncState`: §10.2 lists internal/derived tasks (RECOMPUTE_FEATURES,
// GENERATE_RECOMMENDATION, EVALUATE_RECOMMENDATION_OUTCOME) alongside the ones that sync an
// external source. `syncStateSchema` (shared/schema/sync.ts, A2) only models `source: "meta" |
// "shopify"` — there is no "internal" syncState, correctly: a recompute task has no watermark
// of its own to fetch a window against. `syncRunSchema.source`, by contrast, does allow
// `"internal"` for exactly this reason. `syncStateTarget: null` is how a registration says
// "this task type has no watermark" — taskWrapper.ts then only ever touches `syncRuns` for it.

import type { TaskHandler } from "./taskWrapper.ts";
import { SYNC_NOOP } from "./taskTypes.ts";

export interface SyncStateTarget {
  source: "meta" | "shopify";
  /** e.g. "insights", "entities", "orders" — matches `syncState.resource`. */
  resource: string;
}

export interface TaskRegistration {
  taskType: string;
  handler: TaskHandler;
  /** `syncRuns.source` for every run of this task type. */
  runSource: "meta" | "shopify" | "internal";
  /** The `syncState` document this task type's successful runs advance, or `null` if this task
   * type has no watermark of its own (an internal/derived task — see module comment). */
  syncStateTarget: SyncStateTarget | null;
}

export interface TaskRegistry {
  register(registration: TaskRegistration): void;
  get(taskType: string): TaskRegistration | undefined;
  list(): string[];
}

export function createTaskRegistry(): TaskRegistry {
  const registrations = new Map<string, TaskRegistration>();
  return {
    register(registration) {
      if (registrations.has(registration.taskType)) {
        throw new Error(
          `createTaskRegistry: task type "${registration.taskType}" is already registered`,
        );
      }
      registrations.set(registration.taskType, registration);
    },
    get(taskType) {
      return registrations.get(taskType);
    },
    list() {
      return [...registrations.keys()];
    },
  };
}

/**
 * The registry as B1 leaves it: only `SYNC_NOOP` registered. B2–B8 build their own registry
 * (or extend this one via `.register()`) with the real §10.2 task types as each lands —
 * nothing here hardcodes that this is the final registry.
 */
export function createDefaultRegistry(): TaskRegistry {
  const registry = createTaskRegistry();
  registry.register({
    taskType: SYNC_NOOP,
    runSource: "internal",
    syncStateTarget: null,
    handler: async (ctx) => {
      return {
        summary: { message: "no-op — proves the dispatch/wrapper/syncRuns path end to end" },
        // Echo an explicit row count so classifySyncStatus resolves to "healthy" by default;
        // a caller can pass payload.simulateNoNewData to exercise the "no_new_data" branch.
        newRowCount:
          typeof ctx.payload === "object" &&
          ctx.payload !== null &&
          "simulateNoNewData" in ctx.payload &&
          (ctx.payload as { simulateNoNewData?: boolean }).simulateNoNewData
            ? 0
            : 1,
      };
    },
  });
  return registry;
}
