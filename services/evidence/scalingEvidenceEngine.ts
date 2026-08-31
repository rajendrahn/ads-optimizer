// D1's public entry point: resolve a named entity to a budget-scaling decision unit (§4.1) and
// assemble the §14 evidence object for it, or report why no evidence could be produced.
//
// This is a synchronous, on-demand query function — not a Cloud Tasks job. It reads only
// already-computed collections (B2's Meta entities, B8's creative identity, C2/C3/C4's feature
// docs, A3/C3's settings) and makes no live Meta/Shopify call and no write of any kind. D2
// renders its `ScalingEvidenceResult` into the model-facing packet; D3's tools call this
// function directly rather than re-deriving any of this.

import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "@shared/firestore/index.ts";
import { loadReportingCanon, resolveStatisticalThresholds } from "@shared/canon/index.ts";
import type { WindowLabel } from "@shared/schema/index.ts";
import { resolveDecisionUnit } from "./budgetOwnerResolution.ts";
import { isDelivering } from "./deliveryCheck.ts";
import { computeEligibilityAndRange } from "./eligibility.ts";
import { assembleScalingEvidence } from "./evidenceAssembler.ts";
import { computeRecentMajorChanges } from "./recentChanges.ts";
import {
  loadChildAdsetBudgets,
  loadCreativeFatigueForAd,
  loadEntityChain,
  loadEntityFeatures,
} from "./entityLookup.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  metaAdsetSchema,
  metaCampaignSchema,
  type MetaAdset,
  type MetaCampaign,
} from "@shared/schema/index.ts";
import type { BudgetOwnership } from "@shared/schema/index.ts";
import type { ScalableEntityRef, ScalingEvidenceResult } from "./types.ts";

const PRIMARY_WINDOW: WindowLabel = "28d";

export interface ResolveScalingEvidenceOptions {
  db?: Firestore;
  namedEntity: ScalableEntityRef;
  accountId?: string;
}

async function loadDecisionUnitDoc(
  db: Firestore,
  decisionUnit: ScalableEntityRef,
): Promise<{ name: string | null; budget: BudgetOwnership | null }> {
  if (decisionUnit.type === "CAMPAIGN") {
    const c = await createRepository<MetaCampaign>(
      db,
      COLLECTIONS.metaCampaigns,
      metaCampaignSchema,
    ).get(decisionUnit.id);
    return { name: c?.name ?? null, budget: c?.budget ?? null };
  }
  const a = await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).get(
    decisionUnit.id,
  );
  return { name: a?.name ?? null, budget: a?.budget ?? null };
}

