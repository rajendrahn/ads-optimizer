// §18 get_campaign_context() — a campaign's own config plus a genuinely aggregated rollup of
// its children (ad-set count by status, ad count by status) via Firestore's server-side
// `.count()` aggregation — an aggregate the server computes, never rows fetched and counted here.

import { z } from "zod";
import type { CollectionReference, DocumentData } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { metaCampaignSchema, type MetaCampaign } from "@shared/schema/index.ts";
import { defineTool } from "./types.ts";

const inputSchema = z.object({ campaignId: z.string().min(1) });

async function countByStatus(
  ref: CollectionReference<DocumentData>,
  field: string,
  value: string,
  status: string,
): Promise<number> {
  const snap = await ref.where(field, "==", value).where("status", "==", status).count().get();
  return snap.data().count;
}

export const getCampaignContextTool = defineTool({
  name: "get_campaign_context",
  description:
    "A campaign's own config (objective, budget ownership, status) plus a server-aggregated " +
    "rollup of its ad sets and ads by status — counts only, never a list of child entities.",
  inputSchema: {
    type: "object",
    properties: { campaignId: { type: "string" } },
    required: ["campaignId"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const campaign = await createRepository<MetaCampaign>(
      ctx.db,
      COLLECTIONS.metaCampaigns,
      metaCampaignSchema,
    ).get(input.campaignId);
    if (!campaign) {
      return {
        campaignId: input.campaignId,
        found: false,
        note: "No such campaign in the current Meta config sync.",
      };
    }

    const adsetsRef = ctx.db.collection(COLLECTIONS.metaAdsets);
    const adsRef = ctx.db.collection(COLLECTIONS.metaAds);
    const [adsetsTotal, adsetsActive, adsTotal, adsActive] = await Promise.all([
      adsetsRef.where("campaignId", "==", input.campaignId).count().get(),
      countByStatus(adsetsRef, "campaignId", input.campaignId, "ACTIVE"),
      adsRef.where("campaignId", "==", input.campaignId).count().get(),
      countByStatus(adsRef, "campaignId", input.campaignId, "ACTIVE"),
    ]);

    return {
      campaignId: campaign.campaignId,
      found: true,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      buyingType: campaign.buyingType,
      budgetOwnership: campaign.budget,
      isCbo: campaign.budget?.ownerLevel === "CAMPAIGN",
      childAdsets: { total: adsetsTotal.data().count, active: adsetsActive },
      childAds: { total: adsTotal.data().count, active: adsActive },
    };
  },
});
