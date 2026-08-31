// Reality #2: "an entity with no delivery in the window is 'not delivering' — a different and
// more useful answer than an escalated verdict or INSUFFICIENT_DATA." C4's own orchestrator note
// found `inLearningPhase` is effectively constant-true across the fleet because most of the 534
// ad sets are not delivering at all — escalating into a dead ad set (or trusting its learning-
// phase flag) produces confident-looking nonsense. This check runs BEFORE any verdict is trusted.

import type { WindowMetrics } from "@shared/schema/index.ts";

/** Real delivery in a window means real spend or real impressions — not a purchase count, since
 * a delivering-but-zero-purchase entity is a real, different case (genuinely below target, not
 * off). `undefined` (no window doc at all, e.g. the entity has never had a RECOMPUTE_FEATURES
 * pass reach it) is treated the same as zero — never assumed to be delivering. */
export function isDelivering(window: WindowMetrics | undefined): boolean {
  if (!window) return false;
  const spend = window.spendMinorUnits ?? 0;
  const impressions = window.impressions ?? 0;
  return spend > 0 || impressions > 0;
}
