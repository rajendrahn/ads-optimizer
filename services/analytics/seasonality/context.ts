// `seasonalityContextFor` — C5's headline deliverable, and the ONE piece of this step with an
// interface fixed by the orchestrator (not to be renamed or restructured; a C2 agent builds
// against it concurrently). See module comments in labels.ts, demandIndex.ts and
// shopifyDemandSource.ts for the pieces this assembles; this file is the thin orchestration
// layer plus the human-readable summary text §15.2/D2 needs ("the interval appears in the
// packet text, not only the JSON, so the model reasons over it rather than past it" — this
// step's own analogue for seasonal context).
//
// Explicitly OUT OF SCOPE (IMPLEMENTATION_PLAN.md C5): forecasting demand; de-seasonalising or
// otherwise adjusting any stored metric (this returns a context object to be stored/displayed
// BESIDE a metric, never applied to one); guardrails derived from seasonality (D5's job later).

import { addCalendarDays } from "@shared/canon/index.ts";
import { getDb } from "@shared/firestore/client.ts";
import type { ReportingDay, SeasonalCalendarWindow } from "@shared/schema/index.ts";
import { loadSeasonalCalendarWindows } from "./calendarRepo.ts";
import {
  computeDemandIndex,
  DEFAULT_DEMAND_INDEX_OPTIONS,
  MIN_SAMPLE_SIZE_FOR_INDEX,
} from "./demandIndex.ts";
import { labelsForRange, sameRegime, type DayRange } from "./labels.ts";
import { loadDemandSourceMaps, type DemandSourceMaps } from "./shopifyDemandSource.ts";

export interface SeasonalityContext {
  /** Seasonal labels the window overlaps, e.g. ["diwali"], ["wedding_season","dhanteras"], or []
   *  for pure off-season. */
  labels: string[];
  /** True when the window and its comparison baseline sit in different seasonal regimes. False
   *  when no baseline is supplied. */
  spansSeasonalBoundary: boolean;
  /** Demand relative to the trailing off-season baseline (1.0 = same as off-season). NULL when
   *  there is not enough history to say. */
  demandIndex: number | null;
  /** How many distinct occurrences of these labels the history actually contains. Drives whether
   *  demandIndex is non-null. */
  demandIndexSampleSize: number;
  /** Human-readable one-liner for D2's packet TEXT, e.g. "window covers Diwali (n=1, wide
   *  uncertainty); baseline does not". */
  summaryText: string;
}

/** Falls back to a title-cased rendering of an unrecognized label (underscores -> spaces, each
 *  word capitalized) — so a label an operator adds purely as calendar DATA (no code change)
 *  still renders sensibly in summaryText, matching this step's "data, not code" design. */
const LABEL_DISPLAY_NAMES: Record<string, string> = {
  diwali: "Diwali",
  dhanteras: "Dhanteras",
  navratri: "Navratri",
  akshaya_tritiya: "Akshaya Tritiya",
  wedding_season: "wedding season",
  holi: "Holi",
  raksha_bandhan: "Raksha Bandhan",
  ganesh_chaturthi: "Ganesh Chaturthi",
};

function displayName(label: string): string {
  return (
    LABEL_DISPLAY_NAMES[label] ??
    label
      .split("_")
      .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

function formatLabelList(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return displayName(labels[0]);
  const names = labels.map(displayName);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function demandClause(demandIndex: number | null, sampleSize: number): string {
  if (demandIndex === null) {
    return sampleSize === 0
      ? "no clean historical occurrence to measure demand from"
      : `only n=${sampleSize} usable historical occurrence(s) — insufficient for a demand index (need >= ${MIN_SAMPLE_SIZE_FOR_INDEX})`;
  }
  return `n=${sampleSize}; demand ≈${demandIndex.toFixed(2)}x the off-season baseline`;
}

function buildSummaryText(
  labels: readonly string[],
  demandIndex: number | null,
  sampleSize: number,
  baselineLabels: readonly string[] | null,
  spansSeasonalBoundary: boolean,
): string {
  const windowClause =
    labels.length === 0
      ? "window is off-season (no festive label applies)"
      : `window covers ${formatLabelList(labels)} (${demandClause(demandIndex, sampleSize)})`;

  if (baselineLabels === null) {
    return `${windowClause}.`;
  }

  const baselineClause =
    baselineLabels.length === 0
      ? "baseline is off-season"
      : `baseline covers ${formatLabelList(baselineLabels)}`;

  const boundaryNote = spansSeasonalBoundary
    ? " — window and baseline sit in different seasonal regimes"
    : "";

  return `${windowClause}; ${baselineClause}${boundaryNote}.`;
}

/** Widest [fromDay, toDay] needed to compute a demand index for `labels`: covers every known
 *  historical occurrence of those labels PLUS each occurrence's own trailing baseline lookback.
 *  Returns null when there is nothing to look up (no labels, or no historical occurrence of any
 *  of them) — the caller then skips the Firestore demand-source query entirely. */
function demandQueryRange(
  labels: readonly string[],
  calendarWindows: readonly SeasonalCalendarWindow[],
): DayRange | null {
  if (labels.length === 0) return null;
  const labelSet = new Set(labels);
  const relevant = calendarWindows.filter((w) => labelSet.has(w.label));
  if (relevant.length === 0) return null;

  let fromDay: ReportingDay | null = null;
  let toDay: ReportingDay | null = null;
  for (const w of relevant) {
    const lookbackStart = addCalendarDays(
      w.startDay,
      -DEFAULT_DEMAND_INDEX_OPTIONS.maxBaselineLookbackDays,
    );
    if (fromDay === null || lookbackStart < fromDay) fromDay = lookbackStart;
    if (toDay === null || w.endDay > toDay) toDay = w.endDay;
  }
  if (fromDay === null || toDay === null) return null;
  return { startDay: fromDay, endDay: toDay };
}

/**
 * The labels a window spans, whether it and its baseline sit in different seasonal regimes, and
 * a demand index for those labels derived from this account's own Shopify order history (C1) —
 * see demandIndex.ts's module comment for exactly how thin history is handled honestly.
 *
 * Interface fixed by the orchestrator — do not rename or restructure.
 */
export async function seasonalityContextFor(
  window: { startDay: ReportingDay; endDay: ReportingDay },
  baseline?: { startDay: ReportingDay; endDay: ReportingDay },
): Promise<SeasonalityContext> {
  const db = getDb();
  const calendarWindows = await loadSeasonalCalendarWindows({ db });

  const labels = labelsForRange(calendarWindows, window);
  const baselineLabels = baseline ? labelsForRange(calendarWindows, baseline) : null;
  const spansSeasonalBoundary = baselineLabels !== null && !sameRegime(labels, baselineLabels);

  const range = demandQueryRange(labels, calendarWindows);
  const { dailyRevenueMinorUnits, coverageByDay }: DemandSourceMaps = range
    ? await loadDemandSourceMaps(db, range.startDay, range.endDay)
    : {
        dailyRevenueMinorUnits: new Map<ReportingDay, number>(),
        coverageByDay: new Map<ReportingDay, boolean>(),
      };

  const { demandIndex, sampleSize } = computeDemandIndex({
    labels,
    calendarWindows,
    dailyRevenueMinorUnits,
    coverageByDay,
  });

  const summaryText = buildSummaryText(
    labels,
    demandIndex,
    sampleSize,
    baselineLabels,
    spansSeasonalBoundary,
  );

  return {
    labels,
    spansSeasonalBoundary,
    demandIndex,
    demandIndexSampleSize: sampleSize,
    summaryText,
  };
}
