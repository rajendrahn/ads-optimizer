// NORMALIZE_META_INSIGHTS_DAILY — C1's own task type, not one of §10.2's original list (same
// category of addition as B5's SHOPIFY_IMPORT_ORDERS_CSV and B8's META_SYNC_CREATIVE_IDENTITY):
// re-expresses every already-synced `metaInsightsDaily` row (B3) onto the canon reporting day
// and currency (§5), writing one `metaInsightsDailyNormalized` row per source row.
//
// `runSource: "internal"` / `syncStateTarget: null` (registry.ts): this task makes no live Meta
// call and has no watermark of its own to advance — it's a Firestore-to-Firestore re-derivation
// from data B3 already fetched and synced, the same category as RECOMPUTE_FEATURES (§10.2). Full
// recompute over the whole `metaInsightsDaily` collection every run, not incremental — matching
// §10.1's account-scale reasoning ("a full feature recompute is a few thousand small reads and
// writes... well under a second"), which applies here just as well: B2 measured this account at
// ~17K real insight rows/year, small enough that re-deriving all of them every run is simpler and
// safer than tracking what changed. An optional `since`/`until` payload filter exists for a
// lighter partial run (e.g. tests), not because full recompute is too slow in production.
//
// `nativeTimezone` — the Meta ad account's own configured timezone, needed to correctly remap
// `metaInsightsDaily.date` (see mapReportingDay.ts's module comment for why this can't just be
// `toReportingDay`'d directly). Verified LIVE against the real ad account for this step
// (`GET /{accountId}?fields=timezone_name` -> `"Asia/Kolkata"`, matching this account's real
// Shopify shop timezone -- `{ shop { ianaTimezone } }` -> `"Asia/Kolkata"` -- and the reporting
// canon's own `reportingTimezone`). Since nothing in the stored data captures this today (B2/B3
// only ever fetched/stored the account's *currency*, never its timezone), this defaults to the
// canon's own `reportingTimezone` — documented here as a verified-true assumption, not a guess,
// and overridable via the payload if a future account's Meta timezone setting ever diverges from
// its reporting canon. Whoever notices a real divergence should capture the account's real
// timezone onto stored data (e.g. as a B2 config-snapshot field) rather than stretching this
// default further.

import { getDb } from "@shared/firestore/index.ts";
import {
  COLLECTIONS,
  createRepository,
  metaInsightsDailyNormalizedKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { loadReportingCanon } from "@shared/canon/index.ts";
import {
  metaInsightsDailyNormalizedSchema,
  metaInsightsDailySchema,
  type MetaInsightsDaily,
  type ReportingDay,
} from "@shared/schema/index.ts";
import { mapWithConcurrency } from "@services/ingest/meta/insights/index.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import { normalizeMetaInsightsDailyRow } from "./metaNormalize.ts";

export interface NormalizeMetaInsightsDailyPayload {
  /** Restricts the source rows processed to `metaInsightsDaily.date` (native day) in this
   * inclusive range. Omit to process the whole collection (the normal, full-recompute run). */
  since?: ReportingDay;
  until?: ReportingDay;
  /** Overrides the Meta ad account's own configured timezone — see module comment. Defaults to
   * the reporting canon's timezone. */
  nativeTimezone?: string;
  /** Bounded write concurrency, mirroring B3's own `mapWithConcurrency` use for the same reason
   * (one Firestore transaction per version-guarded write, no bulk primitive). */
  writeConcurrency?: number;
}

function parsePayload(raw: unknown): NormalizeMetaInsightsDailyPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as NormalizeMetaInsightsDailyPayload;
}

export const normalizeMetaInsightsDailyHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const canon = await loadReportingCanon();
  const nativeTimezone = payload.nativeTimezone ?? canon.reportingTimezone;
  const db = getDb();

  const sourceRepo = createRepository<MetaInsightsDaily>(
    db,
    COLLECTIONS.metaInsightsDaily,
    metaInsightsDailySchema,
  );

  const rows = await sourceRepo.query((ref) => {
    let query = ref.orderBy("date", "asc") as typeof ref;
    if (payload.since) query = query.where("date", ">=", payload.since) as typeof ref;
    if (payload.until) query = query.where("date", "<=", payload.until) as typeof ref;
    return query;
  });

  const computedAt = new Date();
  const writeConcurrency = payload.writeConcurrency ?? 20;

  let written = 0;
  let rejected = 0;
  await mapWithConcurrency(rows, writeConcurrency, async (row) => {
    const normalized = normalizeMetaInsightsDailyRow(row, {
      reportingTimezone: canon.reportingTimezone,
      reportingCurrency: canon.reportingCurrency,
      nativeTimezone,
      computedAt,
    });
    const docId = metaInsightsDailyNormalizedKey(normalized.adId, normalized.reportingDay);
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.metaInsightsDailyNormalized,
      docId,
      incoming: normalized,
      schema: metaInsightsDailyNormalizedSchema,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") written++;
    else rejected++;
  });

  return {
    newRowCount: written,
    summary: { rowsRead: rows.length, rowsWritten: written, rowsRejected: rejected },
  };
};

export const normalizeMetaInsightsDailyRegistration: TaskRegistration = {
  taskType: "NORMALIZE_META_INSIGHTS_DAILY",
  runSource: "internal",
  syncStateTarget: null,
  handler: normalizeMetaInsightsDailyHandler,
};
