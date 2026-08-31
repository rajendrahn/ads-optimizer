// Assembles the §14 evidence object from an already-resolved decision unit's already-computed
// EntityFeatures doc (C2 base metrics + C3 intervals/shrinkage/verdicts + C4 change-aware/
// learning-phase fields) plus the handful of pieces that live outside that one document (budget
// ownership, account targets, creative-family fatigue). Pure — no Firestore here; all inputs are
// already-fetched plain objects, so this is fully unit-testable.

import type {
  BudgetOwnership,
  EntityFeatures,
  WindowLabel,
  WindowMetrics,
} from "@shared/schema/index.ts";
import type { Verdict } from "@services/analytics/statistics/index.ts";
import { isDelivering } from "./deliveryCheck.ts";
import { computeRecentMajorChanges } from "./recentChanges.ts";
import { explainVerdict } from "./verdictExplain.ts";
import { formatMinorUnitsAsDecimal } from "@shared/canon/index.ts";
import type {
  CreativeFatigueEvidence,
  EscalatedFrom,
  MetricSnapshot,
  ScalableEntityRef,
  ScalingEvidence,
  TargetsEvidence,
  WindowEvidence,
} from "./types.ts";
import type { EligibilityResult } from "./eligibility.ts";
import type { CreativeFamily } from "@shared/schema/index.ts";

const PRIMARY_WINDOW: WindowLabel = "28d";

/** C2's own precedent for turning a numeric trend-percent into a category (recomputeFeaturesTask's
 * `purchaseVolumeTrend` uses a flat ±10% band, documented as deliberately simple) — reused here
 * for ctrTrend/cvrTrend, which §14's own worked example renders categorically ("STABLE"/"UP")
 * even though C2 only stores the numeric percent change. Same band, same rationale. */
function categorizeTrend(
  changePercent: number | null | undefined,
): "UP" | "DOWN" | "STABLE" | null {
  if (changePercent === null || changePercent === undefined) return null;
  if (changePercent > 10) return "UP";
  if (changePercent < -10) return "DOWN";
  return "STABLE";
}

interface RawMetricLike {
  value: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  sampleSize: number;
  verdict: Verdict | null;
}

function metricSnapshot(
  label: string,
  metric: RawMetricLike | undefined,
  target: number,
  minPurchaseFloor: number,
  seasonality: { spansSeasonalBoundary: boolean; labels: readonly string[] } | undefined,
  gap?: { windowHasDataGap: boolean; gapDays: readonly string[] },
  /** Pass for a money metric so the explanation renders minor units as currency — see
   * `explainVerdict`'s `formatValue`. Omit for a ratio metric like ROAS. */
  formatValue?: (value: number) => string,
): MetricSnapshot {
  const m = metric ?? {
    value: null,
    intervalLow: null,
    intervalHigh: null,
    sampleSize: 0,
    verdict: null,
  };
  return {
    value: m.value,
    interval: [m.intervalLow, m.intervalHigh],
    purchases: m.sampleSize,
    verdict: m.verdict,
    verdictReason: explainVerdict({
      label,
      value: m.value,
      verdict: m.verdict,
      intervalLow: m.intervalLow,
      intervalHigh: m.intervalHigh,
      sampleSize: m.sampleSize,
      minPurchaseFloor,
      target,
      spansSeasonalBoundary: seasonality?.spansSeasonalBoundary ?? false,
      seasonalityLabels: seasonality?.labels ?? [],
      windowHasDataGap: gap?.windowHasDataGap,
      gapDays: gap?.gapDays,
      formatValue,
    }),
  };
}

