// §18 get_budget_constraints() — who actually owns the budget for a named entity (§4.1) and
// what that owner's own budget fields are, reusing D1's own pure `resolveDecisionUnit` rather
// than re-deriving budget ownership a second way. For the primary entity the packet already
// states this (with escalation); this tool is for checking a COMPARISON entity's ownership.

import { z } from "zod";
import {
  resolveDecisionUnit,
  loadEntityChain,
  loadChildAdsetBudgets,
} from "@services/evidence/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM } from "./types.ts";

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  entityId: z.string().min(1),
});

export const getBudgetConstraintsTool = defineTool({
  name: "get_budget_constraints",
  description:
    "Resolves the actual budget owner for a named AD/ADSET/CAMPAIGN (§4.1 — an ad never owns " +
    "its own budget in this account's Meta config) and returns that owner's own budget fields " +
    "(daily/lifetime budget, currency). Use to sanity-check a comparison entity's budget.",
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
    const namedEntity = { type: input.entityType, id: input.entityId };
    const chain = await loadEntityChain(ctx.db, namedEntity);
    const childAdsetBudgets =
      input.entityType === "CAMPAIGN"
        ? await loadChildAdsetBudgets(ctx.db, input.entityId)
        : undefined;

    const resolution = resolveDecisionUnit({
      namedEntity,
      ad: chain.ad,
      adset: chain.adset,
      campaign: chain.campaign,
      childAdsetBudgets,
    });

    if (resolution.kind === "NO_DECISION_UNIT") {
      return { namedEntity, resolved: false, detail: resolution.detail };
    }

    const owner = resolution.decisionUnit;
    // The resolved owner is not always something `chain` already loaded — e.g. a named CAMPAIGN
    // that defers to one specific child ad set (`resolveCampaignDeferral`) resolves to an ad set
    // `loadEntityChain` never fetched (it only loads `adset` for an ADSET/AD-named request).
    // `childAdsetBudgets` (loaded only for the CAMPAIGN case) covers exactly that gap.
    const ownerBudget =
      owner.type === "CAMPAIGN"
        ? chain.campaign?.campaignId === owner.id
          ? chain.campaign.budget
          : null
        : chain.adset?.adsetId === owner.id
          ? chain.adset.budget
          : (childAdsetBudgets?.find((a) => a.adsetId === owner.id)?.budget ?? null);

    return {
      namedEntity,
      resolved: true,
      decisionUnit: owner,
      escalatedFrom: resolution.escalatedFrom ?? null,
      budgetOwnership: ownerBudget,
    };
  },
});
