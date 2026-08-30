// The monotonic-version upsert helper — §9.5.
//
// "Revision 1 said upserts should 'replace the latest representation'. That is unsafe for
// Shopify, whose webhooks are at-least-once and unordered — a refund webhook can arrive
// before the order update it follows, and blind replacement lets a stale payload overwrite
// fresher data with a write that succeeds. Guard every upsert with a monotonic version
// compare on the source's own updated_at, rejecting writes that would move a record
// backwards, and log the rejection in syncRuns so ordering problems stay observable."
//
// This is the single most reused primitive in Phase B — every Shopify write (B5, B6) and
// every reconciled Meta insight (B3) goes through it.
//
// Ambiguity surfaced and resolved: §9.5's "source's own updated_at" is unambiguous for
// Shopify (the platform's own `updated_at` field on the order/line/refund). It is NOT
// something Meta's Insights API returns per row — a daily insight row is just numbers as of
// whenever it was fetched, with no intrinsic version of its own. For metaInsightsDaily, this
// implementation treats `sourceUpdatedAt` as *our own fetch/reconciliation-run timestamp*
// instead. That preserves the guarantee §9.5 actually cares about — a reconciliation task
// that finishes late (e.g. a slow retry racing a newer scheduled run) must not clobber
// numbers a more recent fetch already wrote — without inventing a Meta-provided field that
// doesn't exist. shared/schema/meta.ts's `metaInsightsDailySchema` comment repeats this.
//
// Design choice worth calling out: equal-version writes are ACCEPTED, not rejected. "Refuses
// writes that would move a record backwards" — equal isn't backwards. More importantly,
// every sync task must be idempotent (§10.2): a retried task that resubmits the exact same
// payload with the exact same source timestamp must succeed on retry, not fail. Rejecting
// equal-version writes would break that guarantee. Equal-version writes are still reported
// distinctly (`comparison: "equal"`) from strictly-newer ones so a caller — or a test — can
// tell the two apart.

import type { ZodType } from "zod";

// ---------------------------------------------------------------------------------------
// Pure decision core — no Firestore involved. This is what "in-order, out-of-order, and
// equal-version writes" actually means; fully unit-testable without an emulator.
// ---------------------------------------------------------------------------------------

export type VersionComparison = "no-existing-doc" | "newer" | "equal" | "older";

/** Compares an incoming source timestamp against what's currently stored, if anything. */
export function compareVersions(incoming: Date, current: Date | undefined): VersionComparison {
  if (current === undefined) return "no-existing-doc";
  const incomingMs = incoming.getTime();
  const currentMs = current.getTime();
  if (incomingMs > currentMs) return "newer";
  if (incomingMs === currentMs) return "equal";
  return "older";
}

export interface VersionGuardDecision {
  comparison: VersionComparison;
  action: "write" | "reject";
}

/** The full policy in one place: only "older" is rejected. See module comment for why. */
export function decideVersionGuard(
  incoming: Date,
  current: Date | undefined,
): VersionGuardDecision {
  const comparison = compareVersions(incoming, current);
  return { comparison, action: comparison === "older" ? "reject" : "write" };
}

// ---------------------------------------------------------------------------------------
// Firestore-backed upsert. Reads the current document and decides inside one transaction,
// so two concurrent writers (e.g. two webhook deliveries for the same order) can't both
// observe "no existing doc" and both write. `onRejected` is invoked exactly once, AFTER the
// transaction commits — never from inside the transaction body, which Firestore may retry
// on contention; calling a side effect there could otherwise fire more than once per
// logical rejection.
// ---------------------------------------------------------------------------------------

export interface VersionGuardRejection {
  collection: string;
  docId: string;
  reason: string;
  incomingUpdatedAt: Date;
  currentUpdatedAt: Date;
}

export type VersionGuardOutcome<T> =
  | { action: "written"; comparison: Exclude<VersionComparison, "older">; data: T }
  | { action: "rejected"; comparison: "older"; rejection: VersionGuardRejection };

