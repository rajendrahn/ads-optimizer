import { describe, expect, it } from "vitest";
import type { WindowMetrics } from "@shared/schema/index.ts";
import { isDelivering } from "./deliveryCheck.ts";

function window(overrides: Partial<WindowMetrics> = {}): WindowMetrics {
  return { spendMinorUnits: 0, impressions: 0, ...overrides };
}

describe("isDelivering", () => {
  it("is false when there is no window doc at all", () => {
    expect(isDelivering(undefined)).toBe(false);
  });

  it("is false when spend and impressions are both zero", () => {
    expect(isDelivering(window())).toBe(false);
  });

  it("is true when spend is positive", () => {
    expect(isDelivering(window({ spendMinorUnits: 100 }))).toBe(true);
  });

  it("is true when impressions are positive even with zero recorded spend", () => {
    expect(isDelivering(window({ impressions: 50 }))).toBe(true);
  });
});
