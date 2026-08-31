// C5's contract, consumed by injection — NOT by importing `services/analytics/seasonality/`
// directly. Per IMPLEMENTATION_PLAN.md C2's brief: "It may not exist yet when you need it — so
// depend on the contract, not the file: treat seasonality as optional (inject it, or tolerate
// its absence with a null-ish context) so your own tests pass whether or not C5 has landed." C5
// was still mid-flight in this session (no `services/analytics/seasonality/index.ts` barrel, no
// `seasonalityContextFor` export yet, at the time this file was written) — a static import from
// that path would have failed `tsc` outright, not just returned nothing at runtime. Dependency
// injection sidesteps that entirely: this file never references the seasonality directory by
// name, so there is zero merge/typecheck coupling to C5's concurrent edits there.
//
// The interface below is C5's contract verbatim, copied here rather than imported, per the
// brief's own instruction ("Code against exactly this; do not invent your own shape"). Once C5
// lands, wiring the real implementation in is a one-line change at RECOMPUTE_FEATURES's call
// site (recomputeFeaturesTask.ts) or its own registration — pass
// `services/analytics/seasonality/index.ts`'s `seasonalityContextFor` as the
// `SeasonalityContextProvider` — with no change needed anywhere in this directory.

import type { ReportingDay, SeasonalityContextSnapshot } from "@shared/schema/index.ts";
import type { DayRange } from "./windows.ts";

/** C5's contract (IMPLEMENTATION_PLAN.md C2's brief), field-for-field. */
export interface SeasonalityContext {
  labels: string[];
  spansSeasonalBoundary: boolean;
  demandIndex: number | null;
  demandIndexSampleSize: number;
  summaryText: string;
}

/** C5's own function signature, field-for-field — `window`/`baseline` use `{ startDay, endDay }`
 * (this module's `DayRange`), matching C5's `{ startDay: ReportingDay; endDay: ReportingDay }`
 * structurally. */
export type SeasonalityContextProvider = (
  window: { startDay: ReportingDay; endDay: ReportingDay },
  baseline?: { startDay: ReportingDay; endDay: ReportingDay },
) => Promise<SeasonalityContext>;

/** The "tolerate its absence" half of the brief — what every window gets when no provider is
 * injected (C5 not wired in yet) or the injected provider throws. Never fabricates a label or a
 * demand index; `summaryText` says plainly that no seasonality context is available, so a D2
 * packet reader is never left assuming silence means "off-season" or "checked and found none". */
export const NULL_SEASONALITY_CONTEXT: SeasonalityContext = {
  labels: [],
  spansSeasonalBoundary: false,
  demandIndex: null,
  demandIndexSampleSize: 0,
  summaryText: "Seasonality context unavailable — C5's calendar is not wired in for this run.",
};

/**
 * Resolves a window's seasonality context through an optional injected provider, tolerating its
 * absence OR failure (a provider throwing — e.g. a transient Firestore read — must not fail the
 * whole feature recompute over a genuinely optional, descriptive-only signal). Always resolves;
 * never rejects.
 */
export async function resolveSeasonalityContext(
  provider: SeasonalityContextProvider | undefined,
  window: DayRange,
  baseline?: DayRange,
): Promise<SeasonalityContext> {
  if (!provider) return NULL_SEASONALITY_CONTEXT;
  try {
    return await provider(window, baseline);
  } catch (err) {
    console.warn("[seasonality] provider threw — falling back to null context", err);
    return NULL_SEASONALITY_CONTEXT;
  }
}

export function toSeasonalityContextSnapshot(
  context: SeasonalityContext,
): SeasonalityContextSnapshot {
  return {
    labels: context.labels,
    spansSeasonalBoundary: context.spansSeasonalBoundary,
    demandIndex: context.demandIndex,
    demandIndexSampleSize: context.demandIndexSampleSize,
    summaryText: context.summaryText,
  };
}
