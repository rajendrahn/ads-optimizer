// Pure test of collectionRef's Firestore converter — the part of the repository layer that
// doesn't need a real Firestore instance to exercise. get/set/query themselves are thin
// wrappers around the Admin SDK's own query API and are proven end-to-end in
// shared/firestore/versionGuard.emulator.test.ts's sibling coverage and, more directly, by
// whichever B-phase step first writes through a repository against the real emulator.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Firestore } from "firebase-admin/firestore";
import { collectionRef } from "./repository.ts";

const widgetSchema = z.object({ id: z.string(), count: z.number().int() });

interface CapturedConverter {
  toFirestore(model: unknown): unknown;
  fromFirestore(snapshot: unknown): unknown;
}

function fakeDbCapturingConverter(): { db: Firestore; getConverter: () => CapturedConverter } {
  let captured: CapturedConverter | undefined;
  const fakeCollection = {
    withConverter(converter: CapturedConverter) {
      captured = converter;
      return this;
    },
  };
  const fakeDb = {
    collection: () => fakeCollection,
  };
  return {
    db: fakeDb as unknown as Firestore,
    getConverter: () => {
      if (!captured) throw new Error("withConverter was never called");
      return captured;
    },
  };
}

describe("collectionRef's converter", () => {
  it("toFirestore validates the model against the schema before Firestore ever sees it", () => {
    const { db, getConverter } = fakeDbCapturingConverter();
    collectionRef(db, "widgets", widgetSchema);
    const converter = getConverter();

    expect(converter.toFirestore({ id: "w1", count: 3 })).toEqual({ id: "w1", count: 3 });
    expect(() => converter.toFirestore({ id: "w1", count: "not a number" })).toThrow();
  });

  it("fromFirestore validates whatever comes back out of a document snapshot", () => {
    const { db, getConverter } = fakeDbCapturingConverter();
    collectionRef(db, "widgets", widgetSchema);
    const converter = getConverter();

    const validSnap = { data: () => ({ id: "w1", count: 3 }) };
    expect(converter.fromFirestore(validSnap)).toEqual({ id: "w1", count: 3 });

    const invalidSnap = { data: () => ({ id: "w1", count: "not a number" }) };
    expect(() => converter.fromFirestore(invalidSnap)).toThrow();
  });
});
