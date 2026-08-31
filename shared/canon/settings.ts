// The full settings/{accountId} document schema — A2's `reportingCanonSettingsSchema` (the
// four §5 fields, verbatim and unambiguous) extended with model configuration per §19.2, as
// directed by A2's notes: "A3 owns ... any extension (model config §19.2, statistical
// thresholds §15.1) — extend `reportingCanonSettingsSchema` with `.extend(...)` rather than
// replacing it, so A2's key convention and these four fields stay stable for whatever already
// reads them."
//
// Statistical thresholds (§15.1) — C3's own extension, added the same way modelConfig was:
// `.extend(...)` on top of the existing schema, per A2's original instruction ("don't pre-empt
// C3's judgment call on the shape of those thresholds here"). See statisticalThresholds.ts for
// the shape, the defaults and why the field is optional (not required-with-no-default like
// modelConfig) — that file's own module comment explains the blast-radius reason.

import { z } from "zod";
import { reportingCanonSettingsSchema } from "../schema/settings.ts";
import { statisticalThresholdsSchema } from "./statisticalThresholds.ts";

/**
 * §19.2's model-selection block, verbatim in field names and values. `effort` is left as a
 * non-empty string rather than a `z.enum(...)` — §19.3 documents `output_config.effort` as
 * the depth control but the design does not enumerate its legal values anywhere, and Fable 5's
 * API surface is called out (D3's spec) as having "changed recently"; guessing a wrong enum
 * here would make a legitimate future value fail validation at the loader, which is worse than
 * a loose string. D3 (the first and only step that actually calls the API) is where a stricter
 * check belongs, once it is validating against the real SDK types.
 */
export const modelConfigSchema = z.object({
  recommendationProvider: z.literal("anthropic"),
  recommendationModel: z.string().min(1),
  creativeReasoningModel: z.string().min(1),
  backgroundCreativeTaggingModel: z.string().min(1),
  taggingUsesBatchApi: z.boolean(),
  effort: z.string().min(1),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

/**
 * The complete settings/{accountId} document: A2's four reporting-canon fields plus §19.2's
 * model configuration, nested under `modelConfig` so the document mirrors the two JSON blocks
 * the design shows separately (§5's canon object, §19.2's model-selection object) rather than
 * flattening six more top-level fields onto one object.
 */
export const canonSettingsSchema = reportingCanonSettingsSchema.extend({
  modelConfig: modelConfigSchema,
  // §15.1 — optional (see statisticalThresholds.ts for why), resolved via
  // `resolveStatisticalThresholds()`, never read directly.
  statisticalThresholds: statisticalThresholdsSchema.optional(),
});
export type CanonSettings = z.infer<typeof canonSettingsSchema>;