function buildWindowEvidence(
  label: WindowLabel,
  window: WindowMetrics,
  targets: TargetsEvidence,
  minPurchaseFloors: Readonly<Record<WindowLabel, number>>,
  reportingCurrency: string,
): WindowEvidence {
  const floor = minPurchaseFloors[label];
  const seasonality = window.seasonality ?? {
    labels: [],
    spansSeasonalBoundary: false,
    demandIndex: null,
    demandIndexSampleSize: 0,
    summaryText: "",
  };
  return {
    window: label,
    spendMinorUnits: window.spendMinorUnits ?? 0,
    metaRoas: metricSnapshot("Meta ROAS", window.metaRoas, targets.targetRoas, floor, seasonality),
    metaRoasShrunk: window.metaRoasShrunk ?? null,
    cpaMinorUnits: metricSnapshot(
      "CPA (Meta)",
      window.cpa,
      targets.targetCpaMinorUnits,
      floor,
      seasonality,
      undefined,
      // CPA is money in integer minor units — without this the sentence would read
      // "INR 1761.00 is confidently above the target of 150000", which contradicts itself.
      (value) =>
        formatMinorUnitsAsDecimal({
          amountMinorUnits: Math.round(value),
          currency: reportingCurrency,
        }),
    ),
    shopifyRoas: metricSnapshot(
      "Shopify ROAS",
      window.shopifyRoas,
      targets.targetRoas,
      floor,
      seasonality,
      window.shopifyDataGap ?? undefined,
    ),
    shopifyRoasShrunk: window.shopifyRoasShrunk ?? null,
    shopifyDataGap: window.shopifyDataGap ?? null,
    attributionCoverageRatio: window.attributionCoverageRatio ?? null,
    ctr: window.ctr ?? null,
    cvr: window.cvr ?? null,
    frequency: window.frequency ?? null,
    seasonality,
  };
}

function buildCreativeFatigue(
  familyId: string | null,
  family: CreativeFamily | null,
  applicableReason: string | null,
): CreativeFatigueEvidence {
  if (!familyId || !family) {
    return {
      applicable: false,
      familyId,
      creativeType: null,
      eligibleForFamilyFatigueScore: null,
      fatigueScore: null,
      variationCount: null,
      note:
        applicableReason ??
        "No creative family could be identified for this request (creative fatigue is a per-ad, " +
          "per-creative-family concept — ask about a specific ad to see its family's signal).",
    };
  }
  return {
    applicable: true,
    familyId: family.familyId,
    creativeType: family.creativeType,
    eligibleForFamilyFatigueScore: family.eligibleForFamilyFatigueScore,
    fatigueScore: family.fatigueScore,
    variationCount: family.variationCount,
    note: !family.eligibleForFamilyFatigueScore
      ? "This is a COMPOSITE (dynamic/Advantage+) creative — §7.3 excludes composites from " +
        "family-level fatigue scoring, since the delivered creative mix is not observable."
      : family.fatigueScore === null
        ? "No fatigue score has been computed for this creative family yet."
        : `Family-level fatigue score: ${family.fatigueScore}.`,
  };
}

export interface AssembleScalingEvidenceInput {
  decisionUnit: ScalableEntityRef;
  decisionUnitName: string | null;
  escalatedFrom?: EscalatedFrom;
  budgetOwner: BudgetOwnership;
  features: EntityFeatures;
  targets: TargetsEvidence;
  minPurchaseFloors: Readonly<Record<WindowLabel, number>>;
  eligibility: EligibilityResult;
  creativeFamilyId: string | null;
  creativeFamily: CreativeFamily | null;
  creativeFatigueNotApplicableReason: string | null;
  /** The canon reporting currency, used to render money metrics (CPA) as currency in the
   * verdict explanation rather than raw minor units — see `explainVerdict`'s `formatValue`. */
  reportingCurrency: string;
}

