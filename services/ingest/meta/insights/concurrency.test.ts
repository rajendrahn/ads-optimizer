import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency.ts";

describe("mapWithConcurrency", () => {
  it("maps every item and preserves result order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0, 5];
    const result = await mapWithConcurrency(delays, 3, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `concurrency` callbacks at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return i * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("handles an empty array", async () => {
    const result = await mapWithConcurrency([], 5, async (x: number) => x);
    expect(result).toEqual([]);
  });

  it("handles concurrency greater than the item count", async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (x) => x + 1);
    expect(result).toEqual([2, 3]);
  });

  it("propagates a rejection from any callback", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });

  it("throws on concurrency < 1", async () => {
    await expect(mapWithConcurrency([1], 0, async (x) => x)).rejects.toThrow(/concurrency must be/);
  });
});
