import { describe, expect, it } from "vitest";
import { computeVerdict } from "./verdict.ts";

describe("computeVerdict", () => {
  it("ABOVE_TARGET when the whole interval sits strictly above the target", () => {
    expect(computeVerdict(4, 5, 3)).toBe("ABOVE_TARGET");
  });

  it("BELOW_TARGET when the whole interval sits strictly below the target", () => {
    expect(computeVerdict(1, 2, 3)).toBe("BELOW_TARGET");
  });

  it("NOT_DISTINGUISHABLE when the interval straddles the target", () => {
    expect(computeVerdict(2, 4, 3)).toBe("NOT_DISTINGUISHABLE");
  });

  it("NOT_DISTINGUISHABLE at the boundary — touching the target is not 'strictly above/below'", () => {
    expect(computeVerdict(3, 5, 3)).toBe("NOT_DISTINGUISHABLE"); // low === target
    expect(computeVerdict(1, 3, 3)).toBe("NOT_DISTINGUISHABLE"); // high === target
  });

  it("NOT_DISTINGUISHABLE when either bound is null — never guesses", () => {
    expect(computeVerdict(null, 5, 3)).toBe("NOT_DISTINGUISHABLE");
    expect(computeVerdict(1, null, 3)).toBe("NOT_DISTINGUISHABLE");
    expect(computeVerdict(null, null, 3)).toBe("NOT_DISTINGUISHABLE");
  });

  it("is literal, not direction-aware — the same function serves a CPA target unchanged", () => {
    // A CPA of [1400, 1600] against a target of 1500 straddles it -> NOT_DISTINGUISHABLE,
    // regardless of the fact that "lower is better" for CPA specifically.
    expect(computeVerdict(1400, 1600, 1500)).toBe("NOT_DISTINGUISHABLE");
    // A CPA interval entirely below the target is BELOW_TARGET (literally, and also the good
    // outcome for CPA specifically) — same function, no special-casing.
    expect(computeVerdict(1000, 1200, 1500)).toBe("BELOW_TARGET");
  });
});
