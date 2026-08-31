// §13 — the `hoursSince…` / `…ChangesLastNDays` family, derived from B4's `metaChangeEvents`.
// Pure: takes the change events already belonging to ONE entity (any field, any time range —
// filtering to one entity is the caller's job, e.g. enrichChangeFeaturesTask.ts's in-memory
// grouping) and a reference instant, returns the §13 sub-object. No Firestore/Meta call here.
//
// Field-presence convention, matching C2's own null-vs-omitted-vs-zero discipline
// (shared/schema/features.ts's own comments): `changeAwareFeatures` is `.partial()`, so every
// field may be omitted, but none may be `null` (the schema types them as plain `z.number()`).
// "This kind of change has never happened for this entity" is therefore modelled by OMITTING the
// `hoursSinceLast*`/`lastBudgetChangePercent` field entirely — there is no honest finite number
// for "hours since an event that never occurred." The `…ChangesLastNDays` counters, by contrast,
// are always populated (real, measured zero counts, not "unknown") — the same distinction C2
// draws between "unmeasured" (null/omitted) and "measured zero" throughout §12.

import type { ChangeAwareFeatures, MetaChangeEvent } from "@shared/schema/index.ts";
import { RECENT_CHANGE_WINDOW_DAYS } from "./constants.ts";

export interface ChangeAwareInput {
  /** Every metaChangeEvents row for exactly one (entityType, entityId) — any `field`, any age. */
  events: readonly MetaChangeEvent[];
  /** The instant "now" is measured from — pass the task run's own `computedAt`, never a stale
   * cached value, so `hoursSinceLast*` reflects real elapsed time at write time. */
  asOf: Date;
  budgetWindowDays?: number;
  targetingWindowDays?: number;
  creativeWindowDays?: number;
}

function hoursSince(detectedAt: Date, asOf: Date): number {
  const hours = (asOf.getTime() - detectedAt.getTime()) / 3_600_000;
  return Math.round(hours * 100) / 100;
}

function mostRecent(events: readonly MetaChangeEvent[]): MetaChangeEvent | null {
  let best: MetaChangeEvent | null = null;
  for (const e of events) {
    if (!best || e.detectedAt.getTime() > best.detectedAt.getTime()) best = e;
  }
  return best;
}

function countWithinDays(events: readonly MetaChangeEvent[], asOf: Date, days: number): number {
  const cutoff = asOf.getTime() - days * 86_400_000;
  return events.filter(
    (e) => e.detectedAt.getTime() >= cutoff && e.detectedAt.getTime() <= asOf.getTime(),
  ).length;
}

export function computeChangeAwareFeatures(input: ChangeAwareInput): ChangeAwareFeatures {
  const budgetWindowDays = input.budgetWindowDays ?? RECENT_CHANGE_WINDOW_DAYS.budget;
  const targetingWindowDays = input.targetingWindowDays ?? RECENT_CHANGE_WINDOW_DAYS.targeting;
  const creativeWindowDays = input.creativeWindowDays ?? RECENT_CHANGE_WINDOW_DAYS.creative;

  const out: ChangeAwareFeatures = {};

  // BUDGET
  const budgetEvents = input.events.filter((e) => e.field === "BUDGET");
  const lastBudget = mostRecent(budgetEvents);
  if (lastBudget) {
    out.hoursSinceLastBudgetChange = hoursSince(lastBudget.detectedAt, input.asOf);
    // B4: budgetChangePercent may be null even for a real BUDGET event (no computable base) —
    // omit rather than fabricate a percent.
    if (lastBudget.budgetChangePercent !== null) {
      out.lastBudgetChangePercent = lastBudget.budgetChangePercent;
    }
  }
  out.budgetChangesLast7Days = countWithinDays(budgetEvents, input.asOf, budgetWindowDays);

  // TARGETING (§13 names this "audience")
  const targetingEvents = input.events.filter((e) => e.field === "TARGETING");
  const lastTargeting = mostRecent(targetingEvents);
  if (lastTargeting) {
    out.hoursSinceLastAudienceChange = hoursSince(lastTargeting.detectedAt, input.asOf);
  }
  out.targetingChangesLast14Days = countWithinDays(
    targetingEvents,
    input.asOf,
    targetingWindowDays,
  );

  // CREATIVE_ASSIGNMENT
  const creativeEvents = input.events.filter((e) => e.field === "CREATIVE_ASSIGNMENT");
  const lastCreative = mostRecent(creativeEvents);
  if (lastCreative) {
    out.hoursSinceLastCreativeChange = hoursSince(lastCreative.detectedAt, input.asOf);
  }
  out.creativeChangesLast7Days = countWithinDays(creativeEvents, input.asOf, creativeWindowDays);

  // STATUS — §13 only asks for hoursSinceLastStatusChange, no "changes in last N days" counter.
  const statusEvents = input.events.filter((e) => e.field === "STATUS");
  const lastStatus = mostRecent(statusEvents);
  if (lastStatus) {
    out.hoursSinceLastStatusChange = hoursSince(lastStatus.detectedAt, input.asOf);
  }

  return out;
}
