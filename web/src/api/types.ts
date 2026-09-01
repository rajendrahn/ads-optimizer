// D6 — the browser's own copy of the API's wire types. Hand-mirrored from
// web/server/types.ts (`RecommendationView` and friends) — kept deliberately independent rather
// than imported, since web/src must never import server-only code (see firebase.ts's own comment
// and web/eslint.config.js's `no-restricted-imports` rule, which enforces that structurally). A
// field renamed on one side surfaces immediately as a TypeScript error wherever a component reads
// the changed/missing field — this file is the one place to update when server/types.ts changes.

export type RecommendationStatus = "PENDING" | "GENERATING" | "COMPLETE" | "FAILED" | "REJECTED";

export type RecommendationType =
  | "INCREASE_BUDGET"
  | "REDUCE_BUDGET"
  | "HOLD"
  | "PAUSE"
  | "RESTART"
  | "LAUNCH_NEW_CREATIVE_TEST"
  | "REFRESH_CREATIVE_FAMILY"
  | "INVESTIGATE_LANDING_PAGE"
  | "INVESTIGATE_PRODUCT_OR_PRICE"
  | "INVESTIGATE_TRACKING"
  | "CONSOLIDATE_ADSETS"
  | "INSUFFICIENT_DATA";

export type EntityType = "AD" | "ADSET" | "CAMPAIGN" | "CREATIVE_FAMILY" | "ACCOUNT";
export type ScalableEntityType = "AD" | "ADSET" | "CAMPAIGN";

export interface EntityRef {
  type: EntityType;
  id: string;
}

export interface ScalableEntityRef {
  type: ScalableEntityType;
  id: string;
}

export interface EscalatedFrom {
  type: ScalableEntityType;
  id: string;
  reason: string;
}

export type Verdict = "ABOVE_TARGET" | "BELOW_TARGET" | "NOT_DISTINGUISHABLE";

/** §14/§24's one metric shape. `purchases` is REQUIRED (not optional) — see
 * ../components/RoasMetric.tsx for why that is what makes "never a ROAS without its sample size"
 * a compile-time guarantee, not a rendering convention. */
export interface MetricSnapshot {
  value: number | null;
  interval: [number | null, number | null];
  purchases: number;
  verdict: Verdict | null;
  verdictReason: string;
}

export interface ShopifyDataGap {
  windowHasDataGap: boolean;
  gapDays: string[];
}

export interface SeasonalityContext {
  labels: string[];
  spansSeasonalBoundary: boolean;
  demandIndex: number | null;
  demandIndexSampleSize: number;
  summaryText: string;
}

export type WindowLabel = "7d" | "14d" | "28d" | "56d";

export interface WindowEvidence {
  window: WindowLabel;
  spendMinorUnits: number;
  metaRoas: MetricSnapshot;
  metaRoasShrunk: number | null;
  cpaMinorUnits: MetricSnapshot;
  shopifyRoas: MetricSnapshot;
  shopifyRoasShrunk: number | null;
  shopifyDataGap: ShopifyDataGap | null;
  attributionCoverageRatio: number | null;
  ctr: number | null;
  cvr: number | null;
  frequency: number | null;
  seasonality: SeasonalityContext;
}

export interface TargetsEvidence {
  targetRoas: number;
  targetCpaMinorUnits: number;
  source: "settings" | "default";
}

export interface ShopifyBusinessEvidence {
  attributionCoverageRatio: number | null;
  attributionCoverageRatioIncludingNameMatch: number | null;
  blendedMerAccountOnly: number | null;
  note: string;
}

export interface CreativeFatigueEvidence {
  applicable: boolean;
  familyId: string | null;
  creativeType: "STANDARD" | "COMPOSITE" | null;
  eligibleForFamilyFatigueScore: boolean | null;
  fatigueScore: number | null;
  variationCount: number | null;
  note: string;
}

export interface RecentChangesEvidence {
  recentMajorChanges: boolean;
  hoursSinceLastBudgetChange: number | null;
  lastBudgetChangePercent: number | null;
  budgetChangesLast7Days: number | null;
  hoursSinceLastAudienceChange: number | null;
  targetingChangesLast14Days: number | null;
  hoursSinceLastCreativeChange: number | null;
  creativeChangesLast7Days: number | null;
  hoursSinceLastStatusChange: number | null;
}

export interface LearningStateEvidence {
  inLearningPhase: boolean | null;
  conversionsToExitLearning: number | null;
  learningResetAt: string | null;
  learningResetCause: string | null;
}

export interface FunnelHealthEvidence {
  ctr: number | null;
  ctrTrend: "UP" | "DOWN" | "STABLE" | null;
  cvr: number | null;
  cvrTrend: "UP" | "DOWN" | "STABLE" | null;
  addToCartRate: number | null;
  checkoutStartedRate: number | null;
  purchaseRate: number | null;
}

