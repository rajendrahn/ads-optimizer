// §18 get_delivery_state() — D1's own "not delivering, not merely low-volume" distinction
// (deliveryCheck.ts's `isDelivering`), exposed as a tool so the model can check a comparison
// entity's delivery state without escalating a full decision-evidence resolution for it.

import { z } from "zod";
import { isDelivering } from "@services/evidence/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM, WINDOW_LABEL_JSON_ENUM } from "./types.ts";
import { loadFeaturesFor } from "./shared.ts";

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  entityId: z.string().min(1),
  window: z.enum(["7d", "14d", "28d", "56d"]).default("28d"),
});

export const getDeliveryStateTool = defineTool({
  name: "get_delivery_state",
  description:
    "Whether an entity is actually delivering (spend > 0 or impressions > 0) in a window, plus " +
    "spend/impressions/frequency — the distinction between 'not delivering' and 'delivering but " +
    "low volume', which matter differently for a scaling decision.",
  inputSchema: {
    type: "object",
    properties: {
      entityType: { type: "string", enum: SCALABLE_ENTITY_TYPE_JSON_ENUM },
      entityId: { type: "string" },
      window: { type: "string", enum: WINDOW_LABEL_JSON_ENUM, description: "Defaults to 28d." },
    },
    required: ["entityType", "entityId"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const features = await loadFeaturesFor(ctx.db, input.entityType, input.entityId);
    const window = features?.windows?.[input.window];
    if (!features) {
      return {
        entityType: input.entityType,
        entityId: input.entityId,
        window: input.window,
        isDelivering: false,
        note: "No feature document exists yet for this entity — treated as not delivering, not as unknown.",
      };
    }
    return {
      entityType: input.entityType,
      entityId: input.entityId,
      window: input.window,
      isDelivering: isDelivering(window),
      spendMinorUnits: window?.spendMinorUnits ?? 0,
      impressions: window?.impressions ?? 0,
      reach: window?.reach ?? 0,
      frequency: window?.frequency ?? null,
    };
  },
});
