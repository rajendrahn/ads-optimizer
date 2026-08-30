// The settings/{accountId} loader — cached and validated, per A3's Deliverables.
//
// §5: "Three global settings that must be fixed before any data is stored, because they
// cannot be retrofitted without a rebuild." IMPLEMENTATION_PLAN.md's notes for this step are
// explicit: "Make the loader throw on absence rather than defaulting — a silent default here
// corrupts every stored record." So this module has exactly one success path (the document
// exists and validates) and two failure paths (missing, invalid), both of which throw rather
// than substituting any default value — there is no sane default for a reporting timezone or
// an attribution window, and pretending there is one would corrupt every record it touches.
//
// "Cached" here means "loaded once per process and never re-read" — the canon is a write-once
// value (A3's Out of scope: "Changing the canon at runtime — treat these as write-once
// values"), so re-fetching it on every call would be wasted work at best and, if the document
// were ever edited live, a way for two calls in the same process to silently disagree.

import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "../firestore/client.ts";
import { COLLECTIONS } from "../firestore/collections.ts";
import { createRepository } from "../firestore/repository.ts";
import { META_AD_ACCOUNT_ID } from "../../scripts/config.ts";
import { canonSettingsSchema, type CanonSettings } from "./settings.ts";

export interface LoadReportingCanonOptions {
  /** Defaults to the lazy singleton Admin SDK client (`getDb()`). */
  db?: Firestore;
  /** Defaults to the account's own Meta ad account ID — §8: "one brand, one ad account", and
   *  A2's key convention for settings/{accountId} uses that real ID, not a magic singleton. */
  accountId?: string;
}

// Cached by accountId (not just a single value) so a test — or, in principle, a future
// multi-account deployment — can load more than one account's canon in the same process
// without them colliding. Keyed on the settled Promise so concurrent callers before the first
// resolution share one Firestore round trip rather than each starting their own; a REJECTED
// load is intentionally NOT cached (see loadReportingCanon below) so a transient failure (e.g.
// the emulator not yet up) can be retried instead of poisoning the process forever.
const cache = new Map<string, Promise<CanonSettings>>();

async function fetchAndValidate(db: Firestore, accountId: string): Promise<CanonSettings> {
  const repo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);

  let doc: CanonSettings | null;
  try {
    // repo.get() runs the stored document through canonSettingsSchema.parse() on the way out
    // (shared/firestore/repository.ts's Firestore converter) — an existing-but-invalid
    // document throws right here, satisfying "throw on ... invalid value" without extra code.
    doc = await repo.get(accountId);
  } catch (cause) {
    throw new Error(
      `loadReportingCanon: settings/${accountId} exists but failed validation — the reporting ` +
        `canon (§5) must be fixed and correct before any data is stored; a partially-valid ` +
        `document is not usable. See the cause for the specific field(s).`,
      { cause },
    );
  }

  if (doc === null) {
    throw new Error(
      `loadReportingCanon: no settings/${accountId} document exists. §5: the reporting ` +
        `timezone, currency, attribution window and purchase action type "must be fixed ` +
        `before any data is stored, because they cannot be retrofitted without a rebuild." ` +
        `Create settings/${accountId} (see shared/canon/settings.ts for the required shape) ` +
        `before running any sync or normalization step.`,
    );
  }

  return doc;
}

/**
 * Loads, validates and caches the reporting canon for one account. Throws — never defaults —
 * if the document is missing or fails validation. Safe to call repeatedly and from multiple
 * call sites; after the first successful load, subsequent calls for the same `accountId`
 * return the cached value without another Firestore read.
 */
export function loadReportingCanon(
  options: LoadReportingCanonOptions = {},
): Promise<CanonSettings> {
  const db = options.db ?? getDb();
  const accountId = options.accountId ?? META_AD_ACCOUNT_ID;

  const cached = cache.get(accountId);
  if (cached) return cached;

  const pending = fetchAndValidate(db, accountId).catch((error: unknown) => {
    // Don't cache a failure — let the next call retry rather than being stuck forever with a
    // transient error (or a since-fixed missing document) from process start.
    cache.delete(accountId);
    throw error;
  });
  cache.set(accountId, pending);
  return pending;
}

/**
 * Test-only: clears the cache so a test can load a freshly-seeded fixture instead of whatever
 * a previous test's call cached. Production code must never call this — the whole point of
 * caching here is that the canon does not change mid-process (A3's Out of scope: "Changing the
 * canon at runtime").
 */
export function resetReportingCanonCacheForTests(): void {
  cache.clear();
}
