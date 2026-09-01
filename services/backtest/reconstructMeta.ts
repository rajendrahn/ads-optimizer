// Point-in-time Meta insights reconstruction — reuses B3's own pure row parser
// (`normalizeInsightsRow`, services/ingest/meta/insights/normalize.ts) and C1's own pure
// day/currency normalizer (`normalizeMetaInsightsDailyRow`, services/analytics/daily/
// metaNormalize.ts) UNCHANGED. E1 adds no new Meta-row parsing logic of its own — every field
// value a backtest sees is produced by the exact same code path production uses, just fed from
// `PointInTimeArchiveReader.readArchivedPayloads` instead of a live API response.
//
// Archived "insights_page" payloads are raw `InsightsPageResponse` objects
// (pollAsyncReport.ts's own archive call, `payload: pageData`) — this file's only real job is
// unwrapping `.data` and threading each archived run's own historical completion time through as
// `fetchedAt`, rather than `new Date()` (which would stamp every reconstructed row with "now",
// long after the asOf date being replayed).

import { normalizeInsightsRow } from "@services/ingest/meta/insights/normalize.ts";
import { normalizeMetaInsightsDailyRow } from "@services/analytics/daily/metaNormalize.ts";
import type { InsightsPageResponse } from "@services/ingest/meta/insights/reportRequest.ts";
import type {
  AttributionProvenance,
  MetaInsightsDaily,
  MetaInsightsDailyNormalized,
} from "@shared/schema/index.ts";
import type { PointInTimeArchiveReader } from "./pointInTimeArchive.ts";

export interface ReconstructMetaInsightsCtx {
  accountId: string;
  currency: string;
  attribution: AttributionProvenance;
  reportingTimezone: string;
  reportingCurrency: string;
  /** The Meta ad account's own configured timezone — see C1's own notes on why this defaults to
   * the reporting timezone for this account (verified live, Asia/Kolkata both sides). */
  nativeTimezone: string;
}

/**
 * Every `MetaInsightsDailyNormalized` row reconstructible from archived "insights_page" payloads
 * whose producing sync run had completed by the reader's own `asOfInstant` — i.e., exactly what
 * C2's real `aggregateMetaWindow` expects as input. A row whose archived payload is malformed
 * (missing a required id field) is skipped with a console warning rather than thrown — a single
 * bad historical page should not abort an entire backtest run over months of history.
 */
export async function reconstructMetaInsightsNormalizedAsOf(
  reader: PointInTimeArchiveReader,
  ctx: ReconstructMetaInsightsCtx,
): Promise<MetaInsightsDailyNormalized[]> {
  const records = await reader.readArchivedPayloads("meta", "insights_page");
  const rows: MetaInsightsDailyNormalized[] = [];
  const computedAt = reader.asOfInstant;

  for (const record of records) {
    const fetchedAt = reader.runFinishedAt(record.runId) ?? reader.asOfInstant;
    const page = record.payload as InsightsPageResponse;
    const rawRows = page.data ?? [];
    for (const raw of rawRows) {
      let daily: MetaInsightsDaily;
      try {
        daily = normalizeInsightsRow(raw, {
          accountId: ctx.accountId,
          currency: ctx.currency,
          attribution: ctx.attribution,
          fetchedAt,
        });
      } catch (err) {
        console.warn(
          `[backtest] reconstructMetaInsightsNormalizedAsOf: skipping malformed row in ${record.path}`,
          err,
        );
        continue;
      }
      rows.push(
        normalizeMetaInsightsDailyRow(daily, {
          reportingTimezone: ctx.reportingTimezone,
          reportingCurrency: ctx.reportingCurrency,
          nativeTimezone: ctx.nativeTimezone,
          computedAt,
        }),
      );
    }
  }
  return rows;
}
