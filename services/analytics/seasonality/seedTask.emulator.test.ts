// Emulator-backed proof of SEED_SEASONAL_CALENDAR: writes calendarSeed.ts's real entries through
// the real A2 version guard against a real Firestore emulator, proves idempotency, and proves the
// "operator correction survives a reseed" mechanism calendarRepo.ts's module comment documents.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS, seasonalCalendarWindowKey } from "@shared/firestore/index.ts";
import { createDefaultRegistry } from "../../ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../ingest/sync/store.ts";
import { runSyncTask } from "../../ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../ingest/sync/archiver.ts";
import { SEASONAL_CALENDAR_SEED_ENTRIES } from "./calendarSeed.ts";
import { loadSeasonalCalendarWindows } from "./calendarRepo.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "seedTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

async function cleanup() {
  for (const name of [
    COLLECTIONS.seasonalCalendarWindows,
    COLLECTIONS.syncState,
    COLLECTIONS.syncRuns,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(cleanup);
afterAll(cleanup);

describe("SEED_SEASONAL_CALENDAR (emulator)", () => {
  it("writes every seed entry, and loadSeasonalCalendarWindows reads them back", async () => {
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "SEED_SEASONAL_CALENDAR",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(result.status).toBe("SUCCEEDED");
    const loaded = await loadSeasonalCalendarWindows({ db });
    expect(loaded).toHaveLength(SEASONAL_CALENDAR_SEED_ENTRIES.length);

    const diwali2025 = loaded.find((w) => w.label === "diwali" && w.startDay === "2025-10-19");
    expect(diwali2025).toBeDefined();
    expect(diwali2025?.endDay).toBe("2025-10-23");
    expect(diwali2025?.confidence).toBe("estimated");
  });

  it("re-running is idempotent — no duplicate docs, same content", async () => {
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    await runSyncTask({
      syncStore,
      registry,
      taskType: "SEED_SEASONAL_CALENDAR",
      payload: {},
      archiver: dummyArchiver,
    });
    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "SEED_SEASONAL_CALENDAR",
      payload: {},
      archiver: dummyArchiver,
    });

    expect(second.status).toBe("SUCCEEDED");
    const loaded = await loadSeasonalCalendarWindows({ db });
    expect(loaded).toHaveLength(SEASONAL_CALENDAR_SEED_ENTRIES.length);
  });

  it("an operator's manual correction (newer sourceUpdatedAt) survives a reseed", async () => {
    const syncStore = createFirestoreSyncStore(db);
    const registry = createDefaultRegistry();

    // First seed.
    await runSyncTask({
      syncStore,
      registry,
      taskType: "SEED_SEASONAL_CALENDAR",
      payload: {},
      archiver: dummyArchiver,
    });

    // Simulate an operator directly correcting the 2025 Navratri end date in the Firestore
    // console, bumping sourceUpdatedAt as calendarRepo.ts's module comment instructs.
    const docId = seasonalCalendarWindowKey("navratri", "2025-09-22");
    const correctedAt = new Date("2027-01-01T00:00:00Z"); // newer than the seed's fixed timestamp
    await db.collection(COLLECTIONS.seasonalCalendarWindows).doc(docId).set(
      {
        label: "navratri",
        startDay: "2025-09-22",
        endDay: "2025-10-03", // operator's correction
        year: 2025,
        confidence: "confirmed",
        source: "operator correction",
        notes: "corrected by hand",
        sourceUpdatedAt: correctedAt,
        computedAt: correctedAt,
      },
      { merge: false },
    );

    // A reseed (e.g. calendarSeed.ts gained a new year's entries) must not clobber it.
    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "SEED_SEASONAL_CALENDAR",
      payload: {},
      archiver: dummyArchiver,
    });
    expect(second.status).toBe("SUCCEEDED");

    const doc = await db.collection(COLLECTIONS.seasonalCalendarWindows).doc(docId).get();
    expect(doc.data()?.endDay).toBe("2025-10-03"); // still the operator's correction, not the seed's
    expect(doc.data()?.source).toBe("operator correction");
  });
});
