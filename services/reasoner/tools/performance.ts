// §18 get_performance() — Meta-attributed performance for ANY entity the model names (not just
// the one the packet is about — e.g. a comparable ad set). Reads the same already-computed
// `EntityFeatures` windows D1 reads (C2/C3/C4's output) and reshapes them into the same
// MetricSnapshot-with-uncertainty shape §14 uses — never a daily row.

import { z } from "zod";
import { resolveStatisticalThresholds } from "@shared/canon/index.ts";
import type { WindowLabel, WindowMetrics } from "@shared/schema/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM, WINDOW_LABEL_JSON_ENUM } from "./types.ts";
import { loadFeaturesFor, metricSnapshot, moneySnapshot } from "./shared.ts";

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  entityId: z.string().min(1),
  windows: z.array(z.enum(["7d", "14d", "28d", "56d"])).optional(),
});

function buildWindowOut(
  label: WindowLabel,
  w: WindowMetrics,
  targetRoas: number,
  targetCpaMinorUnits: number,
  floor: number,
  currency: string,
) {
  const seasonality = w.seasonality;
  return {
    window: label,
    spendMinorUnits: w.spendMinorUnits ?? 0,
    impressions: w.impressions ?? 0,
    metaRoas: metricSnapshot("Meta ROAS", w.metaRoas, targetRoas, floor, seasonality, undefined),
    metaRoasShrunk: w.metaRoasShrunk ?? null,
    cpaMinorUnits: moneySnapshot(
      "CPA (Meta)",
      w.cpa,
      targetCpaMinorUnits,
      floor,
      seasonality,
      currency,
    ),
    ctr: w.ctr ?? null,
    cvr: w.cvr ?? null,
    frequency: w.frequency ?? null,
    cpmMinorUnits: w.cpmMinorUnits ?? null,
  };
}

export const getPerformanceTool = defineTool({
  name: "get_performance",
  description:
    "Meta-attributed performance for one AD/ADSET/CAMPAIGN, per window, with confidence " +
    "intervals, sample sizes and verdicts already computed — never raw daily insight rows. Use " +
    "this to check a comparison entity's numbers (the packet already gives you the primary " +
    "entity's evidence).",
  inputSchema: {
    type: "object",
    properties: {
      entityType: { type: "string", enum: SCALABLE_ENTITY_TYPE_JSON_ENUM },
      entityId: { type: "string" },
      windows: {
        type: "array",
        items: { type: "string", enum: WINDOW_LABEL_JSON_ENUM },
        description: "Defaults to every window this entity has computed data for.",
      },
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
        note: "No feature document exists for this entity yet (no completed feature recompute has reached it).",
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
          thresholds.targetCpaMinorUnits,
          thresholds.minPurchaseFloors[label],
          ctx.canon.reportingCurrency,
        ),
      );
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      found: true,
      accountDataVersion: features.accountDataVersion,
      windows,
      trend: features.trend,
    };
  },
});
