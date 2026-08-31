// §18 get_decision_evidence() — D1's full §14 evidence object for ANY entity, not only the one
// the packet was built for. This is how the model checks a comparison entity ("what about AS-12
// which had a similar spend last month?") without a second job/packet round-trip. Read-only:
// unlike `generateAndCacheDecisionPacket` (D2), this calls `resolveScalingEvidence` directly and
// never writes a `decisionPackets` document — a mid-reasoning tool call should not have a side
// effect on the packet cache.

import { z } from "zod";
import type { Firestore } from "firebase-admin/firestore";
import { accountFeaturesSchema, type EntityFeatures } from "@shared/schema/index.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { renderDecisionPacketText, resolveScalingEvidence } from "@services/evidence/index.ts";
import { defineTool, SCALABLE_ENTITY_TYPE_JSON_ENUM } from "./types.ts";

const inputSchema = z.object({
  entityType: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  entityId: z.string().min(1),
});

/** Mirrors `decisionPacketStore.ts`'s private `readCurrentAccountDataVersion` — reimplemented
 * here (one line) rather than importing a non-exported function, so this step does not need to
 * add an export to a D2 file it doesn't otherwise touch. */
async function readCurrentAccountDataVersion(db: Firestore, accountId: string): Promise<number> {
  const repo = createRepository<EntityFeatures>(
    db,
    COLLECTIONS.accountFeatures,
    accountFeaturesSchema,
  );
  const doc = await repo.get(accountId);
  return doc?.accountDataVersion ?? 0;
}

export const getDecisionEvidenceTool = defineTool({
  name: "get_decision_evidence",
  description:
    "The full §14 scaling-evidence object for ANY AD/ADSET/CAMPAIGN in the account — multi-" +
    "window performance with intervals, shrunk baseline, eligibility, learning state, creative " +
    "fatigue, recent changes, attribution coverage. Same engine that built the packet you " +
    "already have; use this to look up a COMPARISON entity, not the primary one (already given).",
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
    const result = await resolveScalingEvidence({
      db: ctx.db,
      namedEntity,
      accountId: ctx.canon.accountId,
    });
    const accountDataVersion = await readCurrentAccountDataVersion(ctx.db, ctx.canon.accountId);
    return {
      namedEntity,
      result,
      textRendering: renderDecisionPacketText(result, accountDataVersion),
    };
  },
});
