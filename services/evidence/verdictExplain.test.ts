import { describe, expect, it } from "vitest";
import { explainVerdict, type ExplainVerdictInput } from "./verdictExplain.ts";

function base(overrides: Partial<ExplainVerdictInput> = {}): ExplainVerdictInput {
  return {
    label: "Meta ROAS",
    value: 3.5,
    verdict: "NOT_DISTINGUISHABLE",
    intervalLow: 2.0,
    intervalHigh: 5.0,
    sampleSize: 40,
    minPurchaseFloor: 30,
    target: 3.0,
    spansSeasonalBoundary: false,
    seasonalityLabels: [],
    ...overrides,
  };
}

describe("explainVerdict", () => {
  it("explains an unmeasured value distinctly from a genuine NOT_DISTINGUISHABLE verdict", () => {
    const text = explainVerdict(base({ value: null, verdict: null }));
    expect(text).toMatch(/not measured/i);
  });

  it("explains a confident ABOVE_TARGET verdict with the interval and target", () => {
    const text = explainVerdict(
      base({ verdict: "ABOVE_TARGET", intervalLow: 3.1, intervalHigh: 4.8 }),
    );
    expect(text).toMatch(/confidently above/i);
    expect(text).toContain("3.10");
  });

  it("explains a confident BELOW_TARGET verdict", () => {
    const text = explainVerdict(base({ verdict: "BELOW_TARGET" }));
    expect(text).toMatch(/confidently below/i);
  });

  it("attributes NOT_DISTINGUISHABLE to insufficient volume when below the floor", () => {
    const text = explainVerdict(base({ sampleSize: 6, minPurchaseFloor: 30 }));
    expect(text).toMatch(/insufficient volume|below the 30-purchase floor/i);
  });

  it("attributes NOT_DISTINGUISHABLE to a seasonal boundary when the sample clears the floor", () => {
    const text = explainVerdict(
      base({ sampleSize: 40, spansSeasonalBoundary: true, seasonalityLabels: ["diwali"] }),
    );
    expect(text).toMatch(/seasonal boundary/i);
    expect(text).toContain("diwali");
  });

  it("attributes NOT_DISTINGUISHABLE to a Shopify data gap when neither floor nor season applies", () => {
    const text = explainVerdict(
      base({
        label: "Shopify ROAS",
        sampleSize: 40,
        windowHasDataGap: true,
        gapDays: ["2026-01-01", "2026-01-02"],
      }),
    );
    expect(text).toMatch(/data gap/i);
    expect(text).toContain("2026-01-01");
  });

  it("falls back to a genuine 'interval straddles target' explanation with none of the above", () => {
    const text = explainVerdict(base({ sampleSize: 40 }));
    expect(text).toMatch(/genuinely inconclusive/i);
  });
});
