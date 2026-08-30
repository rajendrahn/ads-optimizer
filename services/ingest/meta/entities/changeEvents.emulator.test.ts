// Emulator-backed proof of deriveAndWriteChangeEvents's orchestration: finding the previous
// consecutive snapshot run, diffing, and writing metaChangeEvents through the real A2 version
// guard against a real Firestore. Every doc here is written directly (no live Meta call) —
// see configSnapshot.emulator.test.ts's new tests for the same "Done when" bar proven through
// the actual wired-in META_SNAPSHOT_CONFIG task.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, collectionRef, metaEntitySnapshotKey } from "@shared/firestore/index.ts";
import {
  metaChangeEventSchema,
  metaEntitySnapshotSchema,
  type MetaEntitySnapshot,
} from "@shared/schema/index.ts";
import { deriveAndWriteChangeEvents } from "./changeEvents.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "changeEvents.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanupCollections() {
  for (const name of [COLLECTIONS.metaEntitySnapshots, COLLECTIONS.metaChangeEvents]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(cleanupCollections);
afterAll(cleanupCollections);

function adsetSnapshot(overrides: Partial<MetaEntitySnapshot> = {}): MetaEntitySnapshot {
  return {
    entityType: "ADSET",
    entityId: "as_1",
    syncRunId: "run_1",
    takenAt: new Date(),
    budget: {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 50000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    status: "ACTIVE",
    targeting: null,
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    creativeAssignment: null,
    ...overrides,
  };
}

async function writeSnapshot(snapshot: MetaEntitySnapshot) {
  const ref = collectionRef(db, COLLECTIONS.metaEntitySnapshots, metaEntitySnapshotSchema);
  const docId = metaEntitySnapshotKey(snapshot.entityType, snapshot.entityId, snapshot.syncRunId);
  await ref.doc(docId).set(snapshot);
}

async function allChangeEvents() {
  const ref = collectionRef(db, COLLECTIONS.metaChangeEvents, metaChangeEventSchema);
  const snap = await ref.get();
  return snap.docs.map((d) => d.data());
}

describe("deriveAndWriteChangeEvents (emulator)", () => {
  it("first-ever snapshot run: no previous run exists, so no diffing and no events", async () => {
    const run1 = adsetSnapshot({ syncRunId: "run_1" });
    const result = await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: [run1],
      currentSyncRunId: "run_1",
    });

    expect(result).toEqual({ changeEventsWritten: 0, previousSyncRunId: null });
    expect(await allChangeEvents()).toEqual([]);
  });

  it("a simulated budget INCREASE between two consecutive snapshots produces exactly one correctly typed change event", async () => {
    const run1 = adsetSnapshot({
      syncRunId: "run_1",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 50000,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });
    await writeSnapshot(run1);

    const run2 = adsetSnapshot({
      syncRunId: "run_2",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 60000,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });

    const result = await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: [run2],
      currentSyncRunId: "run_2",
    });

    expect(result.previousSyncRunId).toBe("run_1");
    expect(result.changeEventsWritten).toBe(1);

    const events = await allChangeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: "ADSET",
      entityId: "as_1",
      field: "BUDGET",
      budgetChangePercent: 20,
    });
  });

  it("a simulated budget DECREASE between two consecutive snapshots also produces exactly one correctly typed change event (both directions)", async () => {
    const run1 = adsetSnapshot({
      syncRunId: "run_1",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 60000,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });
    await writeSnapshot(run1);

    const run2 = adsetSnapshot({
      syncRunId: "run_2",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 50000,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });

    const result = await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: [run2],
      currentSyncRunId: "run_2",
    });

    expect(result.changeEventsWritten).toBe(1);
    const events = await allChangeEvents();
    expect(events).toHaveLength(1);
    expect(events[0].field).toBe("BUDGET");
    expect(events[0].budgetChangePercent).toBeCloseTo(-16.67, 2);
  });

  it("an unchanged snapshot pair produces no events", async () => {
    const run1 = adsetSnapshot({ syncRunId: "run_1" });
    await writeSnapshot(run1);

    const run2 = adsetSnapshot({ syncRunId: "run_2" }); // identical fields, different syncRunId

    const result = await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: [run2],
      currentSyncRunId: "run_2",
    });

    expect(result.changeEventsWritten).toBe(0);
    expect(await allChangeEvents()).toEqual([]);
  });

  it("re-running the diff for the SAME snapshot pair is idempotent — no duplicate change events", async () => {
    const run1 = adsetSnapshot({
      syncRunId: "run_1",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 50000,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });
    await writeSnapshot(run1);
    const run2Snapshots = [
      adsetSnapshot({
        syncRunId: "run_2",
        budget: {
          ownerLevel: "ADSET",
          dailyBudgetMinorUnits: 60000,
          lifetimeBudgetMinorUnits: null,
          currency: "INR",
        },
      }),
    ];

    await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: run2Snapshots,
      currentSyncRunId: "run_2",
    });
    // Re-run the SAME diff (e.g. a retried task) — must not duplicate the event doc.
    await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: run2Snapshots,
      currentSyncRunId: "run_2",
    });

    expect(await allChangeEvents()).toHaveLength(1);
  });

  it("a same-task-id retry (finds its own just-written snapshot as 'most recent') is treated as no previous run, not a self-diff", async () => {
    const run1 = adsetSnapshot({ syncRunId: "run_1" });
    await writeSnapshot(run1);

    // Simulates calling deriveAndWriteChangeEvents a second time for the SAME run id, after
    // run_1's own snapshot has already been written (out of the documented call order, but
    // exactly the scenario the currentSyncRunId defensive check exists for).
    const result = await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: [run1],
      currentSyncRunId: "run_1",
    });

    expect(result.previousSyncRunId).toBeNull();
    expect(result.changeEventsWritten).toBe(0);
  });

  it("an entity with no prior snapshot (newly observed this run) produces no event, not a crash", async () => {
    const run1 = adsetSnapshot({ syncRunId: "run_1", entityId: "as_old" });
    await writeSnapshot(run1);

    const run2Snapshots = [
      adsetSnapshot({ syncRunId: "run_2", entityId: "as_old" }), // unchanged
      adsetSnapshot({ syncRunId: "run_2", entityId: "as_new" }), // brand new this run
    ];

    const result = await deriveAndWriteChangeEvents({
      db,
      currentSnapshots: run2Snapshots,
      currentSyncRunId: "run_2",
    });

    expect(result.changeEventsWritten).toBe(0);
  });
});
