// D5's own "Done when" bar, proven end to end against a real Firestore emulator:
//   1. A synthetic over-limit recommendation is rejected AND logged (guardrailRejections/{id}).
//   2. A recommendation naming a non-budget-owner is rejected AND logged.
// Plus: an approved recommendation writes no log entry, and the exact rejection-log document
// shape E3 would calibrate against (this is the "real logged example" the report cites).

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { guardrailRejectionLogSchema, type GuardrailRejectionLog } from "@shared/schema/index.ts";
import { TEST_CANON } from "../ingest/meta/entities/testFixtures.ts";
import type { ScalableEntityRef, ScalingEvidenceResult } from "../evidence/index.ts";
import type { RecommendationOutput } from "./types.ts";
import { applyGuardrails } from "./guardrailLog.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "guardrailLog.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanup() {
  const snaps = await db.collection(COLLECTIONS.guardrailRejections).listDocuments();
  await Promise.all(snaps.map((ref) => ref.delete()));
}
beforeEach(cleanup);
afterAll(cleanup);

const DECISION_UNIT: ScalableEntityRef = { type: "ADSET", id: "as_17" };

const HEALTHY_EVIDENCE: ScalingEvidenceResult = {
  outcome: "EVIDENCE",
  evidence: {
    decisionUnit: DECISION_UNIT,
    decisionUnitName: "AS 17",
    budgetOwner: {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 4_755_500,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    eligibleToScale: true,
    ineligibleReasons: [],
    suggestedChangePercent: 12,
    safeRangePercent: [5, 15],
    confidence: 0.8,
    accountDataVersion: 42,
    primaryWindow: "28d",
    targets: { targetRoas: 3.0, targetCpaMinorUnits: 150_000, source: "default" },
    evidence: {
      windows: {
        "28d": {
          window: "28d",
          spendMinorUnits: 47_555_000,
          metaRoas: {
            value: 3.91,
            interval: [3.1, 4.82],
            purchases: 270,
            verdict: "ABOVE_TARGET",
            verdictReason: "confidently above target on 270 purchases",
          },
          metaRoasShrunk: 3.74,
          cpaMinorUnits: {
            value: 176_163,
            interval: [160_000, 195_000],
            purchases: 270,
            verdict: "ABOVE_TARGET",
            verdictReason: "above the ₹1,500.00 placeholder target",
          },
          shopifyRoas: {
            value: null,
            interval: [null, null],
            purchases: 0,
            verdict: null,
            verdictReason: "not measured",
          },
          shopifyRoasShrunk: null,
          shopifyDataGap: { windowHasDataGap: false, gapDays: [] },
          attributionCoverageRatio: 0.0002,
          ctr: 0.02,
          cvr: 0.01,
          frequency: 1.5,
          seasonality: {
            labels: [],
            spansSeasonalBoundary: false,
            demandIndex: null,
            demandIndexSampleSize: 0,
            summaryText: "insufficient history for a demand index",
          },
        },
      },
      roas28d: {
        value: 3.91,
        interval: [3.1, 4.82],
        purchases: 270,
        verdict: "ABOVE_TARGET",
        verdictReason: "confidently above target on 270 purchases",
      },
      roas28dShrunk: 3.74,
      cpa28d: {
        value: 176_163,
        interval: [160_000, 195_000],
        purchases: 270,
        verdict: "ABOVE_TARGET",
        verdictReason: "above the ₹1,500.00 placeholder target",
      },
      verdict: "ABOVE_TARGET",
      targetRoas: 3.0,
      shopify: {
        attributionCoverageRatio: 0.0002,
        attributionCoverageRatioIncludingNameMatch: 0.001,
        blendedMerAccountOnly: null,
        note: "Shopify-attributed per-ad-set ROAS is not reliable at this account's near-zero coverage.",
      },
      funnel: {
        ctr: 0.02,
        ctrTrend: null,
        cvr: 0.01,
        cvrTrend: null,
        addToCartRate: null,
        checkoutStartedRate: null,
        purchaseRate: null,
      },
      deliveryStability: {
        isDelivering: true,
        spendMinorUnits: 47_555_000,
        impressions: 200_000,
        frequency: 1.5,
      },
      learningState: {
        inLearningPhase: false,
        conversionsToExitLearning: null,
        learningResetAt: null,
        learningResetCause: null,
      },
      creativeFatigue: {
        applicable: false,
        familyId: null,
        creativeType: null,
        eligibleForFamilyFatigueScore: null,
        fatigueScore: null,
        variationCount: null,
        note: "ask about a specific ad to see its family's signal",
      },
      recentChanges: {
        recentMajorChanges: false,
        hoursSinceLastBudgetChange: null,
        lastBudgetChangePercent: null,
        budgetChangesLast7Days: 0,
        hoursSinceLastAudienceChange: null,
        targetingChangesLast14Days: 0,
        hoursSinceLastCreativeChange: null,
        creativeChangesLast7Days: 0,
        hoursSinceLastStatusChange: null,
      },
      seasonality: {
        labels: [],
        spansSeasonalBoundary: false,
        demandIndex: null,
        demandIndexSampleSize: 0,
        summaryText: "insufficient history for a demand index",
      },
    },
  },
};

function recommendation(overrides: Partial<RecommendationOutput> = {}): RecommendationOutput {
  return {
    recommendation: "INCREASE_BUDGET",
    decisionUnit: DECISION_UNIT,
    currentBudgetMinorUnits: 4_755_500,
    recommendedBudgetMinorUnits: 5_326_160,
    changePercent: 12,
    confidence: 0.8,
    summary: "Increase the budget by 12%.",
    primaryReasons: ["ROAS above target on 270 purchases"],
    risks: [],
    doNotDo: [],
    recheckConditions: null,
    ...overrides,
  };
}

describe("applyGuardrails — over-limit recommendation, D5's own Done-when bar #1", () => {
  it("rejects and durably logs a synthetic over-limit recommendation, with the exact judged-against limit", async () => {
    const result = await applyGuardrails({
      db,
      recommendationId: "rec_over_limit_test",
      namedEntity: DECISION_UNIT,
      recommendation: recommendation({ changePercent: 40 }), // double the 20% default max
      evidenceResult: HEALTHY_EVIDENCE,
      canon: TEST_CANON,
      accountDataVersion: 42,
      adOptimizationKnowledgeVersion: "v1",
      now: new Date("2026-08-30T12:00:00Z"),
    });

    expect(result.outcome).toBe("REJECTED");
    if (result.outcome !== "REJECTED") throw new Error("unreachable");
    expect(result.violations.some((v) => v.code === "MAX_CHANGE_PERCENT_EXCEEDED")).toBe(true);
    expect(result.recommendationPatch.recommendation).toBe("INSUFFICIENT_DATA");
    expect(result.recommendationPatch.changePercent).toBeNull();
    expect(result.recommendationPatch.recommendedBudgetMinorUnits).toBeNull();
    expect(result.recommendationPatch.guardrailRejection.reason).toBe(result.reason);

    // The log entry — this IS the calibration signal §20.2 describes. Read back from a REAL
    // Firestore emulator, not the in-memory return value, so the schema round-trip itself is
    // proven (zod validates on both write and read via createRepository/collectionRef).
    const repo = createRepository<GuardrailRejectionLog>(
      db,
      COLLECTIONS.guardrailRejections,
      guardrailRejectionLogSchema,
    );
    const logged = await repo.get("rec_over_limit_test");
    expect(logged).not.toBeNull();
    expect(logged?.recommendationId).toBe("rec_over_limit_test");
    expect(logged?.decisionUnitClaimedByModel).toEqual(DECISION_UNIT);
    expect(logged?.decisionUnitResolved).toEqual(DECISION_UNIT);
    expect(logged?.recommendationType).toBe("INCREASE_BUDGET");
    expect(logged?.changePercent).toBe(40);
    expect(logged?.accountDataVersion).toBe(42);
    expect(logged?.adOptimizationKnowledgeVersion).toBe("v1");
    const violation = logged?.violations.find((v) => v.code === "MAX_CHANGE_PERCENT_EXCEEDED");
    expect(violation?.judgedAgainst).toEqual({
      field: "guardrailThresholds.maxChangePercent",
      limit: 20,
      source: "default",
      actual: 40,
    });
    expect(logged?.rejectedAt).toBeInstanceOf(Date);
  });
});

describe("applyGuardrails — non-budget-owner recommendation, D5's own Done-when bar #2", () => {
  it("rejects and logs a recommendation naming an entity that is not the resolved budget owner", async () => {
    const result = await applyGuardrails({
      db,
      recommendationId: "rec_wrong_owner_test",
      namedEntity: DECISION_UNIT,
      recommendation: recommendation({
        decisionUnit: { type: "ADSET", id: "as_definitely_not_owner" },
      }),
      evidenceResult: HEALTHY_EVIDENCE,
      canon: TEST_CANON,
      accountDataVersion: 42,
      adOptimizationKnowledgeVersion: null,
    });

    expect(result.outcome).toBe("REJECTED");
    if (result.outcome !== "REJECTED") throw new Error("unreachable");
    expect(result.violations.some((v) => v.code === "DECISION_UNIT_NOT_BUDGET_OWNER")).toBe(true);

    const repo = createRepository<GuardrailRejectionLog>(
      db,
      COLLECTIONS.guardrailRejections,
      guardrailRejectionLogSchema,
    );
    const logged = await repo.get("rec_wrong_owner_test");
    expect(logged?.decisionUnitClaimedByModel).toEqual({
      type: "ADSET",
      id: "as_definitely_not_owner",
    });
    expect(logged?.decisionUnitResolved).toEqual(DECISION_UNIT);
    expect(logged?.adOptimizationKnowledgeVersion).toBeNull(); // honest absence, not a silent omission
  });
});

describe("applyGuardrails — approval writes no log entry", () => {
  it("does not write to guardrailRejections when the recommendation clears every guardrail", async () => {
    const result = await applyGuardrails({
      db,
      recommendationId: "rec_clean_test",
      namedEntity: DECISION_UNIT,
      recommendation: recommendation(),
      evidenceResult: HEALTHY_EVIDENCE,
      canon: TEST_CANON,
      accountDataVersion: 42,
      adOptimizationKnowledgeVersion: "v1",
    });
    expect(result.outcome).toBe("APPROVED");

    const repo = createRepository<GuardrailRejectionLog>(
      db,
      COLLECTIONS.guardrailRejections,
      guardrailRejectionLogSchema,
    );
    expect(await repo.get("rec_clean_test")).toBeNull();
  });
});
