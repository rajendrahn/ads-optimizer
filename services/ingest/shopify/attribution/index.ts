// Barrel for B7's attribution join (§6).

export {
  normalizeUtmSource,
  parseAttributionTag,
  type NormalizedUtmSource,
  type ParsedAttributionTag,
} from "./utmTag.ts";
export {
  normalizeEntityName,
  buildNameIndex,
  lookupByName,
  type NormalizedName,
  type NameIndexEntry,
  type NameLookupResult,
} from "./nameMatch.ts";
export {
  resolveOrderAttribution,
  buildAttributionIndexFromEntities,
  AD_ID_CONFIDENCE,
  NAME_MATCH_CONFIDENCE,
  type ResolutionMethod,
  type AttributionIndex,
  type AdNameCandidate,
  type CampaignNameCandidate,
  type OrderAttributionResolution,
} from "./resolveOrder.ts";
export { buildAttributionIndex } from "./attributionIndex.ts";
export {
  recomputeAndPersistAttribution,
  shopifyResolveAttributionHandler,
  shopifyResolveAttributionRegistration,
  type RecomputeAttributionResult,
} from "./resolveAttribution.ts";
export {
  auditAdDestinationUrl,
  runUrlTagAudit,
  auditAdUrlTagsHandler,
  auditAdUrlTagsRegistration,
  type AdUrlAuditResult,
  type RunUrlTagAuditResult,
} from "./urlAudit.ts";
export {
  tallyResolvedOrders,
  computeAttributionCoverageRatio,
  type ResolvedOrderForCoverage,
  type AttributedPurchaseCounts,
  type AttributionCoverageResult,
} from "./coverage.ts";
export { computeBlendedMer } from "./mer.ts";
