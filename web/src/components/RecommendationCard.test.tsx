// Proves every D6 "Done when" render case: PENDING/GENERATING show progress (no reload needed —
// this is the same component the live stream re-renders in place), FAILED shows the real error,
// all three D1 outcomes render as first-class cards (not errors/empty states), a guardrail
// REJECTED card states which guardrail and why, and an escalated answer states what it escalated
// from and why.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecommendationCard } from "./RecommendationCard.tsx";
import type { RecommendationView } from "../api/types.ts";

const BASE: RecommendationView = {
  recommendationId: "rec_1",
  status: "PENDING",
  requestedBy: "a@example.com",
  requestedQuestion: "Should I increase the budget?",
  namedEntity: { type: "ADSET", id: "AS_17" },
  createdAt: "2026-08-30T00:00:00Z",
  updatedAt: "2026-08-30T00:00:00Z",
  errorMessage: null,
  action: null,
  decisionUnit: null,
  currentBudgetMinorUnits: null,
  recommendedBudgetMinorUnits: null,
  currency: "INR",
  changePercent: null,
  confidence: null,
  summary: null,
  primaryReasons: null,
  risks: null,
  doNotDo: null,
  recheckConditions: null,
  guardrailRejection: null,
  provenance: null,
  acceptedAt: null,
  rejectedByUserAt: null,
  reportingTimezone: "Asia/Kolkata",
  packet: null,
};

const noop = vi.fn();

