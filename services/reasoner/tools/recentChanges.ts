// §18 get_recent_changes() — the §13 change-aware summary (hoursSince*/…ChangesLastNDays),
// already computed by C4 onto the entity's own feature doc. Never the raw metaChangeEvents rows
// — those are what C4 summed to produce these counts; this tool returns only the summary.

import { z } from "zod";
import { computeRecentMajorChanges } from "@services/evidence/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM } from "./types.ts";
import { loadFeaturesFor } from "./shared.ts";

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  entityId: z.string().min(1),
});

export const getRecentChangesTool = defineTool({
  name: "get_recent_changes",
  description:
    "Summarized recent-change signal for one entity (§13): hours since the last budget/" +
    "audience/creative/status change, and change counts over the relevant lookback windows. " +
    "Already aggregated from metaChangeEvents — not a list of individual change events.",
  inputSchema: {
    type: "object",
    properties: {
      entityType: { type: "string", enum: SCALABLE_ENTITY_TYPE_JSON_ENUM },
      entityId: { type: "string" },
    },
    required: ["entityType", "entityId"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const features = await loadFeaturesFor(ctx.db, input.entityType, input.entityId);
    if (!features) {
      return { entityType: input.entityType, entityId: input.entityId, found: false };
    }
    const changeAware = features.changeAware ?? {};
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      found: true,
      recentMajorChanges: computeRecentMajorChanges(features.changeAware),
      hoursSinceLastBudgetChange: changeAware.hoursSinceLastBudgetChange ?? null,
      lastBudgetChangePercent: changeAware.lastBudgetChangePercent ?? null,
      budgetChangesLast7Days: changeAware.budgetChangesLast7Days ?? null,
      hoursSinceLastAudienceChange: changeAware.hoursSinceLastAudienceChange ?? null,
      targetingChangesLast14Days: changeAware.targetingChangesLast14Days ?? null,
      hoursSinceLastCreativeChange: changeAware.hoursSinceLastCreativeChange ?? null,
      creativeChangesLast7Days: changeAware.creativeChangesLast7Days ?? null,
      hoursSinceLastStatusChange: changeAware.hoursSinceLastStatusChange ?? null,
    };
  },
});
