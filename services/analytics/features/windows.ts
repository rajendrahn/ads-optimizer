// The §4.2 window set, and pure calendar-day math on top of it. No Firestore, no I/O — this is
// just "which reporting days does each window cover", built on A3's `addCalendarDays` (pure
// calendar arithmetic, no timezone — exactly the tool B5/C1 already reach for the same reason:
// windowing never needs to touch an instant, only day strings).
//
// §4.2, verbatim: "28d primary, 14d secondary, 7d trend-only. No 1d or 3d in the decision path."
// 56d is optional context (creative-family fatigue/seasonality) per the same table. C2 computes
// all four — C3 (out of scope here) is what actually enforces which ones gate a decision.

import { addCalendarDays } from "@shared/canon/index.ts";
import type { ReportingDay, WindowLabel } from "@shared/schema/index.ts";

/** Window length in calendar days, per §4.2. */
export const WINDOW_LENGTH_DAYS: Record<WindowLabel, number> = {
  "7d": 7,
  "14d": 14,
  "28d": 28,
  "56d": 56,
};

/** Every window label C2 computes, in a stable, small-to-large order. */
export const ALL_WINDOW_LABELS: readonly WindowLabel[] = ["7d", "14d", "28d", "56d"];

export interface DayRange {
  /** Inclusive. */
  startDay: ReportingDay;
  /** Inclusive. */
  endDay: ReportingDay;
}

/** An N-day window ending (inclusively) on `endDay` — e.g. a 7d window ending 2026-08-30 covers
 * 2026-08-24..2026-08-30 (7 calendar days total, endDay included). */
export function windowEnding(label: WindowLabel, endDay: ReportingDay): DayRange {
  const length = WINDOW_LENGTH_DAYS[label];
  return { startDay: addCalendarDays(endDay, -(length - 1)), endDay };
}

/** Every §4.2 window, all sharing the same `endDay` ("as of" day — see recomputeFeaturesTask.ts's
 * module comment for why that's "yesterday" by default, not "today"). */
export function allWindowsEnding(endDay: ReportingDay): Record<WindowLabel, DayRange> {
  const result = {} as Record<WindowLabel, DayRange>;
  for (const label of ALL_WINDOW_LABELS) result[label] = windowEnding(label, endDay);
  return result;
}

/** The immediately preceding window of the SAME length, with no gap and no overlap — e.g. the
 * previous-equivalent window for 2026-08-24..2026-08-30 (7 days) is 2026-08-17..2026-08-23. This
 * is "previous equivalent window" per §12's Trend definition, and also what C5's `baseline`
 * parameter expects. */
export function previousEquivalentWindow(window: DayRange): DayRange {
  const length = dayRangeLengthDays(window);
  return {
    startDay: addCalendarDays(window.startDay, -length),
    endDay: addCalendarDays(window.startDay, -1),
  };
}

/** Number of calendar days a range spans, inclusive of both ends. Pure string-date arithmetic —
 * every reporting day sorts and diffs correctly via `Date.UTC` on its own YYYY-MM-DD components,
 * so this never touches a real instant or a timezone. */
export function dayRangeLengthDays(range: DayRange): number {
  const [sy, sm, sd] = range.startDay.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = range.endDay.split("-").map(Number) as [number, number, number];
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

/** Every reporting day in `[range.startDay, range.endDay]`, inclusive both ends. Small windows
 * only (max 56 days here), so a plain array is fine — no need for a lazy generator. */
export function daysInRange(range: DayRange): ReportingDay[] {
  const days: ReportingDay[] = [];
  for (let day = range.startDay; day <= range.endDay; day = addCalendarDays(day, 1)) {
    days.push(day);
  }
  return days;
}

export type { WindowLabel };
