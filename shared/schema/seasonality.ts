// C5's own collection — NOT one of §8's originally named collections, added for the same reason
// C1 added `metaInsightsDailyNormalized` etc. (see shared/schema/analytics.ts's module comment):
// a genuinely new artifact this step introduces, not a namespace violation.
//
// IMPLEMENTATION_PLAN.md C5 (added to the plan by the user, not derived from the design
// document — see that step's own header): "A `calendar/` collection or settings-backed table
// mapping reporting days to seasonal labels ... Store it as data, not code, so the dates (which
// move every year on the lunar calendar) can be corrected without a deploy."
//
// This is a *range table*, not one document per calendar day. A festive window is a contiguous
// span of reporting days sharing one label (e.g. "diwali" 2025-10-19..2025-10-23) — storing one
// document per occurrence, not per day, is what makes "corrected without a deploy" practical: an
// operator fixing a mis-estimated Diwali date edits ONE document's startDay/endDay, not twenty
// individual day documents. See services/analytics/seasonality/calendarRepo.ts's module comment
// for exactly how an operator corrects a date in production, and calendarSeed.ts for the seeded
// data itself and its sources.
//
// A day carrying no label is "off-season" by omission — there is no stored row for that regime,
// matching this step's own "off-season default" deliverable literally: the default is the
// absence of a row, not a row that says "off-season".

import { z } from "zod";
import { firestoreTimestamp, reportingDay } from "./common.ts";

/**
 * One occurrence of one named seasonal window (e.g. "Diwali 2025"). `label` is a plain string,
 * not a `z.enum(...)` — deliberately, mirroring `syncRunSchema.taskType` (A2) and
 * `modelConfigSchema.effort` (A3): a new label (or a finer subdivision of an existing one) is
 * data an operator adds, never a schema change or a deploy. `startDay`/`endDay` are both
 * inclusive. Multiple windows may legitimately overlap (e.g. "wedding_season" and "dhanteras"
 * covering the same days) — `seasonalityContextFor` returns every label a window overlaps, not
 * just one.
 */
export const seasonalCalendarWindowSchema = z.object({
  label: z.string().min(1),
  startDay: reportingDay,
  endDay: reportingDay,
  /** Informational — the calendar year this occurrence primarily belongs to. Not used for any
   *  lookup; `startDay`/`endDay` are the only fields overlap math reads. */
  year: z.number().int(),
  /** Whether every day in [startDay, endDay] is independently confirmed against a cited source,
   *  or whether some part of the range was derived by calendar convention (e.g. "the day before
   *  a confirmed festival day, when pre-festival shopping typically starts"). See `notes` for
   *  which. Never hidden — this is exactly the kind of uncertainty that must travel with the
   *  data, not be smoothed over. */
  confidence: z.enum(["confirmed", "estimated"]),
  /** Where this date came from — a citation, not a code comment, so it survives being read back
   *  out of Firestore by whoever corrects it later. */
  source: z.string().min(1),
  notes: z.string().nullable(),
  /** Version-guard field (§9.5, shared/firestore/versionGuard.ts) — see
   *  services/analytics/seasonality/calendarRepo.ts's module comment for what this means for a
   *  seeded (not synced) collection and how an operator's manual correction interacts with it. */
  sourceUpdatedAt: firestoreTimestamp,
  computedAt: firestoreTimestamp,
});
export type SeasonalCalendarWindow = z.infer<typeof seasonalCalendarWindowSchema>;
