// §18 get_creative_family() — direct family-level metadata lookup (fatigue score, variation
// count, age, active-ad count), for comparing families rather than checking one ad's own
// applicability (that's get_fatigue_analysis).

import { z } from "zod";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  creativeFamilySchema,
  metaAdSchema,
  type CreativeFamily,
  type MetaAd,
} from "@shared/schema/index.ts";
import { loadCreativeFatigueForAd } from "@services/evidence/index.ts";
import { defineTool } from "./types.ts";

const inputSchema = z
  .object({
    familyId: z.string().min(1).nullable().optional(),
    adId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Boolean(v.familyId) || Boolean(v.adId), {
    message: "Provide either familyId or adId",
  });

export const getCreativeFamilyTool = defineTool({
  name: "get_creative_family",
  description:
    "Creative-family metadata — fatigue score, variation count, family age, active-ad count. " +
    "Provide either familyId directly or an adId to resolve that ad's family.",
  inputSchema: {
    type: "object",
    properties: { familyId: { type: "string" }, adId: { type: "string" } },
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    let family: CreativeFamily | null = null;
    if (input.familyId) {
      family = await createRepository<CreativeFamily>(
        ctx.db,
        COLLECTIONS.creativeFamilies,
        creativeFamilySchema,
      ).get(input.familyId);
    } else if (input.adId) {
      const ad = await createRepository<MetaAd>(ctx.db, COLLECTIONS.metaAds, metaAdSchema).get(
        input.adId,
      );
      if (ad) {
        const lookup = await loadCreativeFatigueForAd(ctx.db, ad);
        family = lookup.family;
      }
    }
    if (!family) {
      return { found: false, note: "No creative family could be resolved for this input." };
    }
    return {
      found: true,
      familyId: family.familyId,
      creativeType: family.creativeType,
      eligibleForFamilyFatigueScore: family.eligibleForFamilyFatigueScore,
      familyAgeDays: family.familyAgeDays,
      totalHistoricalSpendMinorUnits: family.totalHistoricalSpendMinorUnits,
      activeAdsCount: family.activeAdsCount,
      variationCount: family.variationCount,
      fatigueScore: family.fatigueScore,
      note:
        family.fatigueScore === null
          ? "No fatigue score has been computed for this family yet."
          : undefined,
    };
  },
});
