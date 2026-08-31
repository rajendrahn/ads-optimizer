// Whether §13's change-aware features (already computed by C4) amount to a "recent major
// change" for §14's evidence object. One function, reused by both the eligibility gate
// (RECENT_MAJOR_CHANGE) and the evidence's own `recentChanges.recentMajorChanges` field, so the
// two never silently disagree about what counts.

import type { ChangeAwareFeatures } from "@shared/schema/index.ts";

/** §13 has no `statusChangesLastNDays` counter to reuse (C4's own notes: only
 * `hoursSinceLastStatusChange` exists for STATUS) — this is D1's own conservative window for "a
 * status flip happened very recently", not a value carried over from an earlier step. */
export const RECENT_STATUS_CHANGE_WINDOW_HOURS = 72;

const RECENT_AUDIENCE_CHANGE_WINDOW_HOURS = 14 * 24; // matches §13's own targetingChangesLast14Days

export function computeRecentMajorChanges(changeAware: ChangeAwareFeatures | undefined): boolean {
  const c = changeAware ?? {};
  return (
    (c.budgetChangesLast7Days ?? 0) > 0 ||
    (c.creativeChangesLast7Days ?? 0) > 0 ||
    (c.hoursSinceLastAudienceChange !== undefined &&
      c.hoursSinceLastAudienceChange < RECENT_AUDIENCE_CHANGE_WINDOW_HOURS) ||
    (c.hoursSinceLastStatusChange !== undefined &&
      c.hoursSinceLastStatusChange < RECENT_STATUS_CHANGE_WINDOW_HOURS)
  );
}
