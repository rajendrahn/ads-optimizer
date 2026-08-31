// The structural half of C2's gap-safety requirement (IMPLEMENTATION_PLAN.md C2's brief —
// "the windowing/aggregation primitive itself must return the coverage verdict alongside the
// figure, so a caller cannot obtain a Shopify-derived window total without also receiving
// `windowHasDataGap`... a caller that wants to ignore it must do so explicitly and visibly").
//
// `GapAware<T>` is that wrapper. It is a plain type, not clever — the discipline comes from
// where it's used, not from anything in this file:
//
//   1. `shopifyWindowAggregate.ts`'s `aggregateShopifyWindow` is the ONLY function anywhere in
//      this codebase that sums `shopifyOrdersNormalized`/`shopifyRefundsNormalized` rows into a
//      window total, and its return type IS `GapAware<ShopifyWindowTotals>` — there is no
//      sibling "just give me the number" export next to it for a future author to reach for
//      instead. Grep for `ShopifyWindowTotals` and this is the only place one is constructed.
//   2. `windowMetricsBuilder.ts`'s `buildWindowMetrics` — the function that assembles the
//      `WindowMetrics` object actually written to Firestore — takes that `GapAware<...>` as an
//      input parameter, not a plain `ShopifyWindowTotals`. A caller who tried to hand-sum orders
//      themselves and pass the result in would fail to type-check: the shape without
//      `.windowHasDataGap`/`.gapDays` does not satisfy the parameter type. The compiler is the
//      enforcement, not a comment asking nicely.
//   3. The one legitimate way to look past a gap — C3/D1 showing a number anyway with the gap
//      called out in the surrounding text, say — goes through `unsafeIgnoreGap` below, which
//      forces a `justification` string at every call site. Grepping the codebase for
//      `unsafeIgnoreGap` finds every place gap-awareness was ever deliberately set aside; there
//      is no quieter way to do it.

/** A value that was computed over a specific reporting-day window, bundled with whether that
 * window's Shopify-side data is structurally incomplete (B5's Dec-2025 -> ~Jul-2026 hole, and
 * whatever future gap `shopifyDailyCoverage` records) — never with whether it happens to be
 * zero, which is a real, different, measured outcome. */
export interface GapAware<T> {
  value: T;
  /** True when ANY reporting day inside the window this value covers has
   * `shopifyDailyCoverage.hasCoverageGap === true`, OR has no coverage row at all (missing
   * coverage is treated as "we don't know", never as "the day is fine" — see
   * shopifyWindowAggregate.ts). */
  windowHasDataGap: boolean;
  /** Every such day, for display/debugging — empty when `windowHasDataGap` is `false`. */
  gapDays: string[];
}

/** Wraps a value with an explicit, already-known gap verdict. Used by
 * `shopifyWindowAggregate.ts` after it has actually scanned the window's coverage rows — this
 * function does no scanning itself, it just names the wrapping operation so call sites read as
 * "producing a gap-aware value" rather than an anonymous object literal. */
export function markGap<T>(value: T, windowHasDataGap: boolean, gapDays: string[]): GapAware<T> {
  return { value, windowHasDataGap, gapDays };
}

/**
 * The one sanctioned escape hatch: unwrap a `GapAware<T>` to its plain value, discarding the gap
 * verdict. Requires a `justification` — not read or validated, just REQUIRED, so this can never
 * be called by accident or silently copy-pasted without the author writing down why. Prefer
 * carrying the `GapAware<T>` all the way to the surface (a packet/UI field showing both the
 * number and the flag) over calling this; reach for it only when a caller genuinely has no way
 * to represent the flag (e.g. handing a bare number to a third-party formatter).
 */
export function unsafeIgnoreGap<T>(gapAware: GapAware<T>, justification: string): T {
  if (justification.trim().length === 0) {
    throw new Error("unsafeIgnoreGap: a justification is required, not just accepted");
  }
  return gapAware.value;
}

/** Combines several `GapAware` verdicts (e.g. one per window, or shopify+meta side by side) into
 * one — gap-affected if ANY input is, with the union of their gap days (deduped, sorted). Useful
 * when a caller needs one flag summarizing several gap-aware figures at once (e.g. an account
 * doc's blended MER alongside its shopifyNetRevenue for the same window share the same
 * underlying gap days, but this makes combining them explicit rather than assumed). */
export function combineGapVerdicts(
  inputs: readonly Pick<GapAware<unknown>, "windowHasDataGap" | "gapDays">[],
): Pick<GapAware<unknown>, "windowHasDataGap" | "gapDays"> {
  const gapDays = new Set<string>();
  let windowHasDataGap = false;
  for (const input of inputs) {
    if (input.windowHasDataGap) windowHasDataGap = true;
    for (const day of input.gapDays) gapDays.add(day);
  }
  return { windowHasDataGap, gapDays: [...gapDays].sort() };
}