/** §4.1 + §14, end to end. See this module's header comment for what it does and does not do. */
export async function resolveScalingEvidence(
  options: ResolveScalingEvidenceOptions,
): Promise<ScalingEvidenceResult> {
  const db = options.db ?? getDb();
  const { namedEntity } = options;

  const canon = await loadReportingCanon({ db, accountId: options.accountId });
  const thresholds = resolveStatisticalThresholds(canon);
  const targetsSource: "settings" | "default" =
    canon.statisticalThresholds !== undefined ? "settings" : "default";

  const chain = await loadEntityChain(db, namedEntity);

  let adPrimaryWindowSampleSize: number | null = null;
  if (namedEntity.type === "AD") {
    const adFeatures = await loadEntityFeatures(db, "AD", namedEntity.id);
    const w = adFeatures?.windows?.[PRIMARY_WINDOW];
    adPrimaryWindowSampleSize = w?.purchases?.sampleSize ?? w?.metaRoas?.sampleSize ?? null;
  }

  let childAdsetBudgets;
  if (namedEntity.type === "CAMPAIGN" && chain.campaign && chain.campaign.budget === null) {
    childAdsetBudgets = await loadChildAdsetBudgets(db, namedEntity.id);
  }

  const resolution = resolveDecisionUnit({
    namedEntity,
    ad: chain.ad,
    adset: chain.adset,
    campaign: chain.campaign,
    childAdsetBudgets,
    adPrimaryWindowSampleSize,
    adPrimaryWindowMinPurchaseFloor: thresholds.minPurchaseFloors[PRIMARY_WINDOW],
  });

  if (resolution.kind === "NO_DECISION_UNIT") {
    return { outcome: "NO_DECISION_UNIT", namedEntity, detail: resolution.detail };
  }

  const { decisionUnit, escalatedFrom } = resolution;
  const [decisionUnitDoc, features] = await Promise.all([
    loadDecisionUnitDoc(db, decisionUnit),
    loadEntityFeatures(db, decisionUnit.type, decisionUnit.id),
  ]);

  const primaryWindow = features?.windows?.[PRIMARY_WINDOW];
  if (!features || !primaryWindow || !isDelivering(primaryWindow)) {
    return {
      outcome: "NOT_DELIVERING",
      namedEntity,
      decisionUnit,
      decisionUnitName: decisionUnitDoc.name,
      escalatedFrom,
      primaryWindow: PRIMARY_WINDOW,
      detail: features
        ? `${decisionUnit.type} ${decisionUnit.id} has zero Meta spend and zero impressions in ` +
          `the primary ${PRIMARY_WINDOW} window — it is not delivering, not merely low-volume. A ` +
          `scaling verdict would be confident-looking nonsense here; the honest answer is that ` +
          `there is nothing currently running to scale.`
        : `${decisionUnit.type} ${decisionUnit.id} has no computed features yet — RECOMPUTE_FEATURES ` +
          `has not reached this entity, which in practice also means it has no observed delivery.`,
    };
  }

  const budgetOwner: BudgetOwnership = decisionUnitDoc.budget ?? {
    ownerLevel: decisionUnit.type === "CAMPAIGN" ? "CAMPAIGN" : "ADSET",
    dailyBudgetMinorUnits: null,
    lifetimeBudgetMinorUnits: null,
    currency: canon.reportingCurrency,
  };

  let creativeFamilyId: string | null = null;
  let creativeFamily = null;
  let creativeFatigueNotApplicableReason: string | null = null;
  if (namedEntity.type === "AD" && chain.ad) {
    const fatigue = await loadCreativeFatigueForAd(db, chain.ad);
    creativeFamilyId = fatigue.familyId;
    creativeFamily = fatigue.family;
    if (!fatigue.familyId) {
      creativeFatigueNotApplicableReason =
        "This ad's creative could not be grouped into a family (no creative attached, or no " +
        "identifiable image/video hash — see B8's identity.ts).";
    }
  } else {
    creativeFatigueNotApplicableReason =
      `Creative fatigue is assessed per ad/creative family; this request named a ` +
      `${namedEntity.type.toLowerCase()} directly, so no single ad's creative applies. Ask about ` +
      `a specific ad to see its family's fatigue signal.`;
  }

  const eligibility = computeEligibilityAndRange({
    isDelivering: true, // guarded above
    metaRoasVerdict: primaryWindow.metaRoas?.verdict ?? null,
    cpaVerdict: primaryWindow.cpa?.verdict ?? null,
    inLearningPhase: features.learningPhase?.inLearningPhase ?? null,
    recentMajorChanges: computeRecentMajorChanges(features.changeAware),
    metaRoasSampleSize:
      primaryWindow.metaRoas?.sampleSize ?? primaryWindow.purchases?.sampleSize ?? 0,
    minPurchaseFloor: thresholds.minPurchaseFloors[PRIMARY_WINDOW],
  });

  const evidence = assembleScalingEvidence({
    decisionUnit,
    decisionUnitName: decisionUnitDoc.name,
    escalatedFrom,
    budgetOwner,
    features,
    targets: {
      targetRoas: thresholds.targetRoas,
      targetCpaMinorUnits: thresholds.targetCpaMinorUnits,
      source: targetsSource,
    },
    minPurchaseFloors: thresholds.minPurchaseFloors,
    eligibility,
    creativeFamilyId,
    creativeFamily,
    creativeFatigueNotApplicableReason,
  });

  return { outcome: "EVIDENCE", evidence };
}
