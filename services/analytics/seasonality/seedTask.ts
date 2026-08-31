// SEED_SEASONAL_CALENDAR — writes calendarSeed.ts's entries into `seasonalCalendarWindows`
// through the real A2 version guard (§9.5), per this step's own safety constraint ("writes
// through A2's upsertWithVersionGuard"). Registered via B1's `createDefaultRegistry()`, matching
// every other derived/internal task type (C1's own NORMALIZE_META_INSIGHTS_DAILY/
// NORMALIZE_SHOPIFY_DAILY set the precedent this follows): `runSource: "internal"`,
// `syncStateTarget: null` — this is a Firestore-to-Firestore seed from data checked into the
// repo, not a live external sync, and has no watermark of its own.
//
// Every entry writes with the SAME fixed `sourceUpdatedAt`
// (`SEASONAL_CALENDAR_SEED_SOURCE_UPDATED_AT`, below) — the date this seed data was authored and
// its sources checked, not "now". That is what makes re-running this task idempotent for
// unchanged entries (equal-version writes are accepted, per versionGuard.ts's own documented
// policy) and safe to extend with new years later (bump calendarSeed.ts's entries AND this
// constant together, so the new run's timestamp is only ever newer than what it should be allowed
// to overwrite). See calendarRepo.ts's module comment for what this means for an operator's own
// manual correction of a seeded document.

import { getDb } from "@shared/firestore/client.ts";
import { COLLECTIONS, seasonalCalendarWindowKey } from "@shared/firestore/collections.ts";
import { upsertWithVersionGuard } from "@shared/firestore/versionGuard.ts";
import { seasonalCalendarWindowSchema, type SeasonalCalendarWindow } from "@shared/schema/index.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import { SEASONAL_CALENDAR_SEED_ENTRIES } from "./calendarSeed.ts";

/** The seed's own "as of" version — see module comment. Bump only when calendarSeed.ts's dates
 *  themselves are deliberately corrected, not on every deploy. */
export const SEASONAL_CALENDAR_SEED_SOURCE_UPDATED_AT = new Date("2026-08-31T00:00:00Z");

export const seedSeasonalCalendarHandler: TaskHandler = async (ctx) => {
  const db = getDb();
  const computedAt = new Date();

  let written = 0;
  let rejected = 0;
  for (const entry of SEASONAL_CALENDAR_SEED_ENTRIES) {
    const doc: SeasonalCalendarWindow = {
      label: entry.label,
      startDay: entry.startDay,
      endDay: entry.endDay,
      year: entry.year,
      confidence: entry.confidence,
      source: entry.source,
      notes: entry.notes,
      sourceUpdatedAt: SEASONAL_CALENDAR_SEED_SOURCE_UPDATED_AT,
      computedAt,
    };
    const docId = seasonalCalendarWindowKey(entry.label, entry.startDay);
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.seasonalCalendarWindows,
      docId,
      incoming: doc,
      schema: seasonalCalendarWindowSchema,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") written++;
    else rejected++;
  }

  return {
    newRowCount: written,
    summary: {
      entriesInSeedFile: SEASONAL_CALENDAR_SEED_ENTRIES.length,
      written,
      rejectedAsOlderThanAnOperatorCorrection: rejected,
    },
  };
};

export const seedSeasonalCalendarRegistration: TaskRegistration = {
  taskType: "SEED_SEASONAL_CALENDAR",
  runSource: "internal",
  syncStateTarget: null,
  handler: seedSeasonalCalendarHandler,
};
