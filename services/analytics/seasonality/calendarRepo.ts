// Reads `seasonalCalendarWindows` — the calendar-as-data table (shared/schema/seasonality.ts).
//
// **How an operator corrects a festive date without a deploy.** The seed data in calendarSeed.ts
// is only ever a *starting point*, written once by seedTask.ts via `upsertWithVersionGuard`. The
// live source of truth after that is the Firestore document itself. To fix a wrong date (e.g. a
// year's Navratri window was mis-estimated), an operator edits (or replaces) the
// `seasonalCalendarWindows/{label}_{startDay}` document directly — via the Firestore console, an
// admin script, or any tool with write access to that one collection — and the change is live on
// the next read, no deploy, no code change. `loadSeasonalCalendarWindows` below deliberately does
// NOT cache across calls the way `loadReportingCanon` does (A3's canon is explicitly a
// write-once value; this calendar is explicitly the opposite — a table meant to be corrected
// live), so an operator's edit is visible immediately to the next `seasonalityContextFor` call.
//
// One nuance worth stating plainly: `seedSeasonalCalendarHandler` (seedTask.ts) is
// version-guarded (§9.5) against the SAME `sourceUpdatedAt` it wrote last time, so re-running the
// seed task (e.g. because calendarSeed.ts gained a new year's entries) is idempotent for
// unchanged entries and safely additive for new ones. If an operator's manual Firestore edit does
// not also bump that document's `sourceUpdatedAt` to something newer, a *future reseed of that
// exact (label, startDay) doc* could overwrite the manual correction — the correction itself is
// never blocked or delayed (a direct Firestore write always takes effect immediately), only a
// *subsequent reseed* could clobber it later. The safe correction procedure — and what this
// module comment tells an operator to do — is: either edit `startDay`/`endDay` on the existing
// document AND set `sourceUpdatedAt` to now, or delete the seed doc and create a new one at the
// corrected `{label}_{startDay}` key entirely (the more common case, since correcting a lunar
// date usually changes the key itself).

import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "@shared/firestore/client.ts";
import { COLLECTIONS } from "@shared/firestore/collections.ts";
import { createRepository } from "@shared/firestore/repository.ts";
import { seasonalCalendarWindowSchema, type SeasonalCalendarWindow } from "@shared/schema/index.ts";

export interface LoadSeasonalCalendarWindowsOptions {
  db?: Firestore;
}

/**
 * Reads every seasonal calendar window document. Deliberately uncached (unlike A3's
 * `loadReportingCanon`) — see module comment for why: this table is meant to be corrected live.
 * The collection is small (tens of documents even seeded for several years, per calendarSeed.ts),
 * so reading it in full on every call is cheap; a caller doing many `seasonalityContextFor` calls
 * in one batch (e.g. D2 building several packets) may want to load once and reuse the array
 * rather than calling this per window — `seasonalityContextFor`'s own options accept a
 * pre-loaded list for exactly that reason.
 */
export async function loadSeasonalCalendarWindows(
  options: LoadSeasonalCalendarWindowsOptions = {},
): Promise<SeasonalCalendarWindow[]> {
  const db = options.db ?? getDb();
  const repo = createRepository<SeasonalCalendarWindow>(
    db,
    COLLECTIONS.seasonalCalendarWindows,
    seasonalCalendarWindowSchema,
  );
  return repo.query((ref) => ref);
}
