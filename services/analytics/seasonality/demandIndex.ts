// The demand-index core — pure, no Firestore, fully unit-testable against synthetic maps. See
// context.ts for the thin Firestore-reading wrapper that builds these maps from
// `shopifyOrdersNormalized` (C1) and `shopifyDailyCoverage` (C1).
//
// IMPLEMENTATION_PLAN.md C5: "A demand index per seasonal label, derived from the account's own
// order history (B5), expressed relative to the trailing off-season baseline." The orchestrator's
// own honesty requirement on top of that (read literally, not the plan's own softer "n=1 is
// honest" framing, which predates it — see the module comment on `MIN_SAMPLE_SIZE_FOR_INDEX`
// below): "Return demandIndex: null ... rather than computing a confident-looking figure from a
// single occurrence." So a label needs at least TWO usable historical occurrences before this
// returns a number at all — one occurrence is recorded (via `sampleSize`) but never presented as
// an index.
//
// "Usable" for one occurrence means: at least `minBaselineDays` clean days are available BOTH for
// the occurrence itself and for its own trailing off-season baseline, where "clean" means (a)
// actually observed (a `shopifyDailyCoverage` row exists for that day — see context.ts) and (b)
// not inside B5's known Shopify data gap (`hasCoverageGap: false`). A day silently defaults to
// revenue 0 only when it IS clean and simply had no orders — never for a day with no coverage
// row or a gap day, which are excluded outright rather than treated as a real zero. This is
// exactly the distinction IMPLEMENTATION_PLAN.md's own C1 notes draw ("a day with zero rows has
// nothing to stamp a gap flag onto ... C2/C3 MUST treat [a gap] as 'genuinely no data', never
// 'zero activity'") — C5 inherits that same discipline for its own aggregate.

import { addCalendarDays } from "@shared/canon/index.ts";
import type { ReportingDay, SeasonalCalendarWindow } from "@shared/schema/index.ts";
import { isOffSeasonDay } from "./labels.ts";

/**
 * Minimum distinct usable historical occurrences of a label before `demandIndex` is a number
 * instead of `null`. Set to 2, not 1 — see module comment. This account's real order history
 * (2025-01-15 -> 2025-12-13, gap to ~2026-07-02) contains at most ONE clean occurrence of any
 * single-year festive label, so with this threshold every such label honestly returns `null`
 * today; that is the expected, correct behaviour, not a bug to work around. It will start
 * returning real numbers once a second year of clean data exists for a given label.
 */
export const MIN_SAMPLE_SIZE_FOR_INDEX = 2;

export interface DemandIndexOptions {
  /** How many trailing off-season days to average for one occurrence's own baseline. */
  trailingBaselineDays: number;
  /** Minimum clean (observed, non-gap) days required — for the occurrence itself AND for its
   *  trailing baseline — before that occurrence counts as usable at all. */
  minCleanDays: number;
  /** How many calendar days to walk backward, at most, looking for `trailingBaselineDays` clean
   *  off-season days. Guards against an unbounded walk when the account's entire pre-occurrence
   *  history is gapped or seasonal. */
  maxBaselineLookbackDays: number;
}

export const DEFAULT_DEMAND_INDEX_OPTIONS: DemandIndexOptions = {
  trailingBaselineDays: 30,
  minCleanDays: 7,
  maxBaselineLookbackDays: 90,
};

export interface OccurrenceDetail {
  label: string;
  startDay: ReportingDay;
  endDay: ReportingDay;
  usable: boolean;
  reason?: string;
  ratio?: number;
}

