// D6 — wire-format view types the API sends to the browser. Deliberately NOT the raw Firestore
// document shapes: `recommendations/{id}` and `decisionPackets/{id}` (and `guardrailRejections/
// {id}`) are joined into one object here so the client never has to make a second round trip (or
// a direct Firestore read — see server.ts's module comment for why that path is closed) to
// render one card.
//
// This file is intentionally plain TypeScript interfaces, not zod schemas — the shapes below are
// a projection built once in viewModel.ts from already-validated `@shared/schema` documents, not
// a new external input boundary that needs its own runtime validation.
//
// web/src/api/types.ts hand-mirrors the interfaces below for the browser bundle, which must never
// import `@shared/*` (that pulls in `firebase-admin`, a Node-only package — see web/src/README
// notes in App.tsx's module comment). Keep the two in sync by hand; a structural mismatch shows up
// immediately as a TypeScript error in whichever component reads the new/renamed field.

export type RecommendationStatusView =
  "PENDING" | "GENERATING" | "COMPLETE" | "FAILED" | "REJECTED";

export type RecommendationTypeView =
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

export interface EntityRefView {
  type: "AD" | "ADSET" | "CAMPAIGN" | "CREATIVE_FAMILY" | "ACCOUNT";
  id: string;
}

export interface ScalableEntityRefView {
  type: "AD" | "ADSET" | "CAMPAIGN";
  id: string;
}

export interface EscalatedFromView {
  type: "AD" | "ADSET" | "CAMPAIGN";
  id: string;
  /** One of D1's four `EscalationReason` codes (SAMPLE_TOO_SMALL / AD_NOT_BUDGET_OWNER /
   * ADSET_NOT_BUDGET_OWNER / CAMPAIGN_NOT_BUDGET_OWNER) — typed as `string`, not a literal union,
   * because `decisionPacketSchema.escalatedFrom.reason` (shared/schema/decisions.ts) itself
   * stores it as a plain `z.string()`, not an enum; components that branch on a specific reason
   * still compare against the exact literal strings at runtime. */
  reason: string;
}

/** §14/§24's one metric shape — value + interval + purchase count + verdict, always together.
 * `purchases` is a required, non-nullable field on purpose (mirrors
 * services/evidence/types.ts's `MetricSnapshot`) — see web/src/components/RoasMetric.tsx for the
 * structural reason this is what makes "never a ROAS without its sample size" enforceable by the
 * type checker, not just a rendering convention. */
export interface MetricSnapshotView {
  value: number | null;
  interval: [number | null, number | null];
  purchases: number;
  verdict: "ABOVE_TARGET" | "BELOW_TARGET" | "NOT_DISTINGUISHABLE" | null;
  verdictReason: string;
}

export interface ShopifyDataGapView {
  windowHasDataGap: boolean;
  gapDays: string[];
}

export interface SeasonalityContextView {
  labels: string[];
  spansSeasonalBoundary: boolean;
  demandIndex: number | null;
  demandIndexSampleSize: number;
  summaryText: string;
}

export type WindowLabelView = "7d" | "14d" | "28d" | "56d";

/** One window's worth of evidence — §24's "multi-window performance with intervals." Meta- and
 * Shopify-attributed ROAS are two distinct, separately-labelled fields (§6.2/§6.3) — never merged
 * into one number. */
export interface WindowEvidenceView {
  window: WindowLabelView;
  spendMinorUnits: number;
  metaRoas: MetricSnapshotView;
  metaRoasShrunk: number | null;
  cpaMinorUnits: MetricSnapshotView;
  shopifyRoas: MetricSnapshotView;
  shopifyRoasShrunk: number | null;
  shopifyDataGap: ShopifyDataGapView | null;
  attributionCoverageRatio: number | null;
  ctr: number | null;
  cvr: number | null;
  frequency: number | null;
  seasonality: SeasonalityContextView;
}

export interface TargetsEvidenceView {
  targetRoas: number;
  targetCpaMinorUnits: number;
  /** Whether the target above was an operator-configured value or this system's own placeholder
   * default — a verdict is only as good as the target it was judged against (D6's brief). */
  source: "settings" | "default";
}

export interface ShopifyBusinessEvidenceView {
  attributionCoverageRatio: number | null;
  attributionCoverageRatioIncludingNameMatch: number | null;
  blendedMerAccountOnly: number | null;
  note: string;
}

export interface CreativeFatigueEvidenceView {
  applicable: boolean;
  familyId: string | null;
  creativeType: "STANDARD" | "COMPOSITE" | null;
  eligibleForFamilyFatigueScore: boolean | null;
  fatigueScore: number | null;
  variationCount: number | null;
  note: string;
}

