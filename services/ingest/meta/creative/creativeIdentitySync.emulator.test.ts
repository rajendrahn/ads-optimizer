// Emulator-backed proof of B8's own "Done when" bar: "ads sharing a creative land in one
// family; a dynamic creative is typed as composite and excluded from fatigue eligibility." No
// Meta call is made anywhere in this file (the handler is Firestore-only) — every Firestore
// call is real, against the emulator. `metaCreatives` is seeded directly, standing in for B2's
// already-run META_SYNC_ENTITIES (this step's actual dependency, per IMPLEMENTATION_PLAN.md).

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  creativeAssetSchema,
  creativeFamilySchema,
  metaCreativeSchema,
  type MetaCreative,
} from "@shared/schema/index.ts";
import { metaSyncCreativeIdentityHandler } from "./creativeIdentitySync.ts";
import { compositeFamilyId } from "./identity.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "creativeIdentitySync.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.metaCreatives,
    COLLECTIONS.creativeAssets,
    COLLECTIONS.creativeFamilies,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

function creative(overrides: Partial<MetaCreative> & { creativeId: string }): MetaCreative {
  return {
    accountId: "act_1",
    name: null,
    imageHash: null,
    videoId: null,
    creativeType: "STANDARD",
    memberAssetHashes: null,
    deliveredMixObservable: null,
    bodyText: null,
    headline: null,
    linkUrl: null,
    syncedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function makeCtx(runId: string) {
  return {
    runId,
    taskType: "META_SYNC_CREATIVE_IDENTITY",
    payload: {},
    archiver: { archive: async () => ({ path: "unused" }), read: async () => undefined },
    getMetaClient: async (): Promise<never> => {
      throw new Error("should not be called — this handler is Firestore-only");
    },
    getShopifyClient: async (): Promise<never> => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

beforeEach(cleanupCollections);
afterAll(cleanupCollections);

describe("metaSyncCreativeIdentityHandler (emulator)", () => {
  it("groups two ads' creatives sharing one image_hash into a single family, and types the composite explicitly", async () => {
    const creativesRepo = createRepository(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
    await creativesRepo.set(
      "cr_1",
      creative({ creativeId: "cr_1", imageHash: "hash_shared", headline: "Variant 1" }),
    );
    await creativesRepo.set(
      "cr_2",
      creative({ creativeId: "cr_2", imageHash: "hash_shared", headline: "Variant 2" }),
    );
    await creativesRepo.set(
      "cr_dco",
      creative({
        creativeId: "cr_dco",
        creativeType: "COMPOSITE",
        memberAssetHashes: ["a1", "b2"],
        deliveredMixObservable: false,
      }),
    );

    const result = await metaSyncCreativeIdentityHandler(makeCtx("run_1"));
    expect(result.summary).toMatchObject({
      metaCreativesRead: 3,
      assetsWritten: 1,
      familiesWritten: 2, // one STANDARD family (cr_1+cr_2) + one COMPOSITE family (cr_dco)
      standardFamilies: 1,
      compositeFamilies: 1,
      unidentifiableCreativeCount: 0,
    });

    const assetsRepo = createRepository(db, COLLECTIONS.creativeAssets, creativeAssetSchema);
    const asset = await assetsRepo.get("hash_shared");
    expect(asset).not.toBeNull();
    expect(asset?.familyId).not.toBeNull();

    const familiesRepo = createRepository(db, COLLECTIONS.creativeFamilies, creativeFamilySchema);
    const standardFamily = await familiesRepo.get(asset?.familyId as string);
    expect(standardFamily?.creativeType).toBe("STANDARD");
    expect(standardFamily?.eligibleForFamilyFatigueScore).toBe(true);
    expect(standardFamily?.variationCount).toBe(2); // cr_1 and cr_2 both land here

    const compositeFamily = await familiesRepo.get(compositeFamilyId("cr_dco"));
    expect(compositeFamily?.creativeType).toBe("COMPOSITE");
    expect(compositeFamily?.eligibleForFamilyFatigueScore).toBe(false);
    expect(compositeFamily?.fatigueScore).toBeNull();
    expect(compositeFamily?.memberAssetHashes).toEqual(["a1", "b2"]);
  });

  it("re-running produces no duplicates and preserves discoveredAt/createdAt", async () => {
    const creativesRepo = createRepository(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
    await creativesRepo.set("cr_1", creative({ creativeId: "cr_1", imageHash: "hash_a" }));

    await metaSyncCreativeIdentityHandler(makeCtx("run_1"));
    const assetsRepo = createRepository(db, COLLECTIONS.creativeAssets, creativeAssetSchema);
    const firstDiscoveredAt = (await assetsRepo.get("hash_a"))?.discoveredAt;
    expect(firstDiscoveredAt).toBeInstanceOf(Date);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await metaSyncCreativeIdentityHandler(makeCtx("run_2"));

    const assetDocs = await db.collection(COLLECTIONS.creativeAssets).listDocuments();
    expect(assetDocs).toHaveLength(1); // not 2 — same hash, overwritten in place

    const secondDiscoveredAt = (await assetsRepo.get("hash_a"))?.discoveredAt;
    expect(secondDiscoveredAt).toEqual(firstDiscoveredAt); // preserved, not reset to run_2's `now`
  });

  it("surfaces a creative with neither image_hash nor video_id as unidentifiable, without crashing or fabricating a family", async () => {
    const creativesRepo = createRepository(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
    await creativesRepo.set("cr_bare", creative({ creativeId: "cr_bare" }));

    const result = await metaSyncCreativeIdentityHandler(makeCtx("run_1"));
    expect(result.summary).toMatchObject({
      unidentifiableCreativeCount: 1,
      unidentifiableCreativeIds: ["cr_bare"],
    });
    const assetDocs = await db.collection(COLLECTIONS.creativeAssets).listDocuments();
    expect(assetDocs).toHaveLength(0);
  });
});
