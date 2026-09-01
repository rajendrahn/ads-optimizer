// The structural proof for "never show a ROAS without its sample size" (§24's display rule) —
// both halves: a compile-time guarantee (constructing the props without `purchases` is a type
// error) and a runtime guarantee (even smuggled-in bad data never prints a bare number).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoasMetric, type RoasMetricProps } from "./RoasMetric.tsx";
import type { MetricSnapshot } from "../api/types.ts";

function metric(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    value: 3.91,
    interval: [3.1, 4.82],
    purchases: 128,
    verdict: "ABOVE_TARGET",
    verdictReason: "28-day ROAS interval sits entirely above the 3.0 target.",
    ...overrides,
  };
}

describe("RoasMetric — structural: never a ROAS without its sample size", () => {
  it("TYPE LEVEL: `purchases` is a required field on MetricSnapshot — omitting it from the props object is a compile error", () => {
    // This assignment exists purely to be type-checked (never executed for its runtime value).
    // If a future edit ever makes `purchases` optional, `npm run typecheck`/`lint:web` fails here
    // FIRST, before any test even runs — that is the actual enforcement mechanism, this line is
    // just where it becomes visible.
    // @ts-expect-error — `purchases` is deliberately required; this must not typecheck.
    const missingPurchases: RoasMetricProps["metric"] = {
      value: 1,
      interval: [1, 1],
      verdict: null,
      verdictReason: "x",
    };
    expect(missingPurchases).toBeDefined();
  });

  it("renders the value together with its sample size", () => {
    render(<RoasMetric label="ROAS" metric={metric()} source="meta" kind="ratio" />);
    expect(screen.getByText("3.91×")).toBeInTheDocument();
    expect(screen.getByText(/on 128 purchases/)).toBeInTheDocument();
    expect(screen.getByText(/Meta-attributed/)).toBeInTheDocument();
  });

  it("RUNTIME: refuses to print a bare number even if `purchases` is smuggled past the type system as non-numeric", () => {
    const bad = metric({ purchases: undefined as unknown as number });
    render(<RoasMetric label="ROAS" metric={bad} source="shopify" kind="ratio" />);
    expect(screen.queryByText("3.91×")).not.toBeInTheDocument();
    expect(screen.getByText(/sample size unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Shopify-attributed/)).toBeInTheDocument();
  });

  it("renders 'not measured' (never a fabricated number) when value is genuinely null", () => {
    render(
      <RoasMetric
        label="ROAS"
        metric={metric({ value: null, interval: [null, null] })}
        source="shopify"
        kind="ratio"
      />,
    );
    expect(screen.getByText("not measured")).toBeInTheDocument();
  });

  it("formats a money-kind metric as currency, not a bare ratio (value is minor units, per §0.2)", () => {
    render(
      // 176163 paise = ₹1,761.63 — the account's own real measured 7-day CPA (C2's notes).
      <RoasMetric
        label="CPA"
        metric={metric({ value: 176163 })}
        source="meta"
        kind="money"
        currency="INR"
      />,
    );
    expect(screen.getByText(/₹1,761\.63/)).toBeInTheDocument();
  });
});
