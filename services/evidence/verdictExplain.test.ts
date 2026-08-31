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
    verdictReasonCode: null,
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

  it("renders the stored BELOW_FLOOR reason code without recomputing it from sampleSize", () => {
    const text = explainVerdict(
      base({ sampleSize: 6, minPurchaseFloor: 30, verdictReasonCode: "BELOW_FLOOR" }),
    );
    expect(text).toMatch(/insufficient volume|below the 30-purchase floor/i);
  });

  it("renders the stored SEASONAL_BOUNDARY reason code, naming the actual label", () => {
    const text = explainVerdict(
      base({
        sampleSize: 40,
        verdictReasonCode: "SEASONAL_BOUNDARY",
        seasonalityLabels: ["diwali"],
      }),
    );
    expect(text).toMatch(/seasonal boundary/i);
    expect(text).toContain("diwali");
  });

  it("renders the stored DATA_GAP reason code, naming the actual gap days", () => {
    const text = explainVerdict(
      base({
        label: "Shopify ROAS",
        sampleSize: 40,
        verdictReasonCode: "DATA_GAP",
        gapDays: ["2026-01-01", "2026-01-02"],
      }),
    );
    expect(text).toMatch(/data gap/i);
    expect(text).toContain("2026-01-01");
  });

  it("falls back to a genuine 'interval straddles target' explanation when the reason code is null", () => {
    const text = explainVerdict(base({ sampleSize: 40, verdictReasonCode: null }));
    expect(text).toMatch(/genuinely inconclusive/i);
  });

  it("trusts the stored reason code even when the raw sample size would suggest a different one — proves it renders rather than recomputes", () => {
    // sampleSize is well below minPurchaseFloor, which the OLD re-derivation logic would have
    // read as BELOW_FLOOR regardless of what actually happened. The stored code says otherwise
    // (DATA_GAP), and that must win — this module has no business overruling C3's own decision.
    const text = explainVerdict(
      base({
        label: "Shopify ROAS",
        sampleSize: 2,
        minPurchaseFloor: 30,
        verdictReasonCode: "DATA_GAP",
        gapDays: ["2026-01-05"],
      }),
    );
    expect(text).toMatch(/data gap/i);
    expect(text).not.toMatch(/purchase floor/i);
  });

  it("honestly reports an unrecorded reason for an older stored document (verdictReasonCode undefined), never guessing one", () => {
    const text = explainVerdict(base({ sampleSize: 6, verdictReasonCode: undefined }));
    expect(text).toMatch(/not recorded/i);
    expect(text).not.toMatch(/purchase floor|seasonal boundary|data gap/i);
  });
});
