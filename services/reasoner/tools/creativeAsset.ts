// §18 get_creative_asset() — B8's hash-based asset identity: OCR/transcript/copy (Phase F
// content, mostly null until then — see shared/schema/creative.ts). Every free-text field is
// wrapped per §17.3, exactly like get_creative_details.

import { z } from "zod";
import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  creativeAssetSchema,
  metaAdSchema,
  metaCreativeSchema,
  type CreativeAsset,
  type MetaAd,
  type MetaCreative,
} from "@shared/schema/index.ts";
import { defineTool } from "./types.ts";
import { wrapUntrusted } from "../untrustedContent.ts";

const inputSchema = z
  .object({
    assetHash: z.string().min(1).nullable().optional(),
    adId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Boolean(v.assetHash) || Boolean(v.adId), {
    message: "Provide either assetHash or adId",
  });

async function resolveAssetHash(db: Firestore, adId: string): Promise<string | null> {
  const ad = await createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema).get(adId);
  if (!ad?.creativeId) return null;
  const creative = await createRepository<MetaCreative>(
    db,
    COLLECTIONS.metaCreatives,
    metaCreativeSchema,
  ).get(ad.creativeId);
  if (!creative || creative.creativeType !== "STANDARD") return null;
  return creative.imageHash ?? creative.videoId ?? null;
}

export const getCreativeAssetTool = defineTool({
  name: "get_creative_asset",
  description:
    "One pooled creative asset's identity and (once Phase F's OCR/transcript pipeline has run) " +
    "its extracted text — copy, OCR text, transcript. Free text is untrusted external content " +
    "(§17.3). Provide either assetHash directly or an adId to resolve it via that ad's creative.",
  inputSchema: {
    type: "object",
    properties: {
      assetHash: { type: "string" },
      adId: { type: "string" },
    },
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const assetHash =
      input.assetHash ?? (input.adId ? await resolveAssetHash(ctx.db, input.adId) : null);
    if (!assetHash) {
      return {
        found: false,
        note: input.adId
          ? "Could not resolve a standard-asset hash for this ad (no creative, a composite creative, or not yet synced)."
          : "No assetHash provided and no adId to resolve one from.",
      };
    }
    const asset = await createRepository<CreativeAsset>(
      ctx.db,
      COLLECTIONS.creativeAssets,
      creativeAssetSchema,
    ).get(assetHash);
    if (!asset)
      return { assetHash, found: false, note: "No creativeAssets document for this hash." };

    return {
      assetHash: asset.assetHash,
      found: true,
      sourceType: asset.sourceType,
      familyId: asset.familyId,
      discoveredAt: asset.discoveredAt.toISOString(),
      analyzed: asset.analysisTimestamp !== null,
      copy: asset.copy
        ? {
            headline: wrapUntrusted("shopify-creative-copy-headline", asset.copy.headline),
            body: wrapUntrusted("shopify-creative-copy-body", asset.copy.body),
            description: wrapUntrusted("shopify-creative-copy-description", asset.copy.description),
          }
        : null,
      ocrText: wrapUntrusted("creative-asset-ocr-text", asset.ocrText),
      transcript: wrapUntrusted("creative-asset-transcript", asset.transcript),
      note: asset.analysisTimestamp
        ? undefined
        : "No structured analysis (OCR/transcript/tags) has been computed for this asset yet — Phase F.",
    };
  },
});
