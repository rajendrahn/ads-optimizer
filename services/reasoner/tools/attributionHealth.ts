// §18 get_attribution_health() — §6.3's `attributionCoverageRatio` as "a first-class account
// and entity feature... its LEVEL is not meaningful; its DRIFT is." This tool surfaces the
// coverage ratio and the account-level blended MER across windows so the model can look at
// drift, not a single reading — and always account-level `blendedMerAccountOnly`, the "trustworthy
// account-level efficiency figure when coverage is low" (evidenceAssembler.ts's own wording).

import { z } from "zod";
import { META_AD_ACCOUNT_ID } from "../../../scripts/config.ts";
import type { WindowLabel } from "@shared/schema/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM } from "./types.ts";
import { loadAccountFeatures, loadFeaturesFor } from "./shared.ts";
import { ATTRIBUTION_COVERAGE_NOTE } from "./shopifyPerformance.ts";

const WINDOWS: readonly WindowLabel[] = ["7d", "14d", "28d", "56d"];

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]).nullable().optional(),
  entityId: z.string().min(1).nullable().optional(),
});

export const getAttributionHealthTool = defineTool({
  name: "get_attribution_health",
  description:
    "Attribution-coverage ratio and account-level blended MER across windows, for drift " +
    "checking (§6.3: the ratio's level is not meaningful, its drift is). Omit entityType/" +
    "entityId for the account-wide view; provide them for one entity's own coverage trend.",
  inputSchema: {
    type: "object",
    properties: {
      entityType: { type: "string", enum: SCALABLE_ENTITY_TYPE_JSON_ENUM },
      entityId: { type: "string" },
    },
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const accountId = ctx.canon.accountId || META_AD_ACCOUNT_ID;
    const useEntity = input.entityType && input.entityId;
    const features = useEntity
      ? await loadFeaturesFor(
          ctx.db,
          input.entityType as "AD" | "ADSET" | "CAMPAIGN",
          input.entityId as string,
        )
      : await loadAccountFeatures(ctx.db, accountId);

    if (!features) {
      return {
        scope: useEntity
          ? { entityType: input.entityType, entityId: input.entityId }
          : { entityType: "ACCOUNT", entityId: accountId },
        found: false,
        note: "No feature document exists yet for this scope.",
      };
    }

    const byWindow = WINDOWS.filter((w) => features.windows?.[w]).map((w) => {
      const window = features.windows[w];
      return {
        window: w,
        attributionCoverageRatio: window?.attributionCoverageRatio ?? null,
        attributionCoverageRatioIncludingNameMatch:
          window?.attributionCoverageRatioIncludingNameMatch ?? null,
        blendedMerAccountOnly: window?.blendedMerAccountOnly ?? null,
        shopifyDataGap: window?.shopifyDataGap ?? null,
      };
    });

    return {
      scope: useEntity
        ? { entityType: input.entityType, entityId: input.entityId }
        : { entityType: "ACCOUNT", entityId: accountId },
      found: true,
      byWindow,
      note: ATTRIBUTION_COVERAGE_NOTE,
    };
  },
});