describe("RecommendationCard — every status/outcome renders as a first-class card", () => {
  it("PENDING shows progress, not an error or empty state", () => {
    render(<RecommendationCard view={{ ...BASE, status: "PENDING" }} onDecided={noop} />);
    expect(screen.getByText(/Queued/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("GENERATING shows progress", () => {
    render(<RecommendationCard view={{ ...BASE, status: "GENERATING" }} onDecided={noop} />);
    expect(screen.getByText(/Reasoning/)).toBeInTheDocument();
  });

  it("FAILED renders the real errorMessage, not a spinner", () => {
    render(
      <RecommendationCard
        view={{ ...BASE, status: "FAILED", errorMessage: "ECONNRESET: connection reset by peer" }}
        onDecided={noop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("ECONNRESET: connection reset by peer");
  });

  it("NOT_DELIVERING renders as a first-class card, not an error", () => {
    render(
      <RecommendationCard
        view={{
          ...BASE,
          status: "COMPLETE",
          action: "INSUFFICIENT_DATA",
          packet: {
            outcome: "NOT_DELIVERING",
            namedEntity: BASE.namedEntity,
            decisionUnit: BASE.namedEntity,
            escalatedFrom: null,
            accountDataVersion: 1,
            isStale: false,
            createdAt: "2026-08-30T00:00:00Z",
            textRendering: "not delivering text",
            evidence: {
              namedEntity: { type: "ADSET", id: "AS_dead" },
              decisionUnit: { type: "ADSET", id: "AS_dead" },
              decisionUnitName: "Demo dead adset",
              escalatedFrom: null,
              primaryWindow: "28d",
              detail: "Zero spend and zero impressions in the primary window.",
            },
          },
        }}
        onDecided={noop}
      />,
    );
    expect(screen.getByText(/Not delivering/)).toBeInTheDocument();
    expect(screen.getByText(/Zero spend and zero impressions/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("NO_DECISION_UNIT renders as a first-class card, not an error", () => {
    render(
      <RecommendationCard
        view={{
          ...BASE,
          status: "COMPLETE",
          action: "INSUFFICIENT_DATA",
          packet: {
            outcome: "NO_DECISION_UNIT",
            namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
            decisionUnit: null,
            escalatedFrom: null,
            accountDataVersion: 1,
            isStale: false,
            createdAt: "2026-08-30T00:00:00Z",
            textRendering: "no decision unit text",
            evidence: {
              namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
              detail: "Budget ownership is genuinely UNKNOWN for this campaign.",
            },
          },
        }}
        onDecided={noop}
      />,
    );
    expect(screen.getByText(/No identifiable decision unit/)).toBeInTheDocument();
    expect(screen.getByText(/genuinely UNKNOWN/)).toBeInTheDocument();
  });

  it("an escalated answer states what it escalated from and why", () => {
    render(
      <RecommendationCard
        view={{
          ...BASE,
          status: "COMPLETE",
          action: "HOLD",
          decisionUnit: { type: "ADSET", id: "AS_17" },
          packet: {
            outcome: "EVIDENCE",
            namedEntity: { type: "AD", id: "ad_lowvol" },
            decisionUnit: { type: "ADSET", id: "AS_17" },
            escalatedFrom: { type: "AD", id: "ad_lowvol", reason: "SAMPLE_TOO_SMALL" },
            accountDataVersion: 1,
            isStale: false,
            createdAt: "2026-08-30T00:00:00Z",
            textRendering: "escalation prose",
            evidence: {
              decisionUnit: { type: "ADSET", id: "AS_17" },
              decisionUnitName: "AS-17",
              escalatedFrom: { type: "AD", id: "ad_lowvol", reason: "SAMPLE_TOO_SMALL" },
              budgetOwner: {
                ownerLevel: "ADSET",
                dailyBudgetMinorUnits: 50000,
                lifetimeBudgetMinorUnits: null,
                currency: "INR",
              },
              eligibleToScale: false,
              ineligibleReasons: [],
              suggestedChangePercent: null,
              safeRangePercent: null,
              confidence: 0.5,
              accountDataVersion: 1,
              primaryWindow: "28d",
              targets: { targetRoas: 3, targetCpaMinorUnits: 150000, source: "default" },
              evidence: {
                windows: {},
                roas28d: null,
                roas28dShrunk: null,
                cpa28d: null,
                verdict: null,
                targetRoas: 3,
                shopify: {
                  attributionCoverageRatio: 0.0002,
                  attributionCoverageRatioIncludingNameMatch: 0.005,
                  blendedMerAccountOnly: 2.1,
                  note: "Shopify attribution coverage is near zero for this account.",
                },
                funnel: {
                  ctr: null,
                  ctrTrend: null,
                  cvr: null,
                  cvrTrend: null,
                  addToCartRate: null,
                  checkoutStartedRate: null,
                  purchaseRate: null,
                },
                deliveryStability: {
                  isDelivering: true,
                  spendMinorUnits: 100000,
                  impressions: 5000,
                  frequency: 1.2,
                },
                learningState: {
                  inLearningPhase: null,
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
                  note: "",
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
                  summaryText: "",
                },
              },
            },
          },
        }}
        onDecided={noop}
      />,
    );
    expect(screen.getByText(/Escalated\./)).toBeInTheDocument();
    expect(screen.getByText(/ad_lowvol/)).toBeInTheDocument();
    expect(screen.getByText(/statistical floor/)).toBeInTheDocument();
  });

  it("REJECTED renders which guardrail rejected it and what limit it was judged against", () => {
    render(
      <RecommendationCard
        view={{
          ...BASE,
          status: "REJECTED",
          action: "INSUFFICIENT_DATA",
          currentBudgetMinorUnits: null,
          guardrailRejection: {
            reason: "changePercent 250 exceeds the configured maximum of 20%",
            violations: [
              {
                code: "MAX_CHANGE_PERCENT_EXCEEDED",
                message: "changePercent 250 exceeds the configured maximum of 20%",
                judgedAgainst: {
                  field: "guardrailThresholds.maxChangePercent",
                  limit: 20,
                  source: "default",
                  actual: 250,
                },
              },
            ],
            decisionUnitClaimedByModel: { type: "ADSET", id: "AS_overlimit" },
            decisionUnitResolved: { type: "ADSET", id: "AS_overlimit" },
            rejectedAt: "2026-08-30T00:00:00Z",
          },
        }}
        onDecided={noop}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Rejected by a guardrail/);
    expect(screen.getByText(/Change too large/)).toBeInTheDocument();
    expect(screen.getByText(/maxChangePercent = 20/)).toBeInTheDocument();
    expect(screen.getByText(/actual was 250/)).toBeInTheDocument();
    // A rejected card has nothing actionable to accept/reject.
    expect(screen.queryByRole("button", { name: /^Accept$/ })).not.toBeInTheDocument();
  });
});
