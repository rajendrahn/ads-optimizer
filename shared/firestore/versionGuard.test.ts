// Thorough coverage of the monotonic-version upsert helper (§9.5) — the single most reused
// primitive in Phase B. Two layers:
//
//  1. Pure decision logic (`compareVersions` / `decideVersionGuard`) — the in-order,
//     out-of-order and equal-version matrix, fully exercised with plain Dates.
//  2. `upsertWithVersionGuard` wired against a hand-rolled fake that implements just the
//     `VersionGuardFirestoreLike` / `VersionGuardTransactionLike` shape — proving the
//     transaction wiring, the write vs. reject branching, and the exactly-once `onRejected`
//     call, all without needing firebase-admin or a running emulator.
//
// shared/firestore/versionGuard.emulator.test.ts covers the same behaviour end-to-end
// against a real (emulated) Firestore, once a JVM is available.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  compareVersions,
  decideVersionGuard,
  upsertWithVersionGuard,
  type VersionGuardFirestoreLike,
  type VersionGuardTransactionLike,
} from "./versionGuard.ts";

const T1 = new Date("2026-08-27T00:00:00.000Z");
const T2 = new Date("2026-08-28T00:00:00.000Z");

describe("compareVersions (pure)", () => {
  it("no existing doc", () => {
    expect(compareVersions(T2, undefined)).toBe("no-existing-doc");
  });
  it("in-order: incoming is newer", () => {
    expect(compareVersions(T2, T1)).toBe("newer");
  });
  it("out-of-order: incoming is older", () => {
    expect(compareVersions(T1, T2)).toBe("older");
  });
  it("equal version", () => {
    expect(compareVersions(T1, new Date(T1.getTime()))).toBe("equal");
  });
});

describe("decideVersionGuard (pure)", () => {
  it("writes on no existing doc, newer, and equal — rejects only on older", () => {
    expect(decideVersionGuard(T2, undefined)).toEqual({
      comparison: "no-existing-doc",
      action: "write",
    });
    expect(decideVersionGuard(T2, T1)).toEqual({ comparison: "newer", action: "write" });
    expect(decideVersionGuard(T1, new Date(T1.getTime()))).toEqual({
      comparison: "equal",
      action: "write",
    });
    expect(decideVersionGuard(T1, T2)).toEqual({ comparison: "older", action: "reject" });
  });
});

// ---------------------------------------------------------------------------------------
// Fake Firestore — just enough of collection().doc() / runTransaction(tx => {get, set}) to
// exercise upsertWithVersionGuard's own logic, independent of the real SDK.
// ---------------------------------------------------------------------------------------

class FakeDocRef {
  constructor(
    public readonly collectionName: string,
    public readonly id: string,
  ) {}
}

class FakeFirestore implements VersionGuardFirestoreLike {
  readonly store = new Map<string, unknown>();

  collection(name: string) {
    return { doc: (id: string) => new FakeDocRef(name, id) };
  }

  async runTransaction<R>(updateFn: (tx: VersionGuardTransactionLike) => Promise<R>): Promise<R> {
    const key = (ref: unknown) => {
      const r = ref as FakeDocRef;
      return `${r.collectionName}/${r.id}`;
    };
    const tx: VersionGuardTransactionLike = {
      get: async (ref: unknown) => {
        const k = key(ref);
        return { exists: this.store.has(k), data: () => this.store.get(k) };
      },
      set: (ref: unknown, data: unknown) => {
        this.store.set(key(ref), data);
      },
    };
    return updateFn(tx);
  }
}

const testDocSchema = z.object({
  id: z.string(),
  value: z.number(),
  sourceUpdatedAt: z.date(),
});
type TestDoc = z.infer<typeof testDocSchema>;

function upsert(
  db: FakeFirestore,
  docId: string,
  incoming: TestDoc,
  onRejected?: (r: unknown) => void,
) {
  return upsertWithVersionGuard<TestDoc>({
    db,
    collectionName: "testDocs",
    docId,
    incoming,
    schema: testDocSchema,
    onRejected,
  });
}

