// §15.2's three-state verdict — a literal comparison of a confidence interval's position against
// a target, not a "good/bad" judgement baked into the label. `ABOVE_TARGET` means the interval
// sits entirely above the target value; `BELOW_TARGET` means it sits entirely below; anything
// else (the interval straddles the target, or either bound is unknown) is `NOT_DISTINGUISHABLE`.
//
// This literal reading is deliberate: it lets ONE function serve both ROAS (where "above target"
// is the good outcome) and CPA (where "below target" is the good outcome) without a direction
// flag baked into the verdict itself — the business-meaning judgement ("is this good") belongs to
// whatever reads the verdict later (D1/D2), not to this layer. Documented here so a future reader
// doesn't "fix" CPA's verdict to mean "efficient" instead of "positioned above the target number".

export type Verdict = "ABOVE_TARGET" | "BELOW_TARGET" | "NOT_DISTINGUISHABLE";

/**
 * `target` is compared against the interval's bounds; `intervalLow`/`intervalHigh` are the
 * already-scaled ROAS/CPA interval (see interval.ts). Either bound being `null` (nothing to
 * compare) always yields `NOT_DISTINGUISHABLE` — never a guess.
 */
export function computeVerdict(
  intervalLow: number | null,
  intervalHigh: number | null,
  target: number,
): Verdict {
  if (intervalLow === null || intervalHigh === null) return "NOT_DISTINGUISHABLE";
  if (intervalLow > target) return "ABOVE_TARGET";
  if (intervalHigh < target) return "BELOW_TARGET";
  return "NOT_DISTINGUISHABLE";
}
