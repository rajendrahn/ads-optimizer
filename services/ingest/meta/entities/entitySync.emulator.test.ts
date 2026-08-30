// Emulator-backed proof of B2's own "Done when" bar for META_SYNC_ENTITIES: "A full entity
// sync populates all four collections ... re-running produces no duplicates." Every Meta call
// is mocked (a real MetaClient with a canned `fetchImpl` — no live network call, no
// credentials needed); every Firestore call is real, against the emulator.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
} from "@shared/schema/index.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { MetaClient } from "../client.ts";
import { metaSyncEntitiesHandler } from "./entitySync.ts";
import { TEST_CANON, buildTestFetchImpl } from "./testFixtures.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "entitySync.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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
  for (const name of [
    COLLECTIONS.metaCampaigns,
    COLLECTIONS.metaAdsets,
    COLLECTIONS.metaAds,
    COLLECTIONS.metaCreatives,
    COLLECTIONS.settings,
  ]) {
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
    taskType: "META_SYNC_ENTITIES",
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

describe("metaSyncEntitiesHandler (emulator)", () => {
  it("populates all four collections with correctly normalized data, budget ownership included", async () => {
    const result = await metaSyncEntitiesHandler(makeCtx("run_1", newTestClient()));

    expect(result.newRowCount).toBe(3 + 2 + 3 + 2); // campaigns + adsets + ads + creatives
    expect(result.summary).toEqual({ campaigns: 3, adsets: 2, ads: 3, creatives: 2 });

    const campaignsRepo = createRepository(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);
    const cbo = await campaignsRepo.get("cmp_cbo");
    expect(cbo?.budget).toEqual({
      ownerLevel: "CAMPAIGN",
      dailyBudgetMinorUnits: 50000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });
    const abo = await campaignsRepo.get("cmp_abo");
    expect(abo?.budget).toBeNull(); // ad-set level owns it
    const orphan = await campaignsRepo.get("cmp_orphan");
    expect(orphan?.budget?.ownerLevel).toBe("UNKNOWN"); // no budget, no ad sets — genuinely unknown

    const adsetsRepo = createRepository(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
    const underCbo = await adsetsRepo.get("as_under_cbo");
    expect(underCbo?.budget).toBeNull(); // consistent with the parent campaign owning it
    expect(underCbo?.placements).toEqual(["facebook", "instagram"]);
    const underAbo = await adsetsRepo.get("as_under_abo");
    expect(underAbo?.budget).toEqual({
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 3000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });

    const adsRepo = createRepository(db, COLLECTIONS.metaAds, metaAdSchema);
    const adStandard = await adsRepo.get("ad_standard");
    expect(adStandard?.creativeId).toBe("cr_standard");
    expect(adStandard?.destinationUrl).toBe(
      "https://sparkleandglow.co.in/?utm_content=ad_standard",
    );
    const adNoCreative = await adsRepo.get("ad_no_creative");
    expect(adNoCreative?.creativeId).toBeNull();
    expect(adNoCreative?.destinationUrl).toBeNull();

    const creativesRepo = createRepository(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
    const standard = await creativesRepo.get("cr_standard");
    expect(standard?.creativeType).toBe("STANDARD");
    const composite = await creativesRepo.get("cr_composite");
    expect(composite?.creativeType).toBe("COMPOSITE");
    expect(composite?.deliveredMixObservable).toBe(false);
    expect(composite?.memberAssetHashes).toEqual(["a1", "b2"]);
  });

  it("re-running produces no duplicates — the same Meta IDs are simply overwritten", async () => {
    await metaSyncEntitiesHandler(makeCtx("run_1", newTestClient()));
    await metaSyncEntitiesHandler(makeCtx("run_2", newTestClient()));

    const campaignDocs = await db.collection(COLLECTIONS.metaCampaigns).listDocuments();
    expect(campaignDocs).toHaveLength(3); // not 6 — same 3 IDs, overwritten in place
    const adsetDocs = await db.collection(COLLECTIONS.metaAdsets).listDocuments();
    expect(adsetDocs).toHaveLength(2);
    const adDocs = await db.collection(COLLECTIONS.metaAds).listDocuments();
    expect(adDocs).toHaveLength(3);
    const creativeDocs = await db.collection(COLLECTIONS.metaCreatives).listDocuments();
    expect(creativeDocs).toHaveLength(2);
  });
});