export function assembleScalingEvidence(input: AssembleScalingEvidenceInput): ScalingEvidence {
  const { features } = input;
  const windows: Partial<Record<WindowLabel, WindowEvidence>> = {};
  const labels: WindowLabel[] = ["7d", "14d", "28d", "56d"];
  for (const label of labels) {
    const w = features.windows?.[label];
    if (w)
      windows[label] = buildWindowEvidence(
        label,
        w,
        input.targets,
        input.minPurchaseFloors,
        input.reportingCurrency,
      );
  }

  const primary = windows[PRIMARY_WINDOW];
  const primaryRaw = features.windows?.[PRIMARY_WINDOW];

  const changeAware = features.changeAware ?? {};
  const learningPhase = features.learningPhase ?? {};
  const recentMajorChanges = computeRecentMajorChanges(features.changeAware);

  return {
    decisionUnit: input.decisionUnit,
    decisionUnitName: input.decisionUnitName,
    escalatedFrom: input.escalatedFrom,
    budgetOwner: input.budgetOwner,
    eligibleToScale: input.eligibility.eligibleToScale,
    ineligibleReasons: input.eligibility.ineligibleReasons,
    suggestedChangePercent: input.eligibility.suggestedChangePercent,
    safeRangePercent: input.eligibility.safeRangePercent,
    confidence: input.eligibility.confidence,
    accountDataVersion: features.accountDataVersion,
    primaryWindow: PRIMARY_WINDOW,
    targets: input.targets,
    evidence: {
      windows,
      roas28d: primary?.metaRoas ?? null,
      roas28dShrunk: primary?.metaRoasShrunk ?? null,
      cpa28d: primary?.cpaMinorUnits ?? null,
      verdict: primary?.metaRoas.verdict ?? null,
      targetRoas: input.targets.targetRoas,
      shopify: {
        attributionCoverageRatio: primaryRaw?.attributionCoverageRatio ?? null,
        attributionCoverageRatioIncludingNameMatch:
          primaryRaw?.attributionCoverageRatioIncludingNameMatch ?? null,
        blendedMerAccountOnly: primaryRaw?.blendedMerAccountOnly ?? null,
        note:
          "Shopify-attributed per-ad/ad-set ROAS is not reliable at this account's near-zero " +
          "attribution coverage (~0.02%, B7) — the store's Magic checkout app bypasses Shopify's " +
          "own session tracking; this is not fixable by re-tagging. Lean on Meta-attributed " +
          "metaRoas/cpa for this decision. blendedMerAccountOnly (Shopify revenue / Meta spend, no " +
          "attribution join) is the trustworthy account-level efficiency figure when coverage is " +
          "low, but it is only ever populated at ACCOUNT level (null here unless this decision " +
          "unit happens to be the whole account).",
      },
      funnel: {
        ctr: primaryRaw?.ctr ?? null,
        ctrTrend: categorizeTrend(features.trend?.ctrChangePercent),
        cvr: primaryRaw?.cvr ?? null,
        cvrTrend: categorizeTrend(features.trend?.cvrChangePercent),
        addToCartRate: primaryRaw?.addToCartRate ?? null,
        checkoutStartedRate: primaryRaw?.checkoutStartedRate ?? null,
        purchaseRate: primaryRaw?.purchaseRate ?? null,
      },
      deliveryStability: {
        isDelivering: isDelivering(primaryRaw),
        spendMinorUnits: primaryRaw?.spendMinorUnits ?? 0,
        impressions: primaryRaw?.impressions ?? 0,
        frequency: primaryRaw?.frequency ?? null,
      },
      learningState: {
        inLearningPhase: learningPhase.inLearningPhase ?? null,
        conversionsToExitLearning: learningPhase.conversionsToExitLearning ?? null,
        learningResetAt: learningPhase.learningResetAt
          ? learningPhase.learningResetAt.toISOString()
          : null,
        learningResetCause: learningPhase.learningResetCause ?? null,
      },
      creativeFatigue: buildCreativeFatigue(
        input.creativeFamilyId,
        input.creativeFamily,
        input.creativeFatigueNotApplicableReason,
      ),
      recentChanges: {
        recentMajorChanges,
        hoursSinceLastBudgetChange: changeAware.hoursSinceLastBudgetChange ?? null,
        lastBudgetChangePercent: changeAware.lastBudgetChangePercent ?? null,
        budgetChangesLast7Days: changeAware.budgetChangesLast7Days ?? null,
        hoursSinceLastAudienceChange: changeAware.hoursSinceLastAudienceChange ?? null,
        targetingChangesLast14Days: changeAware.targetingChangesLast14Days ?? null,
        hoursSinceLastCreativeChange: changeAware.hoursSinceLastCreativeChange ?? null,
        creativeChangesLast7Days: changeAware.creativeChangesLast7Days ?? null,
        hoursSinceLastStatusChange: changeAware.hoursSinceLastStatusChange ?? null,
      },
      seasonality: primaryRaw?.seasonality ?? {
        labels: [],
        spansSeasonalBoundary: false,
        demandIndex: null,
        demandIndexSampleSize: 0,
        summaryText: "No seasonality context available for this window.",
      },
    },
  };
}
