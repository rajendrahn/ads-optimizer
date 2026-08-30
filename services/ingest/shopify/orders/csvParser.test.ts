import { describe, expect, it } from "vitest";
import { isJunkMatrixifyRow, parseMatrixifyCsv } from "./csvParser.ts";

const HEADER =
  "ID,Name,Created At,Updated At,Customer: ID,Line: Type,Line: Product ID,Line: Title,Line: Quantity,Line: Price,Line: Total,Refund: ID,Refund: Created At";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

describe("parseMatrixifyCsv", () => {
  it("groups multiple rows by order ID, preserving row order", () => {
    const text = csv(
      "100,#1,2025-01-01 00:00:00 +0000,2025-01-01 00:00:00 +0000,c1,Line Item,p1,First Item,1,10.00,10.00,,",
      "100,#1,2025-01-01 00:00:00 +0000,2025-01-01 00:00:00 +0000,c1,Shipping Line,,Standard,,0.00,0.00,,",
      "101,#2,2025-01-02 00:00:00 +0000,2025-01-02 00:00:00 +0000,c2,Line Item,p2,Second Item,1,20.00,20.00,,",
    );
    const result = parseMatrixifyCsv(text);
    expect(result.skippedJunkRowCount).toBe(0);
    expect(result.orders).toHaveLength(2);
    const order100 = result.orders.find((o) => o.orderId === "100");
    expect(order100?.rows).toHaveLength(2);
    expect(order100?.rows[0]["Line: Type"]).toBe("Line Item");
    expect(order100?.rows[1]["Line: Type"]).toBe("Shipping Line");
    const order101 = result.orders.find((o) => o.orderId === "101");
    expect(order101?.rows).toHaveLength(1);
  });

  it("filters out a fully blank row (ID column blank)", () => {
    const text = csv(
      "100,#1,2025-01-01 00:00:00 +0000,2025-01-01 00:00:00 +0000,c1,Line Item,p1,Item,1,10.00,10.00,,",
      ",,,,,,,,,,,,",
    );
    const result = parseMatrixifyCsv(text);
    expect(result.skippedJunkRowCount).toBe(1);
    expect(result.orders).toHaveLength(1);
  });

  it("filters out the export-tool plan-limit trailer row", () => {
    const trailerId =
      "###### YOUR PLAN ALLOWS FILE SIZE TILL HERE ###### UPGRADE IF YOU NEED LARGER FILES";
    const text = csv(
      "100,#1,2025-01-01 00:00:00 +0000,2025-01-01 00:00:00 +0000,c1,Line Item,p1,Item,1,10.00,10.00,,",
      `"${trailerId}",,,,,,,,,,,,`,
    );
    const result = parseMatrixifyCsv(text);
    expect(result.skippedJunkRowCount).toBe(1);
    expect(result.orders).toHaveLength(1);
  });

  it("returns no orders and counts every row as junk for an all-junk file", () => {
    const text = csv(",,,,,,,,,,,,", ",,,,,,,,,,,,");
    const result = parseMatrixifyCsv(text);
    expect(result.orders).toHaveLength(0);
    expect(result.skippedJunkRowCount).toBe(2);
  });
});

describe("isJunkMatrixifyRow", () => {
  it("treats a real order ID as not junk", () => {
    expect(isJunkMatrixifyRow({ ID: "6489142231355" })).toBe(false);
  });
  it("treats a blank ID as junk", () => {
    expect(isJunkMatrixifyRow({ ID: "" })).toBe(true);
    expect(isJunkMatrixifyRow({ ID: "   " })).toBe(true);
  });
  it("treats the plan-limit trailer as junk", () => {
    expect(isJunkMatrixifyRow({ ID: "###### YOUR PLAN ALLOWS..." })).toBe(true);
  });
});
