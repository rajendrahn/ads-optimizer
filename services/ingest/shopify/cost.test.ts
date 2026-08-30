import { describe, expect, it } from "vitest";
import { decideShopifyThrottle, parseShopifyCost, type ShopifyCost } from "./cost.ts";

/** Test-only helper: asserts non-null via a runtime check rather than the `!` operator, so
 * ESLint's `no-non-null-assertion` (strict config) doesn't have to be overridden per call. */
function parseOrThrow(extensions: unknown): ShopifyCost {
  const parsed = parseShopifyCost(extensions);
  if (!parsed) throw new Error("expected parseShopifyCost to return a cost object");
  return parsed;
}

function extensions(
  overrides: Partial<{
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
    requestedQueryCost: number;
    actualQueryCost: number;
  }> = {},
) {
  return {
    cost: {
      requestedQueryCost: overrides.requestedQueryCost ?? 21,
      actualQueryCost: overrides.actualQueryCost ?? 21,
      throttleStatus: {
        maximumAvailable: overrides.maximumAvailable ?? 1000,
        currentlyAvailable: overrides.currentlyAvailable ?? 979,
        restoreRate: overrides.restoreRate ?? 50,
      },
    },
  };
}

describe("parseShopifyCost", () => {
  it("parses a well-formed extensions.cost block", () => {
    const parsed = parseShopifyCost(extensions());
    expect(parsed).toEqual({
      requestedQueryCost: 21,
      actualQueryCost: 21,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 979, restoreRate: 50 },
    });
  });

  it("returns null for missing/non-object extensions", () => {
    expect(parseShopifyCost(undefined)).toBeNull();
    expect(parseShopifyCost(null)).toBeNull();
    expect(parseShopifyCost("nope")).toBeNull();
  });

  it("returns null when extensions.cost is missing", () => {
    expect(parseShopifyCost({})).toBeNull();
  });

  it("returns null when throttleStatus is missing or incomplete", () => {
    expect(parseShopifyCost({ cost: { requestedQueryCost: 1 } })).toBeNull();
    expect(parseShopifyCost({ cost: { throttleStatus: { maximumAvailable: 1000 } } })).toBeNull();
  });

  it("returns null when restoreRate is zero or negative (nothing sane to compute a wait from)", () => {
    expect(parseShopifyCost(extensions({ restoreRate: 0 }))).toBeNull();
  });

  it("defaults actualQueryCost to null and requestedQueryCost to 0 when absent", () => {
    const parsed = parseShopifyCost({
      cost: {
        throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 50 },
      },
    });
    expect(parsed).toEqual({
      requestedQueryCost: 0,
      actualQueryCost: null,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 50 },
    });
  });
});

describe("decideShopifyThrottle", () => {
  it("does not wait before the first request (no cost data yet)", () => {
    expect(decideShopifyThrottle(null).shouldWait).toBe(false);
  });

  it("does not wait when enough points are available for the estimated next cost", () => {
    const cost = parseOrThrow(extensions({ currentlyAvailable: 900 }));
    const decision = decideShopifyThrottle(cost, { nextRequestEstimatedCost: 50 });
    expect(decision.shouldWait).toBe(false);
    expect(decision.waitMs).toBe(0);
  });

  it("waits when the bucket doesn't have enough points, sized to the restore rate", () => {
    const cost = parseOrThrow(extensions({ currentlyAvailable: 10, restoreRate: 50 }));
    const decision = decideShopifyThrottle(cost, { nextRequestEstimatedCost: 60 });
    // deficit = 60 - 10 = 50 points; at 50/s that's 1000ms
    expect(decision.shouldWait).toBe(true);
    expect(decision.waitMs).toBe(1000);
  });

  it("respects an added safety margin", () => {
    const cost = parseOrThrow(extensions({ currentlyAvailable: 50, restoreRate: 50 }));
    const withoutMargin = decideShopifyThrottle(cost, { nextRequestEstimatedCost: 50 });
    const withMargin = decideShopifyThrottle(cost, {
      nextRequestEstimatedCost: 50,
      safetyMarginPoints: 25,
    });
    expect(withoutMargin.shouldWait).toBe(false);
    expect(withMargin.shouldWait).toBe(true);
    expect(withMargin.waitMs).toBe(500); // deficit 25 at 50/s = 500ms
  });

  it("treats an empty bucket as needing to wait for the full estimated cost", () => {
    const cost = parseOrThrow(extensions({ currentlyAvailable: 0, restoreRate: 100 }));
    const decision = decideShopifyThrottle(cost, { nextRequestEstimatedCost: 200 });
    expect(decision.shouldWait).toBe(true);
    expect(decision.waitMs).toBe(2000);
  });
});
