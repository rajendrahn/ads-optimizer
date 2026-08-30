// The reconciliation-window helper — §9.4: "Previously reported conversion totals change as
// attribution matures, so strict append-only sync is insufficient."
//
//   - New Meta dates are fetched incrementally.
//   - A rolling 14-day window is re-fetched and upserted (configurable).
//   - A deeper reconciliation runs weekly over 60 days.
//   - Full historical backfill is not repeated unless explicitly requested or required by a
//     schema migration.
//
// This is a pure function: given a watermark and the window sizes, produce the `[startDate,
// endDate]` (both inclusive, both reporting days per shared/canon) to fetch. It does not fetch
// anything itself, and it does not decide *when* a deep pass is due (that's a scheduling
// decision — a day-of-week check or a "last deep run" timestamp on syncState — left to the
// caller, since §25's "weekly" cadence is an operational schedule, not a property of the
// watermark). Pass `mode: "deep"` on the run the caller has already decided is the weekly one.
//
// Ambiguity resolved: what should this do with no watermark at all (`lastDataDate: null` —
// meaning §9.1's first-run backfill hasn't completed)? Reconciliation only makes sense once
// there is history to reconcile; a caller with no watermark should run the historical backfill
// flow instead (a distinct, one-time flow — B3 owns it, not this helper). Rather than silently
// returning some plausible-looking-but-wrong range, this throws, matching A3's "fail loudly on
// a state that must never be silently defaulted" precedent (`loadReportingCanon`).
import { addCalendarDays } from "@shared/canon/index.ts";
import type { ReportingDay } from "@shared/schema/index.ts";

export interface ComputeReconciliationWindowInput {
  /** syncState.lastDataDate — null means "never successfully synced", see module comment. */
  watermark: ReportingDay | null;
  /** Usually `toReportingDay(new Date(), reportingTimezone)` — the caller's "today". */
  today: ReportingDay;
  /** The rolling re-fetch window size in days, §9.4's "14" (configurable). Always applied,
   * every run, regardless of how recent the watermark is — that's what makes it "rolling". */
  reconciliationDays: number;
  /** "incremental" (the common case: new dates + the rolling window) or "deep" (§9.4's weekly
   * 60-day pass, superseding the rolling window for this run). The caller decides which this
   * run is — see module comment. */
  mode: "incremental" | "deep";
  /** Required when `mode: "deep"` — §9.4's "60" (configurable). */
  deepReconciliationDays?: number;
}

export type ReconciliationWindowKind = "incremental_plus_rolling" | "deep";

export interface ReconciliationWindow {
  /** Inclusive. */
  startDate: ReportingDay;
  /** Inclusive — always `today`. */
  endDate: ReportingDay;
  kind: ReconciliationWindowKind;
}

export function computeReconciliationWindow(
  input: ComputeReconciliationWindowInput,
): ReconciliationWindow {
  if (input.reconciliationDays < 1) {
    throw new Error(
      `computeReconciliationWindow: reconciliationDays must be >= 1, got ${input.reconciliationDays}`,
    );
  }
  if (input.watermark === null) {
    throw new Error(
      "computeReconciliationWindow: no watermark set (syncState.lastDataDate is null) — " +
        "run the historical backfill flow first; reconciliation re-fetches history, it does " +
        "not create it.",
    );
  }

  const rollingStart = addCalendarDays(input.today, -(input.reconciliationDays - 1));

  if (input.mode === "deep") {
    if (input.deepReconciliationDays === undefined || input.deepReconciliationDays < 1) {
      throw new Error(
        "computeReconciliationWindow: mode 'deep' requires deepReconciliationDays >= 1",
      );
    }
    const deepStart = addCalendarDays(input.today, -(input.deepReconciliationDays - 1));
    return { startDate: deepStart, endDate: input.today, kind: "deep" };
  }

  // Incremental: cover both "dates newer than the watermark" and the rolling reconciliation
  // window, whichever reaches further back. ReportingDay strings sort lexicographically like
  // the calendar dates they are, so plain string comparison is a correct min().
  const incrementalStart = addCalendarDays(input.watermark, 1);
  const startDate = incrementalStart < rollingStart ? incrementalStart : rollingStart;

  return { startDate, endDate: input.today, kind: "incremental_plus_rolling" };
}
