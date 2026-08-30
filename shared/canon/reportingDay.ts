// The reporting-day canon — §5.1: "Meta reports daily insights in the ad account's timezone.
// Shopify timestamps orders in the shop's timezone. Joining them into one 'day' without
// normalisation silently moves revenue across day boundaries."
//
// `toReportingDay` and `reportingDayToUtcRange` (its inverse) are, per A3's spec, "the only
// sanctioned way to derive a reporting day." Every later step (C1 normalization first, then
// anything windowed on top of it) must call these rather than hand-rolling date math —
// hand-rolled math is exactly what produces the silent midnight-boundary bugs §5.1 warns
// about, because plain `Date` arithmetic has no notion of an IANA zone's offset or its DST
// transitions.
//
// No date library is used or needed. `Intl.DateTimeFormat` with a `timeZone` option performs
// full IANA timezone conversion (including DST) using the platform's own tzdata — that's a
// deliberate implementation choice per IMPLEMENTATION_PLAN.md A3's constraints, not an
// oversight.

import { reportingDay, type ReportingDay } from "../schema/common.ts";

interface ZonedDateTimeParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

// One formatter per timezone would be a reasonable micro-optimization, but correctness comes
// first and this runs at normalization-batch scale (C1), not per-request — a fresh formatter
// per call is fine. `hourCycle: "h23"` avoids the "24:00 instead of 00:00" quirk some locales
// use for midnight under h24.
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  // An invalid IANA name throws RangeError here — that's the fail-loudly behaviour we want:
  // a typo'd timezone must never silently fall back to the host's local zone or to UTC.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getZonedDateTimeParts(instant: Date, timeZone: string): ZonedDateTimeParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const year = map.year;
  const month = map.month;
  const day = map.day;
  const hour = map.hour;
  const minute = map.minute;
  const second = map.second;
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error(
      `toReportingDay: Intl.DateTimeFormat did not return complete date parts for timeZone "${timeZone}"`,
    );
  }
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

/**
 * The UTC offset (in milliseconds) in effect at `instant` for `timeZone`, defined so that
 * `wallClockAsUtcMs(instant) === instant.getTime() + offsetMs`. Positive east of UTC (e.g.
 * Asia/Kolkata is +19_800_000 ms = +5:30), negative west of it. DST-aware: this changes value
 * across a transition, which is exactly what makes the zonedTimeToUtc fixed-point below
 * correct on either side of one.
 */
function getOffsetMs(instant: Date, timeZone: string): number {
  const p = getZonedDateTimeParts(instant, timeZone);
  const wallAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtcMs - instant.getTime();
}

/**
 * The inverse of getZonedDateTimeParts: given wall-clock date/time components as they should
 * read *in* `timeZone`, find the UTC instant that produces them.
 *
 * Standard technique (no date library implements this any more cleverly): guess the offset is
 * whatever it is at the naive UTC interpretation of the wall-clock components, then correct.
 * Two fixed-point iterations are enough — a timezone's offset only takes one of at most two
 * values (pre-/post-transition) in any neighbourhood of a few hours, so the second iteration
 * always lands on the correct one even when the first guess straddled a transition.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let instantMs = target;
  for (let i = 0; i < 2; i++) {
    const offset = getOffsetMs(new Date(instantMs), timeZone);
    instantMs = target - offset;
  }
  return new Date(instantMs);
}

/**
 * Derive the reporting day (`YYYY-MM-DD`, a calendar day with no timezone of its own) that
 * `instant` falls on when viewed in `timezone`. This is the ONLY sanctioned way to make that
 * derivation (IMPLEMENTATION_PLAN.md A3) — every later step joining Meta and Shopify data onto
 * a shared day must call this rather than doing its own UTC-offset arithmetic.
 *
 * Throws (via `Intl.DateTimeFormat`) if `timezone` is not a valid IANA zone name.
 */
export function toReportingDay(instant: Date, timezone: string): ReportingDay {
  if (Number.isNaN(instant.getTime())) {
    throw new Error("toReportingDay: instant is an invalid Date");
  }
  const p = getZonedDateTimeParts(instant, timezone);
  const yyyy = String(p.year).padStart(4, "0");
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return reportingDay.parse(`${yyyy}-${mm}-${dd}`);
}

export interface ReportingDayUtcRange {
  /** Inclusive: the first UTC instant that falls on this reporting day in `timezone`. */
  startUtc: Date;
  /** Exclusive: the first UTC instant of the NEXT reporting day — i.e. `[startUtc, endUtcExclusive)`. */
  endUtcExclusive: Date;
}

/**
 * The inverse of `toReportingDay`: given a reporting day and the timezone it was declared in,
 * return the half-open UTC instant range `[startUtc, endUtcExclusive)` that maps onto it. A
 * reporting day has no single instant of its own — it is a 23-, 24- or 25-hour span of real
 * time depending on whether a DST transition falls inside it — so the range, not a point, is
 * the correct inverse.
 *
 * Throws if `day` is not `YYYY-MM-DD` or `timezone` is not a valid IANA zone name.
 */
export function reportingDayToUtcRange(day: ReportingDay, timezone: string): ReportingDayUtcRange {
  const parsed = reportingDay.parse(day);
  const [y, m, d] = parsed.split("-").map(Number) as [number, number, number];

  const startUtc = zonedTimeToUtc(y, m, d, 0, 0, 0, timezone);
  // Advance the calendar date by one day using UTC field arithmetic (which normalizes
  // month/year rollover for us), then re-run the same wall-clock-to-UTC conversion for
  // midnight of THAT day — this is what lets endUtcExclusive pick up a different UTC offset
  // than startUtc when a DST transition falls inside the reporting day.
  const nextCalendarDay = new Date(Date.UTC(y, m - 1, d + 1));
  const endUtcExclusive = zonedTimeToUtc(
    nextCalendarDay.getUTCFullYear(),
    nextCalendarDay.getUTCMonth() + 1,
    nextCalendarDay.getUTCDate(),
    0,
    0,
    0,
    timezone,
  );

  return { startUtc, endUtcExclusive };
}
