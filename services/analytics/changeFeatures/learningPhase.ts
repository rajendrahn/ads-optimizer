// §13.1 — learning-phase state. Pure: the caller (enrichChangeFeaturesTask.ts) has already
// resolved the entity's BUDGET-field change events, its creation day, and its per-day purchase
// counts; this module does no Firestore/Meta I/O and no timezone conversion (everything here
// operates on `ReportingDay` strings, which sort lexicographically exactly like they sort
// chronologically — same convention C5's labels.ts documents and relies on).
//
// Two things this module deliberately does NOT do, both explicit scope calls from
// IMPLEMENTATION_PLAN.md C4:
//   1. Only a material BUDGET edit is treated as a learning-phase reset trigger. Meta's real
//      product also resets learning on some creative/targeting edits — C4's own deliverable list
//      names only "Detection of learning resets triggered by material budget edits," so that is
//      the only cause this module produces. `learningResetCause` is therefore always a
//      budget-shaped value when populated.
//   2. B4's own documented UNKNOWN-ownership rule is respected by construction, not re-litigated
//      here: B4 never emits a BUDGET change event across a transition into/out of UNKNOWN
//      ownership, so no such event ever reaches this module's `budgetEvents` input in the first
//      place — there is nothing for this module to special-case.

import { addCalendarDays } from "@shared/canon/index.ts";
import type { LearningPhaseFeatures, ReportingDay } from "@shared/schema/index.ts";
import {
  LEARNING_PHASE_CONVERSION_THRESHOLD,
  LEARNING_PHASE_WINDOW_DAYS,
  MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT,
} from "./constants.ts";

/** One BUDGET-field metaChangeEvents row, reduced to exactly what this module needs. */
export interface BudgetChangeCandidate {
  detectedAt: Date;
  /** `detectedAt` re-expressed on the canon reporting day (the caller does this conversion,
   * since it needs `loadReportingCanon()`'s timezone — this module stays pure). */
  detectedDay: ReportingDay;
  /** B4: may be `null` even for a real BUDGET event (no computable base) — a null-percent event
   * cannot be judged material and is therefore never a reset trigger. */
  percent: number | null;
}

export interface LearningPhaseInput {
  /** Matches the entity's feature-doc asOfDay (yesterday, in the reporting timezone, by
   * convention — see enrichChangeFeaturesTask.ts). */
  asOfDay: ReportingDay;
  /** Fallback reset floor when no material budget edit has ever fired for this entity. */
  entityCreatedDay: ReportingDay;
  /** Every BUDGET-field change event for this entity, any age, any order. */
  budgetEvents: readonly BudgetChangeCandidate[];
  /** Purchases per reporting day. A day absent from this map is treated as a real, measured
   * zero-purchase day (this account has genuine zero-spend/zero-purchase days), not "unknown" —
   * matching C2's own zero-vs-null discipline. Only days inside the eventual lookback window are
   * consulted; the caller does not need to pre-trim this to exactly that range. */
  purchasesByDay: ReadonlyMap<ReportingDay, number>;
  materialBudgetChangeThresholdPercent?: number;
  conversionsThreshold?: number;
  windowDays?: number;
}

/** The most recent BUDGET event whose |percent| clears the materiality bar, or `null` if none
 * qualifies (including: no BUDGET events at all, or every one has a null/sub-threshold percent). */
function mostRecentMaterialBudgetChange(
  events: readonly BudgetChangeCandidate[],
  thresholdPercent: number,
): BudgetChangeCandidate | null {
  let best: BudgetChangeCandidate | null = null;
  for (const e of events) {
    if (e.percent === null || Math.abs(e.percent) < thresholdPercent) continue;
    if (!best || e.detectedAt.getTime() > best.detectedAt.getTime()) best = e;
  }
  return best;
}

function laterDay(a: ReportingDay, b: ReportingDay): ReportingDay {
  return a > b ? a : b; // YYYY-MM-DD strings sort lexicographically == chronologically
}

export function computeLearningPhaseFeatures(input: LearningPhaseInput): LearningPhaseFeatures {
  const materialThreshold =
    input.materialBudgetChangeThresholdPercent ?? MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT;
  const conversionsThreshold = input.conversionsThreshold ?? LEARNING_PHASE_CONVERSION_THRESHOLD;
  const windowDays = input.windowDays ?? LEARNING_PHASE_WINDOW_DAYS;

  const lastMaterialChange = mostRecentMaterialBudgetChange(input.budgetEvents, materialThreshold);

  // The window conversions are counted over: the later of (a) a plain trailing N-day rolling
  // window, and (b) "since the last reset" (a material edit more recent than N days ago, or —
  // absent any reset ever — the entity's own creation day, so a brand-new ad set with a handful
  // of days of history isn't scored against days that didn't exist).
  const rollingWindowStart = addCalendarDays(input.asOfDay, -(windowDays - 1));
  const resetFloorDay = lastMaterialChange?.detectedDay ?? input.entityCreatedDay;
  const windowStartDay = laterDay(resetFloorDay, rollingWindowStart);

  let conversions = 0;
  for (const [day, purchases] of input.purchasesByDay) {
    if (day >= windowStartDay && day <= input.asOfDay) conversions += purchases;
  }

  const inLearningPhase = conversions < conversionsThreshold;
  const conversionsToExitLearning = Math.max(0, conversionsThreshold - conversions);

  const out: LearningPhaseFeatures = { inLearningPhase, conversionsToExitLearning };
  if (lastMaterialChange) {
    out.learningResetAt = lastMaterialChange.detectedAt;
    out.learningResetCause =
      (lastMaterialChange.percent ?? 0) >= 0
        ? `MATERIAL_BUDGET_INCREASE:${lastMaterialChange.percent}%`
        : `MATERIAL_BUDGET_DECREASE:${lastMaterialChange.percent}%`;
  }
  return out;
}