/**
 * The narrowest slice of the Admin SDK this module actually calls — deliberately not
 * `Firestore` itself, so a hand-rolled fake can stand in for it in a unit test without
 * pulling in firebase-admin at all. A real `Firestore` instance satisfies this structurally;
 * no adapter needed at the call site.
 */
export interface VersionGuardFirestoreLike {
  collection(name: string): {
    doc(id: string): unknown;
  };
  runTransaction<R>(updateFn: (tx: VersionGuardTransactionLike) => Promise<R>): Promise<R>;
}

export interface VersionGuardTransactionLike {
  get(docRef: unknown): Promise<{ exists: boolean; data(): unknown }>;
  set(docRef: unknown, data: unknown): unknown;
}

export interface UpsertWithVersionGuardOptions<T> {
  /** A real `Firestore` from firebase-admin satisfies this structurally — no adapter needed. */
  db: VersionGuardFirestoreLike;
  collectionName: string;
  docId: string;
  incoming: T;
  schema: ZodType<T>;
  /** Defaults to reading `incoming.sourceUpdatedAt`, which every version-guarded schema in
   *  shared/schema exposes. Override for a document shape that names the field differently. */
  getUpdatedAt?: (doc: T) => Date;
  /** Called once, after the transaction settles, only when the write was rejected. */
  onRejected?: (rejection: VersionGuardRejection) => void | Promise<void>;
}

function defaultGetUpdatedAt<T>(doc: T): Date {
  const value = (doc as Record<string, unknown>).sourceUpdatedAt;
  if (!(value instanceof Date)) {
    throw new Error(
      "upsertWithVersionGuard: document has no Date `sourceUpdatedAt` field — pass getUpdatedAt explicitly",
    );
  }
  return value;
}

export async function upsertWithVersionGuard<T>(
  opts: UpsertWithVersionGuardOptions<T>,
): Promise<VersionGuardOutcome<T>> {
  const { db, collectionName, docId, schema, getUpdatedAt = defaultGetUpdatedAt } = opts;

  // Fail fast, before any Firestore round trip, on a malformed document.
  const validated = schema.parse(opts.incoming);
  const docRef = db.collection(collectionName).doc(docId);

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const current = snap.exists ? schema.parse(snap.data()) : undefined;
    const currentUpdatedAt = current === undefined ? undefined : getUpdatedAt(current);
    const incomingUpdatedAt = getUpdatedAt(validated);
    const decision = decideVersionGuard(incomingUpdatedAt, currentUpdatedAt);

    if (decision.action === "write") {
      tx.set(docRef, validated);
      return {
        action: "written" as const,
        comparison: decision.comparison as Exclude<VersionComparison, "older">,
        data: validated,
      };
    }

    // decision.action === "reject" only ever results from comparison === "older", which
    // compareVersions only returns when `current` (and so `currentUpdatedAt`) is defined —
    // "no-existing-doc" covers the undefined case. Narrow explicitly rather than asserting.
    if (currentUpdatedAt === undefined) {
      throw new Error(
        "unreachable: a rejected version-guard decision always has a current version",
      );
    }

    return {
      action: "rejected" as const,
      comparison: "older" as const,
      rejection: {
        collection: collectionName,
        docId,
        reason: `incoming sourceUpdatedAt ${incomingUpdatedAt.toISOString()} is older than stored ${currentUpdatedAt.toISOString()}`,
        incomingUpdatedAt,
        currentUpdatedAt,
      },
    };
  });

  if (outcome.action === "rejected") {
    // Always logged here, independent of the caller's onRejected hook — this is the
    // debuggable minimum until whichever step wires onRejected to actually write into
    // syncRuns (B1 owns that lifecycle; see shared/schema/sync.ts's
    // versionGuardRejectionLogEntrySchema for the shape this should become).
    console.warn("[versionGuard] rejected an out-of-order write", outcome.rejection);
    if (opts.onRejected) {
      await opts.onRejected(outcome.rejection);
    }
  }

  return outcome;
}
