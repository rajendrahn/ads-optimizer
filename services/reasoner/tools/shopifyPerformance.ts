// §18 get_shopify_performance() — the Shopify-attributed half of §6.3's "never merge" pair.
// Always carries the same attribution-coverage caveat evidenceAssembler.ts stamps on every
// Shopify figure, so a model calling this tool directly (rather than reading it off the packet)
// still gets the honesty, not just a bare number.

import { z } from "zod";
import { resolveStatisticalThresholds } from "@shared/canon/index.ts";
import type { WindowLabel, WindowMetrics } from "@shared/schema/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM, WINDOW_LABEL_JSON_ENUM } from "./types.ts";
import { loadFeaturesFor, metricSnapshot } from "./shared.ts";

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  entityId: z.string().min(1),
  windows: z.array(z.enum(["7d", "14d", "28d", "56d"])).optional(),
});

export const ATTRIBUTION_COVERAGE_NOTE =
  "Shopify-attributed per-ad/ad-set ROAS is not reliable at this account's near-zero " +
  "attribution coverage (~0.02%, B7) — the store's Magic checkout app bypasses Shopify's own " +
  "session tracking; this is not fixable by re-tagging. Treat this figure as a weak, low-sample " +
  "signal, never as ground truth, and never merge it with metaRoas into one number (§6.2/§6.3).";

function buildWindowOut(label: WindowLabel, w: WindowMetrics, targetRoas: number, floor: number) {
  return {
    window: label,
    shopifyRoas: metricSnapshot(
      "Shopify ROAS",
      w.shopifyRoas,
      targetRoas,
      floor,
      w.seasonality,
      w.shopifyDataGap?.gapDays,
    ),
    shopifyRoasShrunk: w.shopifyRoasShrunk ?? null,
    shopifyDataGap: w.shopifyDataGap ?? null,
    attributionCoverageRatio: w.attributionCoverageRatio ?? null,
    attributionCoverageRatioIncludingNameMatch:
      w.attributionCoverageRatioIncludingNameMatch ?? null,
  };
}

export const getShopifyPerformanceTool = defineTool({
  name: "get_shopify_performance",
  description:
    "Shopify-attributed performance for one AD/ADSET/CAMPAIGN, per window, with the account's " +
    "attribution-coverage caveat attached. Meta-attributed and Shopify-attributed figures are " +
    "never the same number and must never be merged (§6.2/§6.3) — use get_performance for the " +
    "Meta-attributed side.",
  inputSchema: {
    type: "object",
    properties: {
      entityType: { type: "string", enum: SCALABLE_ENTITY_TYPE_JSON_ENUM },
      entityId: { type: "string" },
      windows: { type: "array", items: { type: "string", enum: WINDOW_LABEL_JSON_ENUM } },
    },
    required: ["entityType", "entityId"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const features = await loadFeaturesFor(ctx.db, input.entityType, input.entityId);
    if (!features) {
      return {
        entityType: input.entityType,
        entityId: input.entityId,
        found: false,
        note: "No feature document exists for this entity yet.",
      };
    }
    const thresholds = resolveStatisticalThresholds(ctx.canon);
    const requested = input.windows ?? (["7d", "14d", "28d", "56d"] as const);
    const windows = requested
      .filter((label) => features.windows?.[label])
      .map((label) =>
        buildWindowOut(
          label,
          features.windows[label] as WindowMetrics,
          thresholds.targetRoas,
          thresholds.minPurchaseFloors[label],
        ),
      );
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      found: true,
      windows,
      note: ATTRIBUTION_COVERAGE_NOTE,
    };
  },
});
