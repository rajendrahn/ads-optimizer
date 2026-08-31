// META_SYNC_CREATIVE_IDENTITY (§10.2's list names PROCESS_CREATIVE for Phase F's *expensive*
// download/OCR/embedding pipeline — see identity.ts's module comment; this is a distinct,
// cheaper task type, added the same way B5 added SHOPIFY_IMPORT_ORDERS_CSV: a real operation
// §10.2's original list didn't anticipate needing split out).
//
// Firestore-only — reads `metaCreatives` (B2's already-normalized output; see IMPLEMENTATION_
// PLAN.md B8 notes for why this reuses B2's work rather than re-fetching/re-deriving it from
// Meta) and writes `creativeAssets`/`creativeFamilies`. No live Meta call, no archiving (there
// is no new external payload this run — it is a pure recompute over data B2 already archived
// when it was first fetched), matching §10.1's "full recompute" processing model: every run
// re-groups the current `metaCreatives` snapshot from scratch and wholesale-replaces both
// output collections, the same convention B2 uses for metaCampaigns/metaAdsets/metaAds/
// metaCreatives (Meta is the source of truth for current state; not version-guarded).
//
// `discoveredAt`/`createdAt` ARE preserved across re-runs (read the existing docs first) even
// though everything else is a full recompute — this is a one-line honesty concern (a re-run
// should not claim an asset was "discovered" today when it was actually seen last week), not an
// affected-entity-propagation optimization of the kind §10.1 explicitly steers away from: the
// grouping itself is still fully recomputed every time, unconditionally.

import { getDb } from "@shared/firestore/index.ts";
import { COLLECTIONS, collectionRef } from "@shared/firestore/index.ts";
import {
  creativeAssetSchema,
  creativeFamilySchema,
  metaCreativeSchema,
} from "@shared/schema/index.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { buildCreativeIdentity } from "./identity.ts";

// `_ctx` unused: this handler is Firestore-only — no Meta/Shopify client, no archiving (see
// module comment), no version-guarded write to log a rejection for. Still typed as `TaskHandler`
// so it plugs into the registry exactly like every other handler.
export const metaSyncCreativeIdentityHandler: TaskHandler = async (_ctx) => {
  const db = getDb();

  const creativesRef = collectionRef(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
  const creativesSnap = await creativesRef.get();
  const creatives = creativesSnap.docs.map((d) => d.data());

  const assetsRef = collectionRef(db, COLLECTIONS.creativeAssets, creativeAssetSchema);
  const familiesRef = collectionRef(db, COLLECTIONS.creativeFamilies, creativeFamilySchema);

  const [existingAssetsSnap, existingFamiliesSnap] = await Promise.all([
    assetsRef.get(),
    familiesRef.get(),
  ]);
  const existingAssetDiscoveredAt = new Map(
    existingAssetsSnap.docs.map((d) => [d.id, d.data().discoveredAt]),
  );
  const existingFamilyCreatedAt = new Map(
    existingFamiliesSnap.docs.map((d) => [d.id, d.data().createdAt]),
  );

  const { assets, families, unidentifiableCreativeIds } = buildCreativeIdentity(creatives, {
    now: new Date(),
    existingAssetDiscoveredAt,
    existingFamilyCreatedAt,
  });

  const bulkWriter = db.bulkWriter();
  for (const asset of assets) bulkWriter.set(assetsRef.doc(asset.assetHash), asset);
  for (const family of families) bulkWriter.set(familiesRef.doc(family.familyId), family);
  await bulkWriter.close();

  const compositeFamilies = families.filter((f) => f.creativeType === "COMPOSITE").length;
  const standardFamilies = families.length - compositeFamilies;

  return {
    newRowCount: assets.length + families.length,
    summary: {
      metaCreativesRead: creatives.length,
      assetsWritten: assets.length,
      familiesWritten: families.length,
      standardFamilies,
      compositeFamilies,
      unidentifiableCreativeCount: unidentifiableCreativeIds.length,
      unidentifiableCreativeIds,
    },
  };
};

export const metaSyncCreativeIdentityRegistration: TaskRegistration = {
  taskType: "META_SYNC_CREATIVE_IDENTITY",
  runSource: "meta",
  // A full recompute has no natural "furthest date of data collected" (same reasoning as B2's
  // META_SYNC_ENTITIES/META_SNAPSHOT_CONFIG) — lastSuccessfulSyncAt/status/lastRunId still track
  // correctly on every success; lastDataDate stays null.
  syncStateTarget: { source: "meta", resource: "creative_identity" },
  handler: metaSyncCreativeIdentityHandler,
};
