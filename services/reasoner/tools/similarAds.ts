// §18 get_similar_ads() — embedding-based creative similarity search. Deferred to Phase F
// (§11.2: "Embeddings and similarity search" is Slice 5 work; not built yet — every
// `creativeAssets.embedding` field in this account is null). This tool is honest about that
// rather than faking a result: it always returns `available: false` today. Kept in the tool
// surface now (rather than omitted) because §18 names it explicitly and D3's job is to wire the
// tool surface, not to pre-judge which entries in it Phase F hasn't filled in yet.

import { z } from "zod";
import { defineTool } from "./types.ts";

const inputSchema = z.object({
  adId: z.string().min(1),
  limit: z.number().int().positive().max(20).nullable().optional(),
});

export const getSimilarAdsTool = defineTool({
  name: "get_similar_ads",
  description:
    "Find creatives similar to this ad's, by embedding distance. NOT YET AVAILABLE — creative " +
    "embeddings are Phase F work (§11.2) and have not been computed for this account. Calling " +
    "this tool always returns an honest 'not available' result, never a fabricated match list.",
  inputSchema: {
    type: "object",
    properties: {
      adId: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["adId"],
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: (input) =>
    Promise.resolve({
      adId: input.adId,
      available: false,
      reason:
        "Embedding-based creative similarity search is deferred to Phase F (§11.2) — no " +
        "embeddings have been computed for this account yet.",
      results: [],
    }),
});
