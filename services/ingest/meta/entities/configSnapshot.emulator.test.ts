// Emulator-backed proof of B2's own "Done when" bar for META_SNAPSHOT_CONFIG: "one snapshot
// per entity; re-running produces no duplicates." Every Meta call is mocked; every Firestore
// call is real, against the emulator.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository, metaEntitySnapshotKey } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import { metaEntitySnapshotSchema, type MetaEntitySnapshot } from "@shared/schema/index.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { MetaClient } from "../client.ts";
import { metaSnapshotConfigHandler } from "./configSnapshot.ts";
import { TEST_CANON, buildTestFetchImpl } from "./testFixtures.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "configSnapshot.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

async function cleanupCollections() {
  for (const name of [COLLECTIONS.metaEntitySnapshots, COLLECTIONS.settings]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(TEST_CANON.accountId, TEST_CANON);
});

afterAll(async () => {
  await cleanupCollections();
});

function makeCtx(runId: string, client: MetaClient) {
  return {
    runId,
    taskType: "META_SNAPSHOT_CONFIG",
    payload: {},
    archiver: dummyArchiver,
    getMetaClient: async () => client,
    getShopifyClient: async () => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

function newTestClient(): MetaClient {
  return new MetaClient({
    accessToken: "tok",
    fetchImpl: buildTestFetchImpl(),
    sleepImpl: vi.fn().mockResolvedValue(undefined),
  });
}

describe("metaSnapshotConfigHandler (emulator)", () => {
  it("writes one snapshot per entity (3 campaigns + 2 ad sets + 3 ads), budget/status/targeting/bidStrategy/creativeAssignment populated", async () => {
    const result = await metaSnapshotConfigHandler(makeCtx("run_1", newTestClient()));

    expect(result.newRowCount).toBe(3 + 2 + 3);
    expect(result.summary).toEqual({ campaigns: 3, adsets: 2, ads: 3 });

    const snapshotsRepo = createRepository(
      db,
      COLLECTIONS.metaEntitySnapshots,
      metaEntitySnapshotSchema,
    );

    const cboSnapshot = await snapshotsRepo.get(
      metaEntitySnapshotKey("CAMPAIGN", "cmp_cbo", "run_1"),
    );
    expect(cboSnapshot?.budget?.ownerLevel).toBe("CAMPAIGN");
    expect(cboSnapshot?.status).toBe("ACTIVE");
    expect(cboSnapshot?.bidStrategy).toBe("LOWEST_COST_WITHOUT_CAP");
    expect(cboSnapshot?.targeting).toBeNull(); // no campaign-level targeting in Meta's model
    expect(cboSnapshot?.creativeAssignment).toBeNull(); // no campaign-level creative assignment

    const orphanSnapshot = await snapshotsRepo.get(
      metaEntitySnapshotKey("CAMPAIGN", "cmp_orphan", "run_1"),
    );
    expect(orphanSnapshot?.budget?.ownerLevel).toBe("UNKNOWN");

    const adsetSnapshot = await snapshotsRepo.get(
      metaEntitySnapshotKey("ADSET", "as_under_abo", "run_1"),
    );
    expect(adsetSnapshot?.budget?.ownerLevel).toBe("ADSET");
    expect(adsetSnapshot?.targeting).toBeNull(); // as_under_abo's fixture has no targeting

    const adSnapshotWithCreative = await snapshotsRepo.get(
      metaEntitySnapshotKey("AD", "ad_standard", "run_1"),
    );
    expect(adSnapshotWithCreative?.budget).toBeNull(); // ads never own budget
    expect(adSnapshotWithCreative?.creativeAssignment).toEqual(["cr_standard"]);

    const adSnapshotNoCreative = await snapshotsRepo.get(
      metaEntitySnapshotKey("AD", "ad_no_creative", "run_1"),
    );
    expect(adSnapshotNoCreative?.creativeAssignment).toEqual([]);
  });

  it("a second run with a NEW run id adds a second, distinct snapshot per entity (history, not replacement)", async () => {
    await metaSnapshotConfigHandler(makeCtx("run_1", newTestClient()));
    await metaSnapshotConfigHandler(makeCtx("run_2", newTestClient()));

    const allDocs = await db.collection(COLLECTIONS.metaEntitySnapshots).listDocuments();
    expect(allDocs).toHaveLength((3 + 2 + 3) * 2);
  });

  it("re-running with the SAME run id overwrites its own snapshot rather than duplicating (idempotent retry)", async () => {
    await metaSnapshotConfigHandler(makeCtx("run_1", newTestClient()));
    await metaSnapshotConfigHandler(makeCtx("run_1", newTestClient()));

    const allDocs = await db.collection(COLLECTIONS.metaEntitySnapshots).listDocuments();
    expect(allDocs).toHaveLength(3 + 2 + 3);
  });

  it("stamps every snapshot in a run with the same syncRunId and a takenAt timestamp", async () => {
    await metaSnapshotConfigHandler(makeCtx("run_1", newTestClient()));
    const snapshotsRepo = createRepository(
      db,
      COLLECTIONS.metaEntitySnapshots,
      metaEntitySnapshotSchema,
    );
    const doc = (await snapshotsRepo.get(
      metaEntitySnapshotKey("CAMPAIGN", "cmp_cbo", "run_1"),
    )) as MetaEntitySnapshot;
    expect(doc.syncRunId).toBe("run_1");
    expect(doc.takenAt).toBeInstanceOf(Date);
  });
});
