// Pure ad -> ad set -> campaign -> creative family lookups, built from B2's already-synced Meta
// entity collections (`metaAds`/`metaAdsets`/`metaCampaigns`/`metaCreatives`) and B8's already-
// built creative identity (`creativeAssets`/`creativeFamilies`) — none of which is day/currency-
// shaped, so (matching C1's own precedent — "raw collections remain the source of truth for
// anything that isn't day/currency-shaped") this reads the raw collections directly, not
// anything C1 normalized. §10.1: "Recompute ALL entity features" — this is what "ALL" means in
// practice: every ad/ad set/campaign present in Meta's own synced config, every family B8 built,
// regardless of whether it has recent (or any) insight rows.
//
// Reuses B8's own `compositeFamilyId` rather than re-deriving the `composite_{creativeId}`
// scheme — see services/ingest/meta/creative/identity.ts's module comment for why that scheme
// looks the way it does.

import type {
  CreativeAsset,
  CreativeFamily,
  MetaAd,
  MetaAdset,
  MetaCampaign,
  MetaCreative,
} from "@shared/schema/index.ts";
import { compositeFamilyId } from "@services/ingest/meta/creative/index.ts";

export interface EntityGraphInput {
  ads: readonly MetaAd[];
  adsets: readonly MetaAdset[];
  campaigns: readonly MetaCampaign[];
  creatives: readonly MetaCreative[];
  assets: readonly CreativeAsset[];
  families: readonly CreativeFamily[];
}

export interface EntityGraph {
  adIds: string[];
  adsetIds: string[];
  campaignIds: string[];
  familyIds: string[];
  adsetByAd: ReadonlyMap<string, string>;
  campaignByAd: ReadonlyMap<string, string>;
  campaignByAdset: ReadonlyMap<string, string>;
  /** `null` when the ad's creative has no honest asset hash to group by (B8's
   * `unidentifiableCreativeIds`) or no `creativeId` at all — never fabricated. */
  familyByAd: ReadonlyMap<string, string | null>;
  adsByAdset: ReadonlyMap<string, readonly string[]>;
  adsByCampaign: ReadonlyMap<string, readonly string[]>;
  adsByFamily: ReadonlyMap<string, readonly string[]>;
}

function pushTo<K>(map: Map<K, string[]>, key: K, adId: string): void {
  const list = map.get(key);
  if (list) list.push(adId);
  else map.set(key, [adId]);
}

export function buildEntityGraph(input: EntityGraphInput): EntityGraph {
  const creativeById = new Map(input.creatives.map((c) => [c.creativeId, c]));
  const familyIdByAssetHash = new Map(
    input.assets.filter((a) => a.familyId !== null).map((a) => [a.assetHash, a.familyId as string]),
  );

  const adsetByAd = new Map<string, string>();
  const campaignByAd = new Map<string, string>();
  const familyByAd = new Map<string, string | null>();
  const adsByAdset = new Map<string, string[]>();
  const adsByCampaign = new Map<string, string[]>();
  const adsByFamily = new Map<string, string[]>();

  for (const ad of input.ads) {
    adsetByAd.set(ad.adId, ad.adsetId);
    campaignByAd.set(ad.adId, ad.campaignId);
    pushTo(adsByAdset, ad.adsetId, ad.adId);
    pushTo(adsByCampaign, ad.campaignId, ad.adId);

    let familyId: string | null = null;
    const creative = ad.creativeId ? creativeById.get(ad.creativeId) : undefined;
    if (creative) {
      if (creative.creativeType === "COMPOSITE") {
        familyId = compositeFamilyId(creative.creativeId);
      } else {
        const assetHash = creative.imageHash ?? creative.videoId;
        familyId = assetHash ? (familyIdByAssetHash.get(assetHash) ?? null) : null;
      }
    }
    familyByAd.set(ad.adId, familyId);
    if (familyId) pushTo(adsByFamily, familyId, ad.adId);
  }

  const campaignByAdset = new Map(input.adsets.map((a) => [a.adsetId, a.campaignId]));

  return {
    adIds: input.ads.map((a) => a.adId),
    adsetIds: input.adsets.map((a) => a.adsetId),
    campaignIds: input.campaigns.map((c) => c.campaignId),
    familyIds: input.families.map((f) => f.familyId),
    adsetByAd,
    campaignByAd,
    campaignByAdset,
    familyByAd,
    adsByAdset,
    adsByCampaign,
    adsByFamily,
  };
}
