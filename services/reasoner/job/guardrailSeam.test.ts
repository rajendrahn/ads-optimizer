import { describe, expect, it } from "vitest";
import { passthroughGuardrailValidator } from "./guardrailSeam.ts";
import type { RecommendationOutput } from "../types.ts";

const SAMPLE_OUTPUT: RecommendationOutput = {
  recommendation: "INCREASE_BUDGET",
  decisionUnit: { type: "ADSET", id: "AS_17" },
  currentBudgetMinorUnits: 100000,
  recommendedBudgetMinorUnits: 250000, // a wildly over-limit change — passthrough doesn't care
  changePercent: 150,
  confidence: 0.9,
  summary: "irrelevant to this test",
  primaryReasons: ["irrelevant"],
  risks: [],
  doNotDo: [],
  recheckConditions: null,
};

describe("passthroughGuardrailValidator", () => {
  it("always accepts — this is the default until D5 lands, not a real guardrail", () => {
    expect(passthroughGuardrailValidator(SAMPLE_OUTPUT)).toEqual({ verdict: "ACCEPTED" });
  });

  it("accepts regardless of how extreme the proposal is (it does not inspect the recommendation at all)", () => {
    const extreme: RecommendationOutput = { ...SAMPLE_OUTPUT, changePercent: 999 };
    expect(passthroughGuardrailValidator(extreme)).toEqual({ verdict: "ACCEPTED" });
  });
});
