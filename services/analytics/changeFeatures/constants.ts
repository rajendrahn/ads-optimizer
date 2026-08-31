// C4's own tunables — §13/§13.1. Every number here is a documented assumption, not something
// verified against a live Meta API response this session (no live/mutating call was made — see
// IMPLEMENTATION_PLAN.md C4's "Notes from implementation"). Exported as named constants
// specifically so a future step can override them from `settings/` without touching this
// module's logic, mirroring C3's own "configurable purchase floor" convention (§15.1).

/**
 * §13.1, verbatim from the design doc: "Meta's learning phase exits at roughly 50 conversions
 * per week per ad set." This is the design document's own figure (itself Meta's publicly stated
 * approximate rule of thumb — "50 optimization events in a 7-day window"), not independently
 * re-verified against Meta's API or documentation this session.
 */
export const LEARNING_PHASE_CONVERSION_THRESHOLD = 50;

/** The rolling window (in days) over which conversions are counted toward the threshold above —
 * Meta's own description of the mechanic is "50 conversions within 7 days," a rolling window,
 * not a lifetime cumulative count. This is why an ad set that never clears ~50/week can sit in
 * learning phase indefinitely (§13.1's own point) rather than eventually accumulating its way
 * out. ASSUMPTION: a plain 7-calendar-day rolling window is the simplest model consistent with
 * both the design doc's wording and Meta's own public description; Meta's real internal
 * accounting may differ in ways this account has no way to observe (Meta does not expose a
 * learning-phase-state API field this system reads from — see B2/B3's notes, no such field is
 * fetched). Not independently verified.
 */
export const LEARNING_PHASE_WINDOW_DAYS = 7;

/**
 * The budget-change magnitude (absolute percent) that counts as "material" enough to restart
 * the learning-phase clock — §13.1: "any material budget edit restarts the clock." The design
 * document does not give a number. ASSUMPTION, not verified live this session: 20% is Meta's own
 * commonly cited "significant edit" threshold for ad-set delivery (budget/bid changes beyond
 * roughly this magnitude are described by Meta as able to trigger renewed learning). Deliberately
 * a single named constant, not buried in logic, so it can be corrected the moment a more
 * authoritative source is available without touching computeLearningPhaseFeatures itself.
 */
export const MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT = 20;

/** §13's own field names imply their own lookback windows (`budgetChangesLast7Days`,
 * `targetingChangesLast14Days`, `creativeChangesLast7Days`) — these are read directly from those
 * names, not assumed. */
export const RECENT_CHANGE_WINDOW_DAYS = {
  budget: 7,
  targeting: 14,
  creative: 7,
} as const;
