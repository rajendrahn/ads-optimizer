// D1 — Scaling evidence engine. Shared types for §4.1's decision-altitude resolution and §14's
// evidence object. See services/evidence/index.ts for the public surface and
// IMPLEMENTATION_PLAN.md D1's "Notes from implementation" for the design this module follows.

import type {
  BudgetOwnership,
  SeasonalityContextSnapshot,
  ShopifyDataGap,
  WindowLabel,
} from "@shared/schema/index.ts";
import type { Verdict } from "@services/analytics/statistics/index.ts";

/** §4.1: the three entity levels a scaling question can ever be asked about. Deliberately
 * narrower than shared/schema/common.ts's `EntityRef` (which also allows CREATIVE_FAMILY/
 * ACCOUNT) — those two never own budget and are never a valid "named entity" for a scaling
 * question. */
export type ScalableEntityType = "AD" | "ADSET" | "CAMPAIGN";

export interface ScalableEntityRef {
  type: ScalableEntityType;
  id: string;
}

/**
 * Why the evidence engine is answering at a different altitude than the one the user named.
 * `SAMPLE_TOO_SMALL` is the design's own literal reason string (§14's worked example) — used only
 * when the named AD's own primary-window purchase count is below the statistical floor.
 * `*_NOT_BUDGET_OWNER` covers the structural case: Meta's own model means an AD never owns a
 * budget at all (B2's live finding — 0 of 1,139 real ads own budget), and an ADSET/CAMPAIGN can
 * defer to a different level via CBO or ABO regardless of its own volume. A named AD always
 * carries one of these two reasons (never neither), because ads structurally cannot be a budget
 * decision unit in this account's Meta configuration — see budgetOwnerResolution.ts.
 */
export type EscalationReason =
  | "SAMPLE_TOO_SMALL"
  | "AD_NOT_BUDGET_OWNER"
  | "ADSET_NOT_BUDGET_OWNER"
  | "CAMPAIGN_NOT_BUDGET_OWNER";

export interface EscalatedFrom {
  type: ScalableEntityType;
  id: string;
  reason: EscalationReason;
}

/** §4.1's rule 1, resolved. `NO_DECISION_UNIT` covers §4.1's own explicit "budget ownership can
 * legitimately be UNKNOWN" case (B2's 4 real orphaned campaigns) AND a D1-specific extension of
 * the same principle: a named CAMPAIGN that defers to ad-set level but has more than one ad set
 * independently owning budget has no single decision unit either — see budgetOwnerResolution.ts's
 * module comment for why that is the same kind of "do not guess a level" situation, not a new
 * concept. */
export type DecisionUnitResolution =
  | {
      kind: "RESOLVED";
      decisionUnit: ScalableEntityRef;
      escalatedFrom?: EscalatedFrom;
    }
  | { kind: "NO_DECISION_UNIT"; detail: string };

/** Reasons `eligibleToScale` can be false. Every reason present is independently true — this is
 * not a priority-ordered single cause, it is the full set of gates that failed. */
export type IneligibilityReason =
  | "NOT_DELIVERING"
  | "ROAS_NOT_ABOVE_TARGET"
  | "CPA_ABOVE_TARGET"
  | "IN_LEARNING_PHASE"
  | "RECENT_MAJOR_CHANGE";

/** One metric's value + interval + purchase count, exactly §14's worked-example shape
 * (`{"value":3.91,"interval":[3.10,4.82],"purchases":128}`), reused across every window and
 * across both Meta- and Shopify-attributed figures. `null` throughout means C2 never measured
 * this (§6.3 — an unresolvable ad's Shopify figures, or a window with zero Meta rows), not a
 * measured zero. */
export interface MetricSnapshot {
  value: number | null;
  interval: [number | null, number | null];
  purchases: number;
  verdict: Verdict | null;
  /** Human-readable reason the verdict is what it is — required reading per §15.2 ("the
   * interval appears in the packet text, not only the JSON") and reality #5 (a suppressed
   * verdict's reason must travel with it, not just the boolean). Always present, even for a
   * confident verdict. */
  verdictReason: string;
}

