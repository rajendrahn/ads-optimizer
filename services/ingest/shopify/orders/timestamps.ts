// Matrixify export timestamps look like "2025-01-15 14:27:06 +0530": a space-separated local
// wall-clock time plus an explicit, always-present numeric UTC offset. IMPLEMENTATION_PLAN.md
// B5 is explicit: "parse the offset properly, do not assume IST" — every row in this account's
// real export happens to carry +0530, but nothing about the format guarantees that, and V8's
// non-ISO string parsing is implementation-defined (Node happens to get this one right; that's
// not a contract). This module parses the format directly via regex + explicit arithmetic, the
// same reasoning shared/canon/money.ts already applies to decimal-string parsing.

const MATRIXIFY_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** Throws on anything not matching "YYYY-MM-DD HH:mm:ss ±HHMM" exactly. */
export function parseMatrixifyTimestamp(raw: string): Date {
  const trimmed = raw.trim();
  const match = MATRIXIFY_TIMESTAMP_RE.exec(trimmed);
  if (!match) {
    throw new Error(`parseMatrixifyTimestamp: "${raw}" does not match "YYYY-MM-DD HH:mm:ss +HHMM"`);
  }
  const [, y, mo, d, h, mi, s, sign, oh, om] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    "+" | "-",
    string,
    string,
  ];
  const wallAsUtcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  const offsetMs = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === "-" ? -1 : 1);
  // The wall-clock reading is `offsetMs` ahead of UTC (positive offset = east of UTC), so the
  // real UTC instant is the wall-clock reading minus the offset.
  return new Date(wallAsUtcMs - offsetMs);
}

/** Same as `parseMatrixifyTimestamp`, but a blank/absent value (most Matrixify timestamp
 * columns — Cancelled At, Refund: Created At — are legitimately empty) returns `null` instead
 * of throwing. */
export function parseOptionalMatrixifyTimestamp(raw: string | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  return parseMatrixifyTimestamp(raw);
}
