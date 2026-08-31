// Day-of-week and month-of-year features — IMPLEMENTATION_PLAN.md C5's own deliverable
// ("weekend/weekday effects are real and much cheaper to establish than festive ones"),
// deliberately kept OUT of `SeasonalityContext` (the fixed interface has no field for them) and
// exposed as separate, small pure functions instead — a day-of-week effect is not a "seasonal
// label" the way a festival is, and C2's feature engine (the actual consumer) can call this
// independently of `seasonalityContextFor`.
//
// Pure calendar-day arithmetic, no timezone — a `ReportingDay` (`YYYY-MM-DD`) already has no
// timezone of its own (§5.1, shared/canon/reportingDay.ts's own module comment), so day-of-week
// is a property of the calendar string, not of any instant. `Date.UTC(...).getUTCDay()` is used
// purely as a calendar (Gregorian weekday) calculator here, exactly the way
// shared/canon/reportingDay.ts's `addCalendarDays` uses `Date.UTC` — the resulting `Date` is
// never treated as a real instant.

import { addCalendarDays } from "@shared/canon/index.ts";
import type { ReportingDay } from "@shared/schema/index.ts";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export interface CalendarDayFeatures {
  /** 0 = Sunday .. 6 = Saturday (JS `Date#getDay` convention). */
  dayOfWeek: number;
  dayName: (typeof DAY_NAMES)[number];
  /** Saturday or Sunday. The one assumption this makes explicit: for e-commerce demand purposes,
   *  the weekend is Sat+Sun regardless of any individual business's own work-week. */
  isWeekend: boolean;
  /** 1 = January .. 12 = December. */
  monthOfYear: number;
  monthName: (typeof MONTH_NAMES)[number];
}

function parseReportingDay(day: ReportingDay): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

/** Day-of-week and month-of-year for a single reporting day. */
export function calendarFeaturesForDay(day: ReportingDay): CalendarDayFeatures {
  const { y, m, d } = parseReportingDay(day);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;
  return {
    dayOfWeek: weekday,
    dayName: DAY_NAMES[weekday],
    isWeekend,
    monthOfYear: m,
    monthName: MONTH_NAMES[m - 1],
  };
}

export interface CalendarWindowFeatures {
  totalDays: number;
  weekendDayCount: number;
  weekdayDayCount: number;
  /** Fraction of the window's days that are weekend days, in [0, 1]. */
  weekendFraction: number;
  /** Every distinct month-of-year (1-12) the window touches, ascending. A window can span more
   *  than one calendar month, and — rarely, for a 56-day window — more than two. */
  monthsSpanned: number[];
}

/** Day-of-week/month-of-year features aggregated over an INCLUSIVE window — the shape most of
 *  C2's own windows (7d/14d/28d/56d) actually need, rather than a single day. */
export function calendarFeaturesForWindow(window: {
  startDay: ReportingDay;
  endDay: ReportingDay;
}): CalendarWindowFeatures {
  if (window.startDay > window.endDay) {
    throw new Error(
      `calendarFeaturesForWindow: startDay (${window.startDay}) is after endDay (${window.endDay})`,
    );
  }
  let totalDays = 0;
  let weekendDayCount = 0;
  const months = new Set<number>();
  for (let day = window.startDay; day <= window.endDay; day = addCalendarDays(day, 1)) {
    const f = calendarFeaturesForDay(day);
    totalDays++;
    if (f.isWeekend) weekendDayCount++;
    months.add(f.monthOfYear);
  }
  return {
    totalDays,
    weekendDayCount,
    weekdayDayCount: totalDays - weekendDayCount,
    weekendFraction: totalDays === 0 ? 0 : weekendDayCount / totalDays,
    monthsSpanned: [...months].sort((a, b) => a - b),
  };
}
