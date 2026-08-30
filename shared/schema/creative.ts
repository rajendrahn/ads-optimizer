// Creative collections — §8: creativeAssets, creativeFamilies.
//
// Identity (B8, §11.1) is cheap and ships in the data foundation; analysis (§11.2 — OCR,
// transcript, embedding, structured tags) is expensive and deferred to Phase F. Most of the
// analysis fields below are typed now and populated later — nullable until then.

import { z } from "zod";
import { firestoreTimestamp } from "./common.ts";

export const creativeAssetSchema = z.object({
  assetHash: z.string().min(1), // image_hash / video_id / perceptual hash — the doc ID
  sourceType: z.enum(["IMAGE", "VIDEO"]),
  metaImageHash: z.string().nullable(),
  metaVideoId: z.string().nullable(),
  perceptualHash: z.string().nullable(), // for near-duplicate grouping (§11.1)
  cloudStoragePath: z.string().nullable(), // Phase F
  thumbnailUrl: z.string().nullable(), // Phase F
  copy: z
    .object({
      headline: z.string().nullable(),
      body: z.string().nullable(),
      description: z.string().nullable(),
    })
    .nullable(),
  ocrText: z.string().nullable(), // Phase F (§11.2)
  transcript: z.string().nullable(), // Phase F (§11.2)
  structuredTags: z.record(z.string(), z.unknown()).nullable(), // Phase F, shape per §7.3 example
  embedding: z.array(z.number()).nullable(), // Phase F
  familyId: z.string().nullable(), // set once B8 groups this asset into a family
  analysisTimestamp: firestoreTimestamp.nullable(),
  analysisModelVersion: z.string().nullable(),
  discoveredAt: firestoreTimestamp,
});
export type CreativeAsset = z.infer<typeof creativeAssetSchema>;

export const creativeFamilySchema = z.object({
  familyId: z.string().min(1),
  memberAssetHashes: z.array(z.string()),
  creativeType: z.enum(["STANDARD", "COMPOSITE"]),
  // §7.3: composites are excluded from family-level fatigue scoring outright.
  eligibleForFamilyFatigueScore: z.boolean(),
  familyAgeDays: z.number().nonnegative().nullable(),
  totalHistoricalSpendMinorUnits: z.number().int().nonnegative().nullable(),
  activeAdsCount: z.number().int().nonnegative().nullable(),
  variationCount: z.number().int().nonnegative().nullable(),
  fatigueScore: z.number().nullable(), // null when ineligible or not yet computed
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
});
export type CreativeFamily = z.infer<typeof creativeFamilySchema>;
