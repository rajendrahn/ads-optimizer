import { describe, expect, it } from "vitest";
import { RECOMMENDATION_JSON_SCHEMA, RECOMMENDATION_OUTPUT_FORMAT } from "./outputSchema.ts";
import { recommendationOutputSchema } from "./types.ts";

// §20.1's own worked example, field-renamed per this step's own documented deviation (see
// types.ts's module comment): currentBudget/recommendedBudget -> *MinorUnits,
// recheckConditions.minimumAdditionalSpend -> minimumAdditionalSpendMinorUnits.
const WORKED_EXAMPLE = {
  recommendation: "INCREASE_BUDGET",
  decisionUnit: { type: "ADSET", id: "AS_17" },
  currentBudgetMinorUnits: 1_000_000,
  recommendedBudgetMinorUnits: 1_150_000,
  changePercent: 15,
  confidence: 0.72,
  summary:
    "Increase the budget by 15%. Performance over 28 days is above target with adequate volume, and the ad set is out of the learning phase.",
  primaryReasons: [
    "28-day ROAS 3.91 (interval 3.10-4.82) against a 3.0 target, on 128 purchases",
    "shrunk ROAS 3.74 still above target",
    "conversion rate improving",
    "out of learning phase for 19 days",
    "creative fatigue low",
  ],
  risks: [
    "Attribution coverage is 0.68 - Shopify sees roughly two-thirds of Meta-reported purchases",
    "A 15% increase may re-enter the learning phase at current conversion volume",
  ],
  doNotDo: ["Do not increase by 30% or more in one step"],
  recheckConditions: {
    minimumAdditionalSpendMinorUnits: 1_500_000,
    minimumAdditionalPurchases: 15,
  },
};

describe("recommendationOutputSchema (§20.1)", () => {
  it("accepts the design's own worked example, field-renamed per §0.2 minor-units convention", () => {
    expect(() => recommendationOutputSchema.parse(WORKED_EXAMPLE)).not.toThrow();
  });

  it("accepts every allowed recommendation type, including the non-budget ones", () => {
    for (const type of [
      "HOLD",
      "PAUSE",
      "RESTART",
      "LAUNCH_NEW_CREATIVE_TEST",
      "REFRESH_CREATIVE_FAMILY",
      "INVESTIGATE_LANDING_PAGE",
      "INVESTIGATE_PRODUCT_OR_PRICE",
      "INVESTIGATE_TRACKING",
      "CONSOLIDATE_ADSETS",
      "INSUFFICIENT_DATA",
    ]) {
      const value = {
        ...WORKED_EXAMPLE,
        recommendation: type,
        currentBudgetMinorUnits: null,
        recommendedBudgetMinorUnits: null,
        changePercent: null,
        recheckConditions: null,
      };
      expect(recommendationOutputSchema.safeParse(value).success, type).toBe(true);
    }
  });

  it("accepts decisionUnit: null (NO_DECISION_UNIT / NOT_DELIVERING honesty)", () => {
    const value = { ...WORKED_EXAMPLE, decisionUnit: null };
    expect(recommendationOutputSchema.safeParse(value).success).toBe(true);
  });

  it("rejects an unknown recommendation type", () => {
    const value = { ...WORKED_EXAMPLE, recommendation: "SCALE_TO_THE_MOON" };
    expect(recommendationOutputSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a confidence outside [0,1]", () => {
    expect(
      recommendationOutputSchema.safeParse({ ...WORKED_EXAMPLE, confidence: 1.5 }).success,
    ).toBe(false);
  });
});

describe("RECOMMENDATION_JSON_SCHEMA / RECOMMENDATION_OUTPUT_FORMAT (output_config.format)", () => {
  it("is a json_schema-typed output format", () => {
    expect(RECOMMENDATION_OUTPUT_FORMAT.type).toBe("json_schema");
    expect(RECOMMENDATION_OUTPUT_FORMAT.schema).toBe(RECOMMENDATION_JSON_SCHEMA);
  });

  it("every object in the schema sets additionalProperties: false (structured-outputs requirement)", () => {
    function walk(node: unknown): void {
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        expect(obj.additionalProperties).toBe(false);
      }
      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
          value.forEach(walk);
        } else if (typeof value === "object") {
          walk(value);
        }
      }
    }
    walk(RECOMMENDATION_JSON_SCHEMA);
  });

  it("lists every property as required at the top level (no assistant prefill to lean on)", () => {
    const properties = Object.keys(RECOMMENDATION_JSON_SCHEMA.properties);
    expect([...RECOMMENDATION_JSON_SCHEMA.required].sort()).toEqual([...properties].sort());
  });

  it("does not use any unsupported JSON-Schema keyword (minLength/minimum/etc.)", () => {
    // A naive substring search over the serialized schema false-positives on legitimate PROPERTY
    // NAMES that happen to contain these words (e.g. "minimumAdditionalSpendMinorUnits") — the
    // claude-api skill's restricted subset forbids these as JSON-SCHEMA KEYS (sibling of "type"
    // on a schema node), so this walks the actual schema-node structure instead of grepping text.
    const FORBIDDEN_SCHEMA_KEYWORDS = [
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "multipleOf",
    ];
    function walkSchemaNodes(node: unknown): void {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walkSchemaNodes);
        return;
      }
      const obj = node as Record<string, unknown>;
      // Only a node that looks like a schema (carries "type" or "anyOf") is checked for forbidden
      // KEYS on itself — "properties"'s own children are schema nodes; "properties" itself and
      // "required"'s string array are not, and must not be walked as if they were.
      if ("type" in obj || "anyOf" in obj) {
        for (const forbidden of FORBIDDEN_SCHEMA_KEYWORDS) {
          expect(Object.keys(obj)).not.toContain(forbidden);
        }
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key === "required") continue; // a string array of property NAMES, not schema nodes
        walkSchemaNodes(value);
      }
    }
    walkSchemaNodes(RECOMMENDATION_JSON_SCHEMA);
  });
});
