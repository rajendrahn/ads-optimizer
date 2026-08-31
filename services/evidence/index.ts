// Barrel for D1's scaling evidence engine (§4.1, §14). D2 renders `ScalingEvidenceResult` into
// the model-facing packet; D3's tools call `resolveScalingEvidence` directly.

export {
  resolveDecisionUnit,
  type ChildAdsetBudget,
  type ResolveDecisionUnitInput,
} from "./budgetOwnerResolution.ts";
export { isDelivering } from "./deliveryCheck.ts";
export {
  computeEligibilityAndRange,
  SAFE_RANGE_LOWER_PERCENT,
  SAFE_RANGE_UPPER_PERCENT,
  type EligibilityInput,
  type EligibilityResult,
} from "./eligibility.ts";
export { explainVerdict, type ExplainVerdictInput } from "./verdictExplain.ts";
export { computeRecentMajorChanges, RECENT_STATUS_CHANGE_WINDOW_HOURS } from "./recentChanges.ts";
export { assembleScalingEvidence, type AssembleScalingEvidenceInput } from "./evidenceAssembler.ts";
export {
  loadEntityChain,
  loadChildAdsetBudgets,
  loadEntityFeatures,
  loadAdUrlTagAudit,
  loadCreativeFatigueForAd,
  type EntityChain,
  type CreativeFatigueLookup,
} from "./entityLookup.ts";
export {
  resolveScalingEvidence,
  type ResolveScalingEvidenceOptions,
} from "./scalingEvidenceEngine.ts";
export * from "./types.ts";