/** One window's worth of evidence — the multi-window performance §14 asks for. */
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
  seasonality: SeasonalityContextSnapshot;
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
  /** `null` when the decision unit is a CAMPAIGN — §13.1's learning-phase mechanic is an
   * ad/ad-set concept in Meta's own model; C4 deliberately leaves `learningPhase: {}` on
   * CAMPAIGN-typed docs (IMPLEMENTATION_PLAN.md C4's notes). `null` here means "not applicable
   * at this altitude", not "unknown". */
  inLearningPhase: boolean | null;
  conversionsToExitLearning: number | null;
  learningResetAt: string | null;
  learningResetCause: string | null;
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

export interface ShopifyBusinessEvidence {
  attributionCoverageRatio: number | null;
  attributionCoverageRatioIncludingNameMatch: number | null;
  blendedMerAccountOnly: number | null;
  note: string;
}

export interface DeliveryStabilityEvidence {
  isDelivering: boolean;
  spendMinorUnits: number;
  impressions: number;
  frequency: number | null;
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

export interface TargetsEvidence {
  targetRoas: number;
  targetCpaMinorUnits: number;
  /** Whether the targets above came from an operator-supplied settings.statisticalThresholds
   * document or the built-in placeholder default — reality #6: "make it obvious in the evidence
   * object which target a verdict was judged against". */
  source: "settings" | "default";
}

/** The §14 evidence object, assembled for the resolved decision unit. */
export interface ScalingEvidence {
  decisionUnit: ScalableEntityRef;
  decisionUnitName: string | null;
  escalatedFrom?: EscalatedFrom;
  budgetOwner: BudgetOwnership;
  eligibleToScale: boolean;
  ineligibleReasons: IneligibilityReason[];
  suggestedChangePercent: number | null;
  safeRangePercent: [number, number] | null;
  confidence: number;
  accountDataVersion: number;
  primaryWindow: WindowLabel;
  targets: TargetsEvidence;
  evidence: {
    windows: Partial<Record<WindowLabel, WindowEvidence>>;
    // Flattened, §14-literal convenience fields mirroring the design's own worked example
    // (roas28d / roas28dShrunk / cpa28d / verdict / targetRoas), always referencing
    // `primaryWindow` — a small, mechanical flattening of `evidence.windows`, per A2's own
    // "Ambiguity #2" note on shared/schema/features.ts.
    roas28d: MetricSnapshot | null;
    roas28dShrunk: number | null;
    cpa28d: MetricSnapshot | null;
    verdict: Verdict | null;
    targetRoas: number;
    shopify: ShopifyBusinessEvidence;
    funnel: FunnelHealthEvidence;
    deliveryStability: DeliveryStabilityEvidence;
    learningState: LearningStateEvidence;
    creativeFatigue: CreativeFatigueEvidence;
    recentChanges: RecentChangesEvidence;
    seasonality: SeasonalityContextSnapshot;
  };
}

/** The top-level result of asking D1 for a scaling decision on a named entity. A discriminated
 * union rather than a single always-populated shape — reality #2/#3 are first-class OUTCOMES,
 * not edge cases folded into `ScalingEvidence` with a lot of nulled-out fields. */
export type ScalingEvidenceResult =
  | { outcome: "NO_DECISION_UNIT"; namedEntity: ScalableEntityRef; detail: string }
  | {
      outcome: "NOT_DELIVERING";
      namedEntity: ScalableEntityRef;
      decisionUnit: ScalableEntityRef;
      decisionUnitName: string | null;
      escalatedFrom?: EscalatedFrom;
      primaryWindow: WindowLabel;
      detail: string;
    }
  | { outcome: "EVIDENCE"; evidence: ScalingEvidence };
