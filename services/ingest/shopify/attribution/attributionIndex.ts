// Firestore wrapper around resolveOrder.ts's pure `buildAttributionIndexFromEntities` — reads
// every `metaAds`/`metaCampaigns` document B2 has ever written (all-time, all-status, matching
// B2's own fetch scope) and builds the ID/name index the join runs against.

import { collectionRef, COLLECTIONS } from "@shared/firestore/index.ts";
import { metaAdSchema, metaCampaignSchema } from "@shared/schema/index.ts";
import type { Firestore } from "firebase-admin/firestore";
import { type AttributionIndex, buildAttributionIndexFromEntities } from "./resolveOrder.ts";

export async function buildAttributionIndex(db: Firestore): Promise<AttributionIndex> {
  const adsRef = collectionRef(db, COLLECTIONS.metaAds, metaAdSchema);
  const campaignsRef = collectionRef(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);

  const [adsSnap, campaignsSnap] = await Promise.all([adsRef.get(), campaignsRef.get()]);

  const ads = adsSnap.docs.map((d) => {
    const ad = d.data();
    return { adId: ad.adId, campaignId: ad.campaignId, name: ad.name };
  });
  const campaigns = campaignsSnap.docs.map((d) => {
    const campaign = d.data();
    return { campaignId: campaign.campaignId, name: campaign.name };
  });

  return buildAttributionIndexFromEntities(ads, campaigns);
}
