// End-to-end coverage of upsertWithVersionGuard against a real (emulated) Firestore —
// in-order, out-of-order and equal-version writes, plus the logging of refusals, this time
// through an actual transaction rather than the fake used in versionGuard.test.ts.
//
// Requires the Firestore emulator (a JVM on PATH) — run via `npm run test:integration`,
// which wraps this in `firebase emulators:exec` and sets FIRESTORE_EMULATOR_HOST. Not part
// of `npm run check`.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { firestoreTimestamp } from "../schema/common.ts";
import { upsertWithVersionGuard } from "./versionGuard.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "versionGuard.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`, not `vitest run` directly.",
  );
}

if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const T1 = new Date("2026-08-27T00:00:00.000Z");
const T2 = new Date("2026-08-28T00:00:00.000Z");

// Real Firestore returns a `Timestamp`, not a `Date`, from a document snapshot — this is
// exactly what shared/schema/common.ts's `firestoreTimestamp` normalizes. The fake in
// versionGuard.test.ts stores plain objects and never round-trips through real Firestore, so
// a bare `z.date()` was fine there; here it is not — using it caught this for real.
const testDocSchema = z.object({
  id: z.string(),
  value: z.number(),
  sourceUpdatedAt: firestoreTimestamp,
});
type TestDoc = z.infer<typeof testDocSchema>;

const COLLECTION = "versionGuardEmulatorTest";

async function readRaw(docId: string) {
  const snap = await db.collection(COLLECTION).doc(docId).get();
  return snap.exists ? snap.data() : undefined;
}

beforeEach(async () => {
  // Best-effort cleanup between tests; each test also uses a fresh doc ID as a belt-and-braces.
  const snaps = await db.collection(COLLECTION).listDocuments();
  await Promise.all(snaps.map((ref) => ref.delete()));
});

afterAll(async () => {
  const snaps = await db.collection(COLLECTION).listDocuments();
  await Promise.all(snaps.map((ref) => ref.delete()));
});

describe("upsertWithVersionGuard (emulator)", () => {
  it("in-order: accepts the initial write, then a strictly newer one", async () => {
    const docId = "doc-in-order";
    const first = await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 1, sourceUpdatedAt: T1 },
      schema: testDocSchema,
    });
    expect(first).toMatchObject({ action: "written", comparison: "no-existing-doc" });

    const second = await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 2, sourceUpdatedAt: T2 },
      schema: testDocSchema,
    });
    expect(second).toMatchObject({ action: "written", comparison: "newer" });

    const stored = await readRaw(docId);
    expect(stored).toMatchObject({ value: 2 });
  });

  it("out-of-order: rejects an older write, leaves the stored document unchanged, and logs the refusal", async () => {
    const docId = "doc-out-of-order";
    await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 2, sourceUpdatedAt: T2 },
      schema: testDocSchema,
    });

    const onRejected = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const outcome = await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 1, sourceUpdatedAt: T1 },
      schema: testDocSchema,
      onRejected,
    });

    expect(outcome.action).toBe("rejected");
    if (outcome.action === "rejected") {
      expect(outcome.rejection.currentUpdatedAt.getTime()).toBe(T2.getTime());
      expect(outcome.rejection.incomingUpdatedAt.getTime()).toBe(T1.getTime());
    }
    expect(onRejected).toHaveBeenCalledTimes(1);
    // §9.5: "log the rejection ... so ordering problems stay observable" — the default,
    // unconditional console.warn this module provides regardless of the onRejected hook.
    expect(warnSpy).toHaveBeenCalledWith(
      "[versionGuard] rejected an out-of-order write",
      expect.objectContaining({ docId }),
    );
    warnSpy.mockRestore();

    const stored = await readRaw(docId);
    expect(stored).toMatchObject({ value: 2 }); // unchanged — the older write never landed
  });

  it("equal-version: accepts a same-timestamp write as an idempotent retry", async () => {
    const docId = "doc-equal";
    await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 1, sourceUpdatedAt: T1 },
      schema: testDocSchema,
    });

    const onRejected = vi.fn();
    const outcome = await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 1, sourceUpdatedAt: new Date(T1.getTime()) },
      schema: testDocSchema,
      onRejected,
    });

    expect(outcome).toMatchObject({ action: "written", comparison: "equal" });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("two concurrent writers racing the same doc: exactly one outcome wins per version rule", async () => {
    const docId = "doc-race";
    await upsertWithVersionGuard<TestDoc>({
      db,
      collectionName: COLLECTION,
      docId,
      incoming: { id: docId, value: 0, sourceUpdatedAt: new Date("2026-08-01T00:00:00.000Z") },
      schema: testDocSchema,
    });

    const [a, b] = await Promise.all([
      upsertWithVersionGuard<TestDoc>({
        db,
        collectionName: COLLECTION,
        docId,
        incoming: { id: docId, value: 10, sourceUpdatedAt: T1 },
        schema: testDocSchema,
      }),
      upsertWithVersionGuard<TestDoc>({
        db,
        collectionName: COLLECTION,
        docId,
        incoming: { id: docId, value: 20, sourceUpdatedAt: T2 },
        schema: testDocSchema,
      }),
    ]);

    // Both incoming versions (T1, T2) are newer than the seed (2026-08-01), so whichever of
    // the two transactions COMMITS FIRST is unconditionally accepted. The other one's
    // Firestore transaction is then automatically retried against the post-commit state:
    //   - if T1 commits first, T2's retry compares T2 > T1 → accepted too.
    //   - if T2 commits first, T1's retry compares T1 < T2 → correctly rejected.
    // So which one of {a, b} individually lands as "written" vs "rejected" is a genuine race
    // and not asserted here. What IS guaranteed regardless of ordering: the strictly-highest
    // version (T2/b) is never rejected — nothing in this test is ever newer than it — and the
    // document that survives is always the highest version, never overwritten by the lower one.
    expect(b.action).toBe("written");
    expect(["written", "rejected"]).toContain(a.action);
    const stored = await readRaw(docId);
    expect(stored).toMatchObject({ value: 20 });
  });
});
