// §18 resolve_entity() — turns a name/fragment/ID the user typed into candidate AD/ADSET/
// CAMPAIGN entity refs. Pre-aggregated by construction: this account has < 100 active ads
// (§2.1), so a full scan of the three Meta entity collections and an in-memory name match is a
// small, bounded lookup, not "rows the model would have to sum" — the tool returns only the
// matched identities, never any performance data (get_performance/get_decision_evidence are
// what fetch that, given the resolved id).

import { z } from "zod";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
} from "@shared/schema/index.ts";
import { defineTool } from "./types.ts";

const inputSchema = z.object({ query: z.string().min(1) });

interface Match {
  type: "AD" | "ADSET" | "CAMPAIGN";
  id: string;
  name: string;
  status: string;
}

export const resolveEntityTool = defineTool({
  name: "resolve_entity",
  description:
    "Resolve a user-typed name, name fragment, or platform ID into candidate AD/ADSET/CAMPAIGN " +
    "entities in this account. Returns identity only (type, id, name, status) — call " +
    "get_decision_evidence or get_performance with the resolved id for actual numbers.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A platform ID, an exact name, or a name fragment to search for.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const needle = input.query.trim().toLowerCase();

    const ads = createRepository<MetaAd>(ctx.db, COLLECTIONS.metaAds, metaAdSchema);
    const adsets = createRepository<MetaAdset>(ctx.db, COLLECTIONS.metaAdsets, metaAdsetSchema);
    const campaigns = createRepository<MetaCampaign>(
      ctx.db,
      COLLECTIONS.metaCampaigns,
      metaCampaignSchema,
    );

    // Exact-ID short-circuit first — the common case when a caller already has an id.
    const [adById, adsetById, campaignById] = await Promise.all([
      ads.get(input.query),
      adsets.get(input.query),
      campaigns.get(input.query),
    ]);
    const exact: Match[] = [];
    if (adById)
      exact.push({ type: "AD", id: adById.adId, name: adById.name, status: adById.status });
    if (adsetById)
      exact.push({
        type: "ADSET",
        id: adsetById.adsetId,
        name: adsetById.name,
        status: adsetById.status,
      });
    if (campaignById)
      exact.push({
        type: "CAMPAIGN",
        id: campaignById.campaignId,
        name: campaignById.name,
        status: campaignById.status,
      });
    if (exact.length > 0) {
      return { matches: exact, matchedBy: "exact_id" };
    }

    // Otherwise, a bounded name-fragment scan — account is < 100 ads (§2.1).
    const [allAds, allAdsets, allCampaigns] = await Promise.all([
      ads.query((ref) => ref),
      adsets.query((ref) => ref),
      campaigns.query((ref) => ref),
    ]);
    const matches: Match[] = [
      ...allAds
        .filter((a) => a.name.toLowerCase().includes(needle))
        .map((a): Match => ({ type: "AD", id: a.adId, name: a.name, status: a.status })),
      ...allAdsets
        .filter((a) => a.name.toLowerCase().includes(needle))
        .map((a): Match => ({ type: "ADSET", id: a.adsetId, name: a.name, status: a.status })),
      ...allCampaigns
        .filter((c) => c.name.toLowerCase().includes(needle))
        .map((c): Match => ({
          type: "CAMPAIGN",
          id: c.campaignId,
          name: c.name,
          status: c.status,
        })),
    ];

    return {
      matches,
      matchedBy: "name_fragment",
      note:
        matches.length === 0
          ? "No entity name or ID matched this query in the current Meta config sync."
          : matches.length > 5
            ? "Multiple matches — ask the user to disambiguate before resolving further."
            : undefined,
    };
  },
});
