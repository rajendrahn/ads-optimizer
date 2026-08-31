// §15.3 — "the correction that matters most". An entity is selected for scaling BECAUSE its
// recent ROAS is high; part of that height is real and part is noise, and noise does not repeat.
// Left uncorrected, outcome tracking (E2) would systematically record correct decisions as
// failures once the noise regresses back toward the mean on its own.
//
// The estimator, in two plain sentences (same bar as interval.ts — this must be describable in
// the packet text a model reasons over): an entity's shrunk ROAS is a weighted average of its own
// observed ROAS and the account's ROAS in the same window, where the weight given to the
// entity's own number grows with its purchase count relative to a fixed pseudo-count; with few
// purchases the shrunk figure sits close to the account mean, and with many purchases it sits
// close to the entity's own raw number. This is the standard empirical-Bayes / Gamma-Poisson
// shrinkage move: it is mathematically equivalent to placing a Gamma prior on the entity's true
// ROAS centred on the account mean with a prior strength of `pseudoCount` purchases, and reading
// off the posterior mean — stated as a weighted average here because that is what the packet
// text will actually say, and because it avoids implementing a Gamma-distribution quantile
// function this codebase has no need for elsewhere.
//
// The pseudo-count `k` is deliberately the SAME number as the window's minimum purchase floor
// (shared/canon/statisticalThresholds.ts's `minPurchaseFloors`) rather than an independent tuning
// knob: an entity sitting exactly at the floor — the boundary this system already treats as "just
// barely enough to speak with any confidence" — is shrunk exactly halfway toward the account
// mean, which is the right amount of trust to place in a number sitting right at that line. One
// number to configure, not two, and the two effects (the floor forcing NOT_DISTINGUISHABLE, and
// the shrinkage weight) move together predictably as an operator adjusts it.

/**
 * `rawValue`/`accountMean` are the unshrunk ROAS figures for this entity and the account, over the
 * SAME window. `n` is the entity's own purchase count in that window (its own `sampleSize`, never
 * the account's). Returns `null` when either input is `null` — there is nothing to shrink toward,
 * or nothing to shrink; shrinkage never fabricates a value C2 itself left unmeasured.
 */
export function shrinkTowardAccountMean(
  rawValue: number | null,
  n: number,
  accountMean: number | null,
  pseudoCount: number,
): number | null {
  if (rawValue === null || accountMean === null) return null;
  const clampedN = Math.max(0, n);
  const denominator = clampedN + pseudoCount;
  if (denominator <= 0) return rawValue; // pseudoCount misconfigured to 0 and n=0 — nothing to lean on
  const weight = clampedN / denominator;
  return weight * rawValue + (1 - weight) * accountMean;
}