export interface RecentChangesEvidenceView {
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

export interface LearningStateEvidenceView {
  inLearningPhase: boolean | null;
  conversionsToExitLearning: number | null;
  learningResetAt: string | null;
  learningResetCause: string | null;
}

export interface FunnelHealthEvidenceView {
  ctr: number | null;
  ctrTrend: "UP" | "DOWN" | "STABLE" | null;
  cvr: number | null;
  cvrTrend: "UP" | "DOWN" | "STABLE" | null;
  addToCartRate: number | null;
  checkoutStartedRate: number | null;
  purchaseRate: number | null;
}

/** §14's evidence object, for the EVIDENCE outcome only. */
export interface ScalingEvidenceView {
  decisionUnit: ScalableEntityRefView;
  decisionUnitName: string | null;
  escalatedFrom?: EscalatedFromView;
  budgetOwner: {
    ownerLevel: "CAMPAIGN" | "ADSET" | "UNKNOWN";
    dailyBudgetMinorUnits: number | null;
    lifetimeBudgetMinorUnits: number | null;
    currency: string;
  };
  eligibleToScale: boolean;
  ineligibleReasons: (
    | "NOT_DELIVERING"
    | "ROAS_NOT_ABOVE_TARGET"
    | "CPA_ABOVE_TARGET"
    | "IN_LEARNING_PHASE"
    | "RECENT_MAJOR_CHANGE"
  )[];
  suggestedChangePercent: number | null;
  safeRangePercent: [number, number] | null;
  confidence: number;
  accountDataVersion: number;
  primaryWindow: WindowLabelView;
  targets: TargetsEvidenceView;
  evidence: {
    windows: Partial<Record<WindowLabelView, WindowEvidenceView>>;
    roas28d: MetricSnapshotView | null;
    roas28dShrunk: number | null;
    cpa28d: MetricSnapshotView | null;
    verdict: "ABOVE_TARGET" | "BELOW_TARGET" | "NOT_DISTINGUISHABLE" | null;
    targetRoas: number;
    shopify: ShopifyBusinessEvidenceView;
    funnel: FunnelHealthEvidenceView;
    deliveryStability: {
      isDelivering: boolean;
      spendMinorUnits: number;
      impressions: number;
      frequency: number | null;
    };
    learningState: LearningStateEvidenceView;
    creativeFatigue: CreativeFatigueEvidenceView;
    recentChanges: RecentChangesEvidenceView;
    seasonality: SeasonalityContextView;
  };
}

export interface NotDeliveringEvidenceView {
  namedEntity: ScalableEntityRefView;
  decisionUnit: ScalableEntityRefView;
  decisionUnitName: string | null;
  escalatedFrom: EscalatedFromView | null;
  primaryWindow: WindowLabelView;
  detail: string;
}

export interface NoDecisionUnitEvidenceView {
  namedEntity: ScalableEntityRefView;
  detail: string;
}

/** The packet, projected for the client — D1's three-outcome discriminant preserved (never
 * flattened into one always-populated shape), plus the text rendering (§15.2: intervals must
 * appear in prose, not only structured fields). */
export type DecisionPacketView =
  | {
      outcome: "EVIDENCE";
      namedEntity: EntityRefView | null;
      decisionUnit: EntityRefView | null;
      escalatedFrom: EscalatedFromView | null;
      accountDataVersion: number;
      isStale: boolean;
      createdAt: string;
      textRendering: string | null;
      evidence: ScalingEvidenceView;
    }
  | {
      outcome: "NOT_DELIVERING";
      namedEntity: EntityRefView | null;
      decisionUnit: EntityRefView | null;
      escalatedFrom: EscalatedFromView | null;
      accountDataVersion: number;
      isStale: boolean;
      createdAt: string;
      textRendering: string | null;
      evidence: NotDeliveringEvidenceView;
    }
  | {
      outcome: "NO_DECISION_UNIT";
      namedEntity: EntityRefView | null;
      decisionUnit: EntityRefView | null;
      escalatedFrom: EscalatedFromView | null;
      accountDataVersion: number;
      isStale: boolean;
      createdAt: string;
      textRendering: string | null;
      evidence: NoDecisionUnitEvidenceView;
    };

/** D5's guardrail-rejection log, projected — "which guardrail rejected it and what limit it was
 * judged against," per the coordinator's own framing. */
export interface GuardrailViolationView {
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

export interface GuardrailRejectionView {
  reason: string;
  violations: GuardrailViolationView[];
  decisionUnitClaimedByModel: EntityRefView | null;
  decisionUnitResolved: EntityRefView | null;
  rejectedAt: string;
}

export interface RecommendationProvenanceView {
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

/** The full joined view of one recommendation, as sent by GET /api/recommendations/:id and every
 * event of the SSE stream at that same route + "/stream". */
export interface RecommendationView {
  recommendationId: string;
  status: RecommendationStatusView;
  requestedBy: string | null;
  requestedQuestion: string | null;
  namedEntity: ScalableEntityRefView | null;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
  action: RecommendationTypeView | null;
  decisionUnit: EntityRefView | null;
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
  guardrailRejection: GuardrailRejectionView | null;
  provenance: RecommendationProvenanceView | null;
  acceptedAt: string | null;
  rejectedByUserAt: string | null;
  reportingTimezone: string;
  packet: DecisionPacketView | null;
}

export interface RecommendationSummaryView {
  recommendationId: string;
  status: RecommendationStatusView;
  namedEntity: ScalableEntityRefView | null;
  requestedQuestion: string | null;
  action: RecommendationTypeView | null;
  createdAt: string;
  updatedAt: string;
}