export interface DemandIndexResult {
  demandIndex: number | null;
  sampleSize: number;
  occurrences: OccurrenceDetail[];
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function enumerateDays(startDay: ReportingDay, endDay: ReportingDay): ReportingDay[] {
  const days: ReportingDay[] = [];
  for (let day = startDay; day <= endDay; day = addCalendarDays(day, 1)) {
    days.push(day);
  }
  return days;
}

function isDayClean(coverageByDay: ReadonlyMap<ReportingDay, boolean>, day: ReportingDay): boolean {
  // Present + hasCoverageGap === false ("observed, no gap"). Absent (no coverage row at all —
  // before the account's earliest observed day, or beyond however far shopifyDailyCoverage has
  // been computed) is treated the same as a gap: unknown, never a silent zero.
  const hasGap = coverageByDay.get(day);
  return hasGap === false;
}

/** Walks backward from `beforeDay` (exclusive) collecting the most recent `count` clean,
 *  off-season days, stopping after `maxLookbackDays` calendar days examined either way. */
function collectTrailingOffSeasonDays(
  beforeDay: ReportingDay,
  count: number,
  maxLookbackDays: number,
  calendarWindows: readonly SeasonalCalendarWindow[],
  coverageByDay: ReadonlyMap<ReportingDay, boolean>,
): ReportingDay[] {
  const collected: ReportingDay[] = [];
  let cursor = beforeDay;
  for (let examined = 0; examined < maxLookbackDays && collected.length < count; examined++) {
    cursor = addCalendarDays(cursor, -1);
    if (isDayClean(coverageByDay, cursor) && isOffSeasonDay(calendarWindows, cursor)) {
      collected.push(cursor);
    }
  }
  return collected;
}

export interface ComputeDemandIndexInput {
  /** The labels the window under evaluation carries. Empty = off-season window: demandIndex is
   *  trivially 1.0 (it defines part of the baseline itself), sampleSize 0 — see
   *  IMPLEMENTATION_PLAN.md C5's "off-season default". */
  labels: readonly string[];
  /** Every known calendar window (any label) — used both to find historical occurrences of
   *  `labels` and to determine which days are off-season for baseline purposes. */
  calendarWindows: readonly SeasonalCalendarWindow[];
  /** Daily gross order revenue (minor units), keyed by reporting day. A day absent from this map
   *  is treated as revenue 0 IF it is otherwise clean; see module comment. */
  dailyRevenueMinorUnits: ReadonlyMap<ReportingDay, number>;
  /** Whether each reporting day has a coverage gap — key presence means "observed" (a
   *  shopifyDailyCoverage row exists); the boolean is `hasCoverageGap`. */
  coverageByDay: ReadonlyMap<ReportingDay, boolean>;
  options?: Partial<DemandIndexOptions>;
}

export function computeDemandIndex(input: ComputeDemandIndexInput): DemandIndexResult {
  if (input.labels.length === 0) {
    return { demandIndex: 1, sampleSize: 0, occurrences: [] };
  }

  const opts: DemandIndexOptions = { ...DEFAULT_DEMAND_INDEX_OPTIONS, ...input.options };
  const labelSet = new Set(input.labels);
  const relevantWindows = input.calendarWindows.filter((w) => labelSet.has(w.label));

  const occurrences: OccurrenceDetail[] = [];
  const usableRatios: number[] = [];

  for (const window of relevantWindows) {
    const occurrenceDays = enumerateDays(window.startDay, window.endDay).filter((day) =>
      isDayClean(input.coverageByDay, day),
    );
    if (occurrenceDays.length === 0) {
      occurrences.push({
        label: window.label,
        startDay: window.startDay,
        endDay: window.endDay,
        usable: false,
        reason: "no clean (observed, non-gap) days in this occurrence's own date range",
      });
      continue;
    }

    const baselineDays = collectTrailingOffSeasonDays(
      window.startDay,
      opts.trailingBaselineDays,
      opts.maxBaselineLookbackDays,
      input.calendarWindows,
      input.coverageByDay,
    );
    if (baselineDays.length < opts.minCleanDays) {
      occurrences.push({
        label: window.label,
        startDay: window.startDay,
        endDay: window.endDay,
        usable: false,
        reason: `insufficient trailing off-season baseline (found ${baselineDays.length} clean day(s), need >= ${opts.minCleanDays})`,
      });
      continue;
    }

    const occurrenceAvg = meanOf(
      occurrenceDays.map((d) => input.dailyRevenueMinorUnits.get(d) ?? 0),
    );
    const baselineAvg = meanOf(baselineDays.map((d) => input.dailyRevenueMinorUnits.get(d) ?? 0));
    if (baselineAvg === 0) {
      occurrences.push({
        label: window.label,
        startDay: window.startDay,
        endDay: window.endDay,
        usable: false,
        reason: "trailing off-season baseline average revenue is zero — cannot form a ratio",
      });
      continue;
    }

    const ratio = occurrenceAvg / baselineAvg;
    usableRatios.push(ratio);
    occurrences.push({
      label: window.label,
      startDay: window.startDay,
      endDay: window.endDay,
      usable: true,
      ratio,
    });
  }

  const sampleSize = usableRatios.length;
  const demandIndex = sampleSize >= MIN_SAMPLE_SIZE_FOR_INDEX ? meanOf(usableRatios) : null;
  return { demandIndex, sampleSize, occurrences };
}
