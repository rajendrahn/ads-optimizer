// §10.1: "One monotonic accountDataVersion, bumped once per sync run." Deliberately NOT a new
// collection — `accountFeatures/{accountId}` already exists (it's one of the five entity levels
// RECOMPUTE_FEATURES writes every run) and already carries an `accountDataVersion` field on
// itself, so the previous run's own account-level doc IS the counter's storage. Reading it once
// at the start of a run and using `previous + 1` for every entity doc written that run satisfies
// "bumped once per sync run" without inventing a second collection whose only job would be
// holding one integer. First-ever run (no accountFeatures doc yet) starts at 1.
//
// Concurrency note: two RECOMPUTE_FEATURES runs racing each other could both read the same prior
// version and compute the same next one. §10.1 itself says this is an acceptable, low-risk
// tradeoff at this account's scale ("There is no write contention at one bump per run") — the
// per-document version guard (recomputeFeaturesTask.ts writes through
// `upsertWithVersionGuard` keyed on `computedAt`) still protects each individual document from a
// stale/late-finishing run clobbering a fresher one, which is the property that actually matters.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { accountFeaturesSchema, type EntityFeatures } from "@shared/schema/index.ts";

export async function readNextAccountDataVersion(
  db: Firestore,
  accountId: string,
): Promise<number> {
  const repo = createRepository<EntityFeatures>(
    db,
    COLLECTIONS.accountFeatures,
    accountFeaturesSchema,
  );
  const previous = await repo.get(accountId);
  return (previous?.accountDataVersion ?? 0) + 1;
}
