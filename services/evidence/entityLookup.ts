// Thin Firestore-fetching glue for the evidence engine — every function here reads already-
// synced/computed collections (B2's Meta entities, B8's creative identity, C2/C3/C4's feature
// docs, A3/C3's settings) and does no business logic of its own. Kept separate from
// budgetOwnerResolution.ts/eligibility.ts/verdictExplain.ts so those stay pure and unit-testable
// without an emulator.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  type AdUrlTagAudit,
  type CreativeAsset,
  type CreativeFamily,
  type EntityFeatures,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaCreative,
  adUrlTagAuditSchema,
  creativeAssetSchema,
  creativeFamilySchema,
  entityFeaturesSchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
} from "@shared/schema/index.ts";
import { compositeFamilyId } from "@services/ingest/meta/creative/index.ts";
import type { ChildAdsetBudget } from "./budgetOwnerResolution.ts";
import type { ScalableEntityRef, ScalableEntityType } from "./types.ts";

export interface EntityChain {
  ad: MetaAd | null;
  adset: MetaAdset | null;
  campaign: MetaCampaign | null;
}

/** Loads whatever part of the ad -> ad set -> campaign chain is relevant to resolving budget
 * ownership for `namedEntity` — an AD needs all three, an ADSET needs itself + its campaign, a
 * CAMPAIGN needs only itself. Never throws on a missing doc — a `null` propagates into
 * `resolveDecisionUnit`'s own "not found" branch, which is the honest outcome (never guessed). */
export async function loadEntityChain(
  db: Firestore,
  namedEntity: ScalableEntityRef,
): Promise<EntityChain> {
  const ads = createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema);
  const adsets = createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
  const campaigns = createRepository<MetaCampaign>(
    db,
    COLLECTIONS.metaCampaigns,
    metaCampaignSchema,
  );

  if (namedEntity.type === "CAMPAIGN") {
    const campaign = await campaigns.get(namedEntity.id);
    return { ad: null, adset: null, campaign };
  }
  if (namedEntity.type === "ADSET") {
    const adset = await adsets.get(namedEntity.id);
    const campaign = adset ? await campaigns.get(adset.campaignId) : null;
    return { ad: null, adset, campaign };
  }
  const ad = await ads.get(namedEntity.id);
  const adset = ad ? await adsets.get(ad.adsetId) : null;
  const campaign = ad ? await campaigns.get(ad.campaignId) : null;
  return { ad, adset, campaign };
}

/** Every child ad set of `campaignId`, with just its own `.budget` field — used only for the
 * CAMPAIGN-defers-to-multiple-ad-sets check (budgetOwnerResolution.ts's resolveCampaignDeferral).
 * A single-field equality query on `campaignId` needs no composite index. */
export async function loadChildAdsetBudgets(
  db: Firestore,
  campaignId: string,
): Promise<ChildAdsetBudget[]> {
  const adsets = createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
  const rows = await adsets.query((ref) => ref.where("campaignId", "==", campaignId));
  return rows.map((a: MetaAdset) => ({ adsetId: a.adsetId, budget: a.budget }));
}

/** AD -> adFeatures/{adId}; ADSET/CAMPAIGN -> adsetFeatures/{id} (adsetFeatures also holds
 * CAMPAIGN-typed docs, keyed by campaign id — C2's own five-vs-three resolution, mirrored here
 * exactly as C4's enrichChangeFeaturesTask.ts's own `collectionForEntityType` already does). */
function collectionForEntityType(entityType: ScalableEntityType): string {
  return entityType === "AD" ? COLLECTIONS.adFeatures : COLLECTIONS.adsetFeatures;
}

export async function loadEntityFeatures(
  db: Firestore,
  entityType: ScalableEntityType,
  entityId: string,
): Promise<EntityFeatures | null> {
  const repo = createRepository<EntityFeatures>(
    db,
    collectionForEntityType(entityType),
    entityFeaturesSchema,
  );
  return repo.get(entityId);
}

export async function loadAdUrlTagAudit(
  db: Firestore,
  adId: string,
): Promise<AdUrlTagAudit | null> {
  const repo = createRepository<AdUrlTagAudit>(db, COLLECTIONS.adUrlTagAudits, adUrlTagAuditSchema);
  return repo.get(adId);
}

export interface CreativeFatigueLookup {
  familyId: string | null;
  family: CreativeFamily | null;
}

/** Walks AD -> metaCreatives/{creativeId} -> (COMPOSITE: compositeFamilyId; STANDARD:
 * creativeAssets/{imageHash ?? videoId}.familyId) -> creativeFamilies/{familyId}, mirroring
 * services/analytics/features/entityGraph.ts's own `familyByAd` derivation exactly (not
 * reimplemented differently) — but as a single-ad lookup rather than a whole-account graph
 * build, since D1 only ever needs one ad's family at a time. */
export async function loadCreativeFatigueForAd(
  db: Firestore,
  ad: MetaAd,
): Promise<CreativeFatigueLookup> {
  if (!ad.creativeId) return { familyId: null, family: null };
  const creative = await createRepository<MetaCreative>(
    db,
    COLLECTIONS.metaCreatives,
    metaCreativeSchema,
  ).get(ad.creativeId);
  if (!creative) return { familyId: null, family: null };

  let familyId: string | null = null;
  if (creative.creativeType === "COMPOSITE") {
    familyId = compositeFamilyId(creative.creativeId);
  } else {
    const assetHash = creative.imageHash ?? creative.videoId;
    if (assetHash) {
      const asset = await createRepository<CreativeAsset>(
        db,
        COLLECTIONS.creativeAssets,
        creativeAssetSchema,
      ).get(assetHash);
      familyId = asset?.familyId ?? null;
    }
  }
  if (!familyId) return { familyId: null, family: null };
  const family = await createRepository<CreativeFamily>(
    db,
    COLLECTIONS.creativeFamilies,
    creativeFamilySchema,
  ).get(familyId);
  return { familyId, family };
}