describe("upsertWithVersionGuard — wiring", () => {
  it("in-order: an initial write (no existing doc) is accepted", async () => {
    const db = new FakeFirestore();
    const outcome = await upsert(db, "doc1", { id: "doc1", value: 1, sourceUpdatedAt: T1 });
    expect(outcome).toMatchObject({ action: "written", comparison: "no-existing-doc" });
    expect(db.store.get("testDocs/doc1")).toMatchObject({ value: 1 });
  });

  it("in-order: a strictly newer write is accepted and overwrites", async () => {
    const db = new FakeFirestore();
    await upsert(db, "doc1", { id: "doc1", value: 1, sourceUpdatedAt: T1 });
    const outcome = await upsert(db, "doc1", { id: "doc1", value: 2, sourceUpdatedAt: T2 });
    expect(outcome).toMatchObject({ action: "written", comparison: "newer" });
    expect(db.store.get("testDocs/doc1")).toMatchObject({ value: 2 });
  });

  it("out-of-order: an older write is rejected and the stored document is unchanged", async () => {
    const db = new FakeFirestore();
    await upsert(db, "doc1", { id: "doc1", value: 2, sourceUpdatedAt: T2 });
    const onRejected = vi.fn();
    const outcome = await upsert(
      db,
      "doc1",
      { id: "doc1", value: 1, sourceUpdatedAt: T1 },
      onRejected,
    );

    expect(outcome.action).toBe("rejected");
    if (outcome.action === "rejected") {
      expect(outcome.comparison).toBe("older");
      expect(outcome.rejection).toMatchObject({
        collection: "testDocs",
        docId: "doc1",
        incomingUpdatedAt: T1,
        currentUpdatedAt: T2,
      });
    }
    // The stale write must not have touched the stored document.
    expect(db.store.get("testDocs/doc1")).toMatchObject({ value: 2 });
    // The rejection hook fires exactly once, with the rejection payload.
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "testDocs", docId: "doc1" }),
    );
  });

  it("equal-version: an equal-timestamp write is accepted (idempotent retry), not rejected", async () => {
    const db = new FakeFirestore();
    await upsert(db, "doc1", { id: "doc1", value: 1, sourceUpdatedAt: T1 });
    const onRejected = vi.fn();
    const outcome = await upsert(
      db,
      "doc1",
      { id: "doc1", value: 1, sourceUpdatedAt: new Date(T1.getTime()) },
      onRejected,
    );

    expect(outcome).toMatchObject({ action: "written", comparison: "equal" });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("onRejected is never called on an accepted write", async () => {
    const db = new FakeFirestore();
    const onRejected = vi.fn();
    await upsert(db, "doc1", { id: "doc1", value: 1, sourceUpdatedAt: T1 }, onRejected);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("a malformed incoming document is rejected by schema validation before touching the store", async () => {
    const db = new FakeFirestore();
    await expect(
      upsertWithVersionGuard({
        db,
        collectionName: "testDocs",
        docId: "doc1",
        // @ts-expect-error deliberately malformed for the test
        incoming: { id: "doc1", value: "not a number", sourceUpdatedAt: T1 },
        schema: testDocSchema,
      }),
    ).rejects.toThrow();
    expect(db.store.size).toBe(0);
  });

  it("a document with no sourceUpdatedAt field throws a clear error unless getUpdatedAt is supplied", async () => {
    const db = new FakeFirestore();
    const looseSchema = z.object({ id: z.string(), when: z.date() });
    await expect(
      upsertWithVersionGuard({
        db,
        collectionName: "loose",
        docId: "doc1",
        incoming: { id: "doc1", when: T1 },
        schema: looseSchema,
      }),
    ).rejects.toThrow(/sourceUpdatedAt/);

    // Supplying getUpdatedAt works around it.
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: "loose",
      docId: "doc1",
      incoming: { id: "doc1", when: T1 },
      schema: looseSchema,
      getUpdatedAt: (doc) => doc.when,
    });
    expect(outcome.action).toBe("written");
  });
});
