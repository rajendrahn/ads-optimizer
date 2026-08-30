import { describe, expect, it } from "vitest";
import { computeNewVsRepeat, type CustomerOrderRef } from "./newVsRepeat.ts";

function ref(orderId: string, customerId: string, createdAt: string): CustomerOrderRef {
  return { orderId, customerId, createdAt: new Date(createdAt) };
}

describe("computeNewVsRepeat", () => {
  it("marks a single order per customer as new", () => {
    const result = computeNewVsRepeat([
      ref("o1", "c1", "2025-01-01T00:00:00Z"),
      ref("o2", "c2", "2025-01-02T00:00:00Z"),
    ]);
    expect(result.get("o1")).toBe(true);
    expect(result.get("o2")).toBe(true);
  });

  it("marks the chronologically first order new and later ones repeat, regardless of input order", () => {
    // Deliberately out of chronological order in the input array.
    const result = computeNewVsRepeat([
      ref("o3", "c1", "2025-03-01T00:00:00Z"),
      ref("o1", "c1", "2025-01-01T00:00:00Z"),
      ref("o2", "c1", "2025-02-01T00:00:00Z"),
    ]);
    expect(result.get("o1")).toBe(true);
    expect(result.get("o2")).toBe(false);
    expect(result.get("o3")).toBe(false);
  });

  it("handles multiple independent customers correctly", () => {
    const result = computeNewVsRepeat([
      ref("a1", "cust-a", "2025-01-01T00:00:00Z"),
      ref("a2", "cust-a", "2025-06-01T00:00:00Z"),
      ref("b1", "cust-b", "2025-02-01T00:00:00Z"),
    ]);
    expect(result.get("a1")).toBe(true);
    expect(result.get("a2")).toBe(false);
    expect(result.get("b1")).toBe(true);
  });

  it("breaks ties on identical createdAt deterministically by orderId", () => {
    const result = computeNewVsRepeat([
      ref("z", "c1", "2025-01-01T00:00:00Z"),
      ref("a", "c1", "2025-01-01T00:00:00Z"),
    ]);
    // "a" < "z" lexicographically, so "a" wins the tie-break as the "first" order.
    expect(result.get("a")).toBe(true);
    expect(result.get("z")).toBe(false);
  });

  it("is a no-op for an empty input", () => {
    expect(computeNewVsRepeat([]).size).toBe(0);
  });

  it("simulates a later, earlier-dated export arriving after an initial partial import", () => {
    // Round 1: only the customer's later order is known (e.g. this partial export's window
    // happened to include a repeat purchase but not the original).
    const round1 = computeNewVsRepeat([ref("later", "c1", "2025-06-01T00:00:00Z")]);
    expect(round1.get("later")).toBe(true); // correctly "new" given what's known so far

    // Round 2: a further export fills in the customer's true first order. Recomputing over
    // the FULL accumulated set (not just the new rows) flips the earlier verdict.
    const round2 = computeNewVsRepeat([
      ref("later", "c1", "2025-06-01T00:00:00Z"),
      ref("earlier", "c1", "2025-01-01T00:00:00Z"),
    ]);
    expect(round2.get("earlier")).toBe(true);
    expect(round2.get("later")).toBe(false);
  });
});
