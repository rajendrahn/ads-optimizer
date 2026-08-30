// The Matrixify CSV row-grouping parser — IMPLEMENTATION_PLAN.md B5: "Matrixify's export is
// row-based, not nested JSON: each order's line items, refund lines and transactions are
// additional rows in the same sheet, discriminated by a `Line: Type` column — group by order
// Name/ID before writing."
//
// Verified live against the real production export (37,172 rows, 10,000 real orders after
// filtering — see `isJunkMatrixifyRow`): order-level columns (Created At, Customer: ID,
// Browser: Landing Page, the Price: * summary fields, ...) are populated inconsistently across
// an order's rows — some fields (Price: Subtotal/Total/...) appear ONLY on the order's first
// row (always its first "Line Item" row in every one of the 10,000 real orders sampled), others
// (Browser: Landing Page, Customer: ID) are repeated identically on every row when present.
// Nothing in the export makes this an intentional distinction to key off of — csvNormalize.ts
// handles both uniformly by taking the first non-blank value found across a group's rows,
// which is correct for both patterns without needing to special-case which field follows
// which.
//
// This module only groups rows; it does no money/date parsing or Firestore-shape building —
// that's csvNormalize.ts, kept separate so the grouping logic (and its "what counts as junk"
// decision) is independently testable from the normalization decisions.

import { parse } from "csv-parse/sync";

export type MatrixifyRow = Record<string, string>;

export interface MatrixifyOrderGroup {
  /** Shopify's own order ID (the CSV's "ID" column) — this is what becomes the Firestore doc
   * id, so it must be exactly Shopify's numeric order id, not the "#1234"-style order number
   * (that's a separate CSV column, "Name"). */
  orderId: string;
  /** Every real (non-junk) row for this order, in file order. */
  rows: MatrixifyRow[];
}

export interface ParseMatrixifyCsvResult {
  orders: MatrixifyOrderGroup[];
  /** Rows filtered out because they aren't real order data — see `isJunkMatrixifyRow`. Surface
   * this count to whoever runs the import; a nonzero value on a *file this parser has already
   * seen* is expected (2, on the real production export — see IMPLEMENTATION_PLAN.md B5 notes),
   * but a sudden jump on a *new* export is worth a human looking at the file directly. */
  skippedJunkRowCount: number;
}

/**
 * A row that is not real Shopify order data. Two shapes have been observed live in this
 * account's actual export, both with every other column blank:
 *   1. A fully blank row (the "ID" column parses to a single space or empty string) — an
 *      artifact of the exporting tool, not a Shopify record.
 *   2. A literal trailer row the exporting tool appends when a plan's row/size cap truncates
 *      the file: `"###### YOUR PLAN ALLOWS FILE SIZE TILL HERE ###### UPGRADE IF YOU NEED
 *      LARGER FILES"` in the ID column. This is the direct, load-bearing evidence that the
 *      ~10k-of-~22.6k row count B5 was told to expect is a real, tool-enforced truncation, not
 *      an arbitrary one-time export choice — see IMPLEMENTATION_PLAN.md B5 notes.
 * Checking the "ID" column alone is sufficient for both (every other column is blank on both
 * shapes) and doesn't risk mis-flagging a real row with some other empty field.
 */
export function isJunkMatrixifyRow(row: MatrixifyRow): boolean {
  const id = (row["ID"] ?? "").trim();
  return id === "" || id.startsWith("######");
}

export function parseMatrixifyCsv(csvText: string): ParseMatrixifyCsvResult {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  }) as MatrixifyRow[];

  const groups = new Map<string, MatrixifyRow[]>();
  let skippedJunkRowCount = 0;

  for (const row of rows) {
    if (isJunkMatrixifyRow(row)) {
      skippedJunkRowCount++;
      continue;
    }
    const orderId = row["ID"].trim();
    let group = groups.get(orderId);
    if (!group) {
      group = [];
      groups.set(orderId, group);
    }
    group.push(row);
  }

  return {
    orders: [...groups.entries()].map(([orderId, orderRows]) => ({ orderId, rows: orderRows })),
    skippedJunkRowCount,
  };
}
