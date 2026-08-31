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
import {
  metaSnapshotConfigRegistration,
  metaSyncEntitiesRegistration,
} from "../meta/entities/index.ts";
import {
  metaPollAsyncReportRegistration,
  metaSyncInsightsRegistration,
} from "../meta/insights/index.ts";
import {
  matrixifyImportRegistration,
  shopifySyncOrdersRegistration,
} from "../shopify/orders/index.ts";
import { metaSyncCreativeIdentityRegistration } from "../meta/creative/index.ts";
import { shopifyProcessWebhookRegistration } from "../shopify/webhooks/index.ts";
import {
  auditAdUrlTagsRegistration,
  shopifyResolveAttributionRegistration,
} from "../shopify/attribution/index.ts";
import {
  normalizeMetaInsightsDailyRegistration,
  normalizeShopifyDailyRegistration,
} from "../../analytics/daily/index.ts";

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
 * The registry as B1 left it (only `SYNC_NOOP`), now also carrying B2's two real §10.2 task
 * types — this is the documented extension point B1's own notes point to: "B2–B8 registering
 * their real task handlers means extending `createDefaultRegistry()`." Importing
 * `services/ingest/meta/entities/*` here (a business-logic module reaching into the
 * framework's own default registry) is exactly that extension, not a layering violation —
 * `functions/src/index.ts` calls this indirectly via runtime.ts and needs no changes to pick
 * up whatever is registered here. B3–B8 should do the same as they land, rather than
 * building a second, parallel default registry.
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
  registry.register(metaSyncEntitiesRegistration);
  registry.register(metaSnapshotConfigRegistration);
  // B3's async report job state machine — see services/ingest/meta/insights/pollAsyncReport.ts's
  // module comment for why these two task types exist and how they hand off to each other.
  registry.register(metaSyncInsightsRegistration);
  registry.register(metaPollAsyncReportRegistration);
  // B5's Shopify orders ingestion — the one-time (but re-runnable, see matrixifyImport.ts's
  // module comment) Matrixify CSV backfill and the ongoing GraphQL watermark sync. Both share
  // `syncState/shopify_orders` (see ordersSync.ts's module comment for why).
  registry.register(matrixifyImportRegistration);
  registry.register(shopifySyncOrdersRegistration);
  // B8's creative identity grouping (§7.3, §11.1) — Firestore-only, reads B2's `metaCreatives`.
  registry.register(metaSyncCreativeIdentityRegistration);
  // B6's Shopify webhook processor — receiver.ts (a separate, un-deployed HTTPS endpoint, not
  // this dispatch target) verifies the HMAC and enqueues this task type via Cloud Tasks.
  registry.register(shopifyProcessWebhookRegistration);
  // B7's attribution join (§6) — AUDIT_AD_URL_TAGS parses B2's already-ingested
  // metaAds.destinationUrl (no live Meta call); SHOPIFY_RESOLVE_ATTRIBUTION is B7's own
  // addition (not in §10.2's original list — see resolveAttribution.ts's module comment) that
  // resolves shopifyOrders.landingSite against metaAds/metaCampaigns.
  registry.register(auditAdUrlTagsRegistration);
  registry.register(shopifyResolveAttributionRegistration);
  // C1's daily normalization (§5) — re-expresses already-synced metaInsightsDaily/shopifyOrders/
  // shopifyRefunds rows onto the canon reporting day and currency. Firestore-only, no live Meta/
  // Shopify call; see services/analytics/daily's own module comments.
  registry.register(normalizeMetaInsightsDailyRegistration);
  registry.register(normalizeShopifyDailyRegistration);
  return registry;
}
