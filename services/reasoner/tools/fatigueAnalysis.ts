// §18 get_fatigue_analysis() — the ad-scoped applicability question D1's own
// `CreativeFatigueEvidence` answers (creative fatigue is per-ad/per-family, never a fabricated
// ad-set-wide aggregate). Mirrors evidenceAssembler.ts's private `buildCreativeFatigue` shape —
// reimplemented here (that function isn't exported) rather than editing D1's file.

import { z } from "zod";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { metaAdSchema, type MetaAd } from "@shared/schema/index.ts";
import { loadCreativeFatigueForAd } from "@services/evidence/index.ts";
import { defineTool } from "./types.ts";

const inputSchema = z.object({ adId: z.string().min(1) });

export const getFatigueAnalysisTool = defineTool({
  name: "get_fatigue_analysis",
  description:
    "Whether creative fatigue applies to this specific ad's creative family, and the family's " +
    "fatigue score if one has been computed. Composite (Advantage+) creatives are excluded from " +
    "family fatigue scoring (§7.3) — this tool says so explicitly rather than fabricating a score.",
  inputSchema: {
    type: "object",
    properties: { adId: { type: "string" } },
    required: ["adId"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const ad = await createRepository<MetaAd>(ctx.db, COLLECTIONS.metaAds, metaAdSchema).get(
      input.adId,
    );
    if (!ad)
      return {
        adId: input.adId,
        applicable: false,
        note: "No such ad in the current Meta config sync.",
      };

    const { familyId, family } = await loadCreativeFatigueForAd(ctx.db, ad);
    if (!familyId || !family) {
      return {
        adId: input.adId,
        applicable: false,
        familyId,
        note: "No creative family could be identified for this ad yet.",
      };
    }
    return {
      adId: input.adId,
      applicable: true,
      familyId: family.familyId,
      creativeType: family.creativeType,
      eligibleForFamilyFatigueScore: family.eligibleForFamilyFatigueScore,
      fatigueScore: family.fatigueScore,
      variationCount: family.variationCount,
      note: !family.eligibleForFamilyFatigueScore
        ? "This is a COMPOSITE (dynamic/Advantage+) creative — §7.3 excludes composites from " +
          "family-level fatigue scoring, since the delivered creative mix is not observable."
        : family.fatigueScore === null
          ? "No fatigue score has been computed for this creative family yet."
          : `Family-level fatigue score: ${family.fatigueScore}.`,
    };
  },
});
