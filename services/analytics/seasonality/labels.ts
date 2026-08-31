// Pure label-overlap math — no Firestore. `seasonalCalendarWindows` rows are half-open-free
// INCLUSIVE ranges (`startDay`..`endDay`, both inclusive); every `ReportingDay` is a validated
// `YYYY-MM-DD` string, which sorts lexicographically exactly like it sorts chronologically
// (the same property services/analytics/daily/coverage.ts's gap-membership check relies on) —
// so overlap is plain string comparison, no date parsing needed.

import type { ReportingDay, SeasonalCalendarWindow } from "@shared/schema/index.ts";

export interface DayRange {
  startDay: ReportingDay;
  endDay: ReportingDay;
}

/** Whether two INCLUSIVE day ranges share at least one day. */
export function rangesOverlap(a: DayRange, b: DayRange): boolean {
  return a.startDay <= b.endDay && a.endDay >= b.startDay;
}

/**
 * Every distinct label among the calendar windows that overlap `range`, sorted alphabetically for
 * a stable, deterministic result (multiple windows of the same label — e.g. two years of
 * "diwali" — collapse to one entry; that can only happen for a `range` wide enough to span more
 * than one occurrence, which windowed decisions in this system never are, but the dedupe is
 * correct regardless). Empty array = off-season, the deliverable's own "off-season default":
 * there is no stored row for "no festival", so no overlap simply produces no labels.
 */
export function labelsForRange(
  windows: readonly SeasonalCalendarWindow[],
  range: DayRange,
): string[] {
  const labels = new Set<string>();
  for (const w of windows) {
    if (rangesOverlap(range, { startDay: w.startDay, endDay: w.endDay })) {
      labels.add(w.label);
    }
  }
  return [...labels].sort();
}

/**
 * Whether a day is "off-season" — covered by NO seasonal window at all (any label). Used by
 * demandIndex.ts to find trailing baseline days: a day carrying any label (even one unrelated to
 * the label being measured) is excluded from the off-season baseline, since it is, by definition,
 * not a normal-demand day.
 */
export function isOffSeasonDay(
  windows: readonly SeasonalCalendarWindow[],
  day: ReportingDay,
): boolean {
  return labelsForRange(windows, { startDay: day, endDay: day }).length === 0;
}

/**
 * Two label sets are "the same seasonal regime" iff they are exactly equal as sets — including
 * both being empty (two off-season windows are the same regime). Used for
 * `SeasonalityContext.spansSeasonalBoundary`.
 */
export function sameRegime(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((label) => setA.has(label));
}
