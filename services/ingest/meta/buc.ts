// §7.1: "Throttling is per business use case, reported in the X-Business-Use-Case-Usage
// response header as a percentage of budget consumed. The sync controller reads that header
// and backs off *before* the account is throttled."
//
// Per the A4 step spec, this is treated as a first-class component with its own tests
// against synthetic headers — not folded into the request function — because a throttled
// account stalls every sync, and header-parsing bugs are exactly the kind that hide until
// the one day usage actually gets high.
//
// Real shape of the header value (JSON-encoded string), keyed by ad-account or business ID,
// each key holding an array (usually one entry per business-use-case `type`):
//
//   {
//     "act_456833154967349": [
//       {
//         "type": "ads_insights",
//         "call_count": 28,
//         "total_cputime": 25,
//         "total_time": 22,
//         "estimated_time_to_regain_access": 0
//       }
//     ]
//   }
//
// `call_count` / `total_cputime` / `total_time` are each already percentages (0-100) of the
// relevant budget consumed. `estimated_time_to_regain_access` is minutes, and is nonzero only
// once Meta has already started throttling that key — at that point pre-emption has failed
// and this is reactive information instead, which the backoff decision below still respects.

export interface BucUsageEntry {
  /** The top-level object key this entry came from — an ad-account or business ID. Kept for
   * observability; the decision function below doesn't need it, since a single account with
   * one ad account has at most one meaningfully distinct key. */
  key: string;
  type?: string;
  callCount: number;
  totalCpuTime: number;
  totalTime: number;
  /** Minutes; >0 means Meta is already throttling this key. */
  estimatedTimeToRegainAccess: number;
}

export interface ParsedBucUsage {
  entries: BucUsageEntry[];
  /** Max of callCount/totalCpuTime/totalTime across every entry — the single number the
   * backoff decision acts on. */
  maxUsagePercent: number;
  maxEstimatedMinutesToRegainAccess: number;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Parses the raw `X-Business-Use-Case-Usage` header value. Returns `null` for a
 * missing/empty header, an unparseable value, or a value with no recognizable usage entries
 * — deliberately never throws, since a header-parsing failure must not take down the request
 * that carried it. A malformed header logs a warning so the failure is still observable.
 */
export function parseBucHeader(headerValue: string | null | undefined): ParsedBucUsage | null {
  if (!headerValue || headerValue.trim() === "") return null;

  let raw: unknown;
  try {
    raw = JSON.parse(headerValue);
  } catch {
    console.warn("[meta] X-Business-Use-Case-Usage header was not valid JSON; ignoring it", {
      headerValue,
    });
    return null;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const entries: BucUsageEntry[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      entries.push({
        key,
        type: typeof rec.type === "string" ? rec.type : undefined,
        callCount: toFiniteNumber(rec.call_count),
        totalCpuTime: toFiniteNumber(rec.total_cputime),
        totalTime: toFiniteNumber(rec.total_time),
        estimatedTimeToRegainAccess: toFiniteNumber(rec.estimated_time_to_regain_access),
      });
    }
  }

  if (entries.length === 0) return null;

  const maxUsagePercent = Math.max(
    0,
    ...entries.map((e) => Math.max(e.callCount, e.totalCpuTime, e.totalTime)),
  );
  const maxEstimatedMinutesToRegainAccess = Math.max(
    0,
    ...entries.map((e) => e.estimatedTimeToRegainAccess),
  );

  return { entries, maxUsagePercent, maxEstimatedMinutesToRegainAccess };
}

export interface BucThrottleDecision {
  shouldThrottle: boolean;
  waitMs: number;
  reason: string;
}

export interface DecideBucBackoffOptions {
  /** Usage percentage at/above which the client starts pre-emptively backing off — default 90. */
  thresholdPercent?: number;
  /** Base wait applied once at the threshold; scales up for higher usage bands — default 2s. */
  cooldownMs?: number;
}

/**
 * Pure decision function: given the most recently parsed usage (or `null` before any request
 * has been made yet), decide whether the *next* request should wait, and for how long. This
 * is what makes the backoff pre-emptive — it's consulted before sending a request, using the
 * usage the *previous* response reported, not in reaction to a failure.
 */
export function decideBucBackoff(
  usage: ParsedBucUsage | null,
  opts: DecideBucBackoffOptions = {},
): BucThrottleDecision {
  const thresholdPercent = opts.thresholdPercent ?? 90;
  const cooldownMs = opts.cooldownMs ?? 2000;

  if (!usage) {
    return { shouldThrottle: false, waitMs: 0, reason: "no usage data yet" };
  }

  // Meta has already started throttling this key — reactive at this point, but still the
  // most reliable wait estimate available, capped so a bad/huge value can't stall a task
  // for hours.
  if (usage.maxEstimatedMinutesToRegainAccess > 0) {
    const waitMs = Math.min(usage.maxEstimatedMinutesToRegainAccess * 60_000, 15 * 60_000);
    return {
      shouldThrottle: true,
      waitMs,
      reason: `Meta reports active throttling; estimated_time_to_regain_access=${usage.maxEstimatedMinutesToRegainAccess}min`,
    };
  }

  if (usage.maxUsagePercent >= 100) {
    return {
      shouldThrottle: true,
      waitMs: cooldownMs * 4,
      reason: `usage at ${usage.maxUsagePercent}% (>=100%)`,
    };
  }
  if (usage.maxUsagePercent >= 95) {
    return {
      shouldThrottle: true,
      waitMs: cooldownMs * 2,
      reason: `usage at ${usage.maxUsagePercent}% (>=95%)`,
    };
  }
  if (usage.maxUsagePercent >= thresholdPercent) {
    return {
      shouldThrottle: true,
      waitMs: cooldownMs,
      reason: `usage at ${usage.maxUsagePercent}% (>= threshold ${thresholdPercent}%)`,
    };
  }

  return {
    shouldThrottle: false,
    waitMs: 0,
    reason: `usage at ${usage.maxUsagePercent}% (< threshold ${thresholdPercent}%)`,
  };
}