export interface ScalingEvidence {
  decisionUnit: ScalableEntityRef;
  decisionUnitName: string | null;
  escalatedFrom?: EscalatedFrom;
  budgetOwner: {
    ownerLevel: "CAMPAIGN" | "ADSET" | "UNKNOWN";
    dailyBudgetMinorUnits: number | null;
    lifetimeBudgetMinorUnits: number | null;
    currency: string;
  };
  eligibleToScale: boolean;
  ineligibleReasons: string[];
  suggestedChangePercent: number | null;
  safeRangePercent: [number, number] | null;
  confidence: number;
  accountDataVersion: number;
  primaryWindow: WindowLabel;
  targets: TargetsEvidence;
  evidence: {
    windows: Partial<Record<WindowLabel, WindowEvidence>>;
    roas28d: MetricSnapshot | null;
    roas28dShrunk: number | null;
    cpa28d: MetricSnapshot | null;
    verdict: Verdict | null;
    targetRoas: number;
    shopify: ShopifyBusinessEvidence;
    funnel: FunnelHealthEvidence;
    deliveryStability: {
      isDelivering: boolean;
      spendMinorUnits: number;
      impressions: number;
      frequency: number | null;
    };
    learningState: LearningStateEvidence;
    creativeFatigue: CreativeFatigueEvidence;
    recentChanges: RecentChangesEvidence;
    seasonality: SeasonalityContext;
  };
}

export interface NotDeliveringEvidence {
  namedEntity: ScalableEntityRef;
  decisionUnit: ScalableEntityRef;
  decisionUnitName: string | null;
  escalatedFrom: EscalatedFrom | null;
  primaryWindow: WindowLabel;
  detail: string;
}

export interface NoDecisionUnitEvidence {
  namedEntity: ScalableEntityRef;
  detail: string;
}

export type DecisionPacketView =
  | {
      outcome: "EVIDENCE";
      namedEntity: EntityRef | null;
      decisionUnit: EntityRef | null;
      escalatedFrom: EscalatedFrom | null;
      accountDataVersion: number;
      isStale: boolean;
      createdAt: string;
      textRendering: string | null;
      evidence: ScalingEvidence;
    }
  | {
      outcome: "NOT_DELIVERING";
      namedEntity: EntityRef | null;
      decisionUnit: EntityRef | null;
      escalatedFrom: EscalatedFrom | null;
      accountDataVersion: number;
      isStale: boolean;
      createdAt: string;
      textRendering: string | null;
      evidence: NotDeliveringEvidence;
    }
  | {
      outcome: "NO_DECISION_UNIT";
      namedEntity: EntityRef | null;
      decisionUnit: EntityRef | null;
      escalatedFrom: EscalatedFrom | null;
      accountDataVersion: number;
      isStale: boolean;
      createdAt: string;
      textRendering: string | null;
      evidence: NoDecisionUnitEvidence;
    };

export interface GuardrailViolation {
  code:
    | "MAX_CHANGE_PERCENT_EXCEEDED"
    | "MIN_SPEND_NOT_MET"
    | "MIN_PURCHASES_NOT_MET"
    | "DECISION_UNIT_NOT_BUDGET_OWNER"
    | "NO_DECISION_UNIT"
    | "NOT_DELIVERING";
  message: string;
  judgedAgainst: {
    field: string;
    limit: number;
    source: "settings" | "default";
    actual: number | null;
  } | null;
}

export interface GuardrailRejection {
  reason: string;
  violations: GuardrailViolation[];
  decisionUnitClaimedByModel: EntityRef | null;
  decisionUnitResolved: EntityRef | null;
  rejectedAt: string;
}

export interface RecommendationProvenance {
  model: string;
  provider: "anthropic";
  promptVersion: string;
  decisionEngineVersion: string;
  featureVersion: number;
  dataVersion: number;
  generatedAt: string;
  dataFreshThrough: string;
  adOptimizationKnowledgeVersion: string | null;
}

export interface RecommendationView {
  recommendationId: string;
  status: RecommendationStatus;
  requestedBy: string | null;
  requestedQuestion: string | null;
  namedEntity: ScalableEntityRef | null;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
  action: RecommendationType | null;
  decisionUnit: EntityRef | null;
  currentBudgetMinorUnits: number | null;
  recommendedBudgetMinorUnits: number | null;
  currency: string;
  changePercent: number | null;
  confidence: number | null;
  summary: string | null;
  primaryReasons: string[] | null;
  risks: string[] | null;
  doNotDo: string[] | null;
  recheckConditions: {
    minimumAdditionalSpendMinorUnits: number | null;
    minimumAdditionalPurchases: number | null;
  } | null;
  guardrailRejection: GuardrailRejection | null;
  provenance: RecommendationProvenance | null;
  acceptedAt: string | null;
  rejectedByUserAt: string | null;
  reportingTimezone: string;
  packet: DecisionPacketView | null;
}

export interface RecommendationSummary {
  recommendationId: string;
  status: RecommendationStatus;
  namedEntity: ScalableEntityRef | null;
  requestedQuestion: string | null;
  action: RecommendationType | null;
  createdAt: string;
  updatedAt: string;
}
