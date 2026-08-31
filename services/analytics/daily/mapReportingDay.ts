// C1's day-remapping step (§5.1) — built entirely on A3's sanctioned `@shared/canon` helpers,
// never hand-rolled date math (per this step's own brief: "A3 is the only sanctioned path and
// its DST correctness is already proven").
//
// Meta and Shopify need two different treatments here, because they hand C1 two different kinds
// of value:
//   - Shopify's `shopifyOrders.createdAt` / `shopifyRefunds.createdAt` is a real UTC instant
//     (B5 parses Shopify's `YYYY-MM-DD HH:mm:ss ±HHMM` timestamps via explicit UTC-offset
//     arithmetic — see that step's notes). `toReportingDay(instant, reportingTimezone)` is the
//     entire job; there is nothing to "remap" because there is no other timezone in play.
//   - `metaInsightsDaily.date` is NOT an instant — it's a calendar-day string
//     (`date_start` from Meta's daily-breakdown insights report) already denominated in the
//     Meta ad account's OWN configured timezone, per `shared/schema/meta.ts`'s own comment on
//     that field ("native Meta-account-timezone day this row covers (§5.1); C1 remaps to
//     canon"). Meta's report request (services/ingest/meta/insights/reportRequest.ts) passes no
//     `time_zone` override, so this is Meta's account-timezone default, not UTC and not
//     necessarily the reporting timezone.
//
// `mapNativeDayToReportingDay` bridges the second case using ONLY `@shared/canon` primitives:
// turn the native day into its UTC instant range in the native timezone
// (`reportingDayToUtcRange`), take the midpoint of that range as the one representative instant
// for a day we only have as an aggregate (there is no finer-grained timestamp to remap — Meta's
// daily breakdown gives one row per day, not per hour), then re-derive which reporting day that
// instant falls on (`toReportingDay`). When `nativeTimezone === reportingTimezone` (verified true
// for this account's real data — see the task-level module comment for the live check), this is
// the identity map: the midpoint of a day's own UTC range always falls back on that same day when
// viewed in the same timezone. The general form is kept, not hardcoded to identity, because
// nothing about this function should have to change if the account's Meta timezone setting or
// the reporting canon's timezone ever diverge — see that same module comment for what a real
// divergence would require going forward.

import { reportingDayToUtcRange, toReportingDay } from "@shared/canon/index.ts";
import type { ReportingDay } from "@shared/schema/index.ts";

export interface MappedReportingDay {
  reportingDay: ReportingDay;
  /** The instant used to decide the reporting day — the midpoint of the native day's UTC range.
   * Exposed for tests/debugging, not stored on any normalized record (there is no single real
   * instant a whole day's aggregate belongs to). */
  representativeInstant: Date;
}

export function mapNativeDayToReportingDay(
  nativeDay: ReportingDay,
  nativeTimezone: string,
  reportingTimezone: string,
): MappedReportingDay {
  const { startUtc, endUtcExclusive } = reportingDayToUtcRange(nativeDay, nativeTimezone);
  const representativeInstant = new Date((startUtc.getTime() + endUtcExclusive.getTime()) / 2);
  return {
    reportingDay: toReportingDay(representativeInstant, reportingTimezone),
    representativeInstant,
  };
}
