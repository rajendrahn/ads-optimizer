// E3 — the guardrail rejection rate over time (§29 criterion 12: "No recommendation is ever
// issued on a sample the system cannot defend, measured by the rate of guardrail rejections
// trending toward zero as the evidence engine improves").
//
// Two distinct questions, two distinct computations, both over the same underlying data:
//   1. "Is the rate trending toward zero?" — needs a DENOMINATOR (how many recommendation
//      attempts actually reached a guardrail verdict) as well as a numerator. That denominator is
//      `recommendations` docs with `status` COMPLETE or REJECTED — a PENDING/GENERATING doc never
//      reached a verdict, and a FAILED one errored out before D5 ever ran (see
//      generateRecommendationTask.ts: `applyGuardrails` is called inside the same `try` block that
//      produces a FAILED doc on any earlier throw). `computeRejectionRateOverTime` below.
//   2. "Which limit is doing the rejecting, and is it a real target or a placeholder?" — needs the
//      richer `guardrailRejections` log (D5, §20.2), whose every violation carries
//      `judgedAgainst.{field,limit,source,actual}`. `summarizeGuardrailViolations` below.

import { toReportingDay } from "@shared/canon/reportingDay.ts";
import type { GuardrailRejectionLog } from "@shared/schema/index.ts";

export type RejectionRateGranularity = "day" | "month";

export interface RejectionRatePeriod {
  /** `YYYY-MM-DD` for `"day"`, `YYYY-MM` for `"month"`. */
  period: string;
  attempts: number;
  rejections: number;
  /** `null` when `attempts === 0` — an empty period is not a 0% rejection rate, it is a period
   * with nothing to judge. */
  rate: number | null;
}

function periodLabel(day: string, granularity: RejectionRateGranularity): string {
  return granularity === "month" ? day.slice(0, 7) : day;
}

/** Buckets recommendation attempts (COMPLETE or REJECTED — see module comment) by the reporting
 * day/month their `createdAt` falls in, and reports each period's rejection rate. Periods with no
 * attempts are simply absent from the result, not present with a fabricated `rate: 0`. */
export function computeRejectionRateOverTime(
  attempts: readonly { status: "COMPLETE" | "REJECTED"; createdAt: Date }[],
  reportingTimezone: string,
  granularity: RejectionRateGranularity = "month",
): RejectionRatePeriod[] {
  const byPeriod = new Map<string, { attempts: number; rejections: number }>();
  for (const rec of attempts) {
    const day = toReportingDay(rec.createdAt, reportingTimezone);
    const label = periodLabel(day, granularity);
    const bucket = byPeriod.get(label) ?? { attempts: 0, rejections: 0 };
    bucket.attempts += 1;
    if (rec.status === "REJECTED") bucket.rejections += 1;
    byPeriod.set(label, bucket);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, { attempts: a, rejections: r }]) => ({
      period,
      attempts: a,
      rejections: r,
      rate: a === 0 ? null : r / a,
    }));
}

export interface OverallRejectionRate {
  attempts: number;
  rejections: number;
  rate: number | null;
}

export function computeOverallRejectionRate(
  attempts: readonly { status: "COMPLETE" | "REJECTED" }[],
): OverallRejectionRate {
  const total = attempts.length;
  const rejected = attempts.filter((a) => a.status === "REJECTED").length;
  return { attempts: total, rejections: rejected, rate: total === 0 ? null : rejected / total };
}

export interface ViolationCodeCount {
  code: string;
  count: number;
}

export interface JudgedAgainstSourceCount {
  /** "settings" | "default" — see `guardrailJudgedAgainstSchema`. `null`/absent when a violation
   * carried no `judgedAgainst` at all (the two structural codes, `DECISION_UNIT_NOT_BUDGET_OWNER`
   * and `NOT_DELIVERING`/`NO_DECISION_UNIT`, have no single number to be judged against). */
  source: "settings" | "default" | "none";
  count: number;
}

export interface JudgedAgainstFieldSummary {
  field: string;
  source: "settings" | "default";
  /** The limit value violations against this field were most recently judged against — the
   * newest `judgedAgainst.limit` seen for this field, so a stale placeholder that has since been
   * corrected does not masquerade as the current one. Per D5's own notes: `targetCpa` defaults to
   * a ₹1,500 placeholder against a measured real account CPA of ₹1,761.63 — this is exactly the
   * kind of number an operator needs to see is a `"default"`, not read it as a deliberate target. */
  mostRecentLimit: number;
  mostRecentRejectedAt: Date;
  count: number;
}

export interface GuardrailViolationSummary {
  byCode: ViolationCodeCount[];
  byJudgedAgainstSource: JudgedAgainstSourceCount[];
  byField: JudgedAgainstFieldSummary[];
}

/** Breaks a set of `guardrailRejections` log entries down by violation code, by whether the limit
 * came from an operator setting or this system's built-in default, and by field — this is what
 * lets an operator tell "the model keeps proposing changes above a placeholder limit nobody has
 * reviewed yet" apart from "the model keeps proposing changes on samples too thin to trust", per
 * §20.2's framing of this log as a calibration signal in its own right, independent of the
 * recommendation-level Brier score. One rejection can carry more than one violation (D5's own
 * "report every failing gate, not just the first" convention) — every violation is counted once,
 * so these totals can exceed the rejection count. */
export function summarizeGuardrailViolations(
  rejections: readonly GuardrailRejectionLog[],
): GuardrailViolationSummary {
  const byCode = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byField = new Map<string, JudgedAgainstFieldSummary>();

  for (const rejection of rejections) {
    for (const violation of rejection.violations) {
      byCode.set(violation.code, (byCode.get(violation.code) ?? 0) + 1);
      const source = violation.judgedAgainst?.source ?? "none";
      bySource.set(source, (bySource.get(source) ?? 0) + 1);

      if (violation.judgedAgainst) {
        const key = violation.judgedAgainst.field;
        const existing = byField.get(key);
        if (!existing || rejection.rejectedAt > existing.mostRecentRejectedAt) {
          byField.set(key, {
            field: key,
            source: violation.judgedAgainst.source,
            mostRecentLimit: violation.judgedAgainst.limit,
            mostRecentRejectedAt: rejection.rejectedAt,
            count: (existing?.count ?? 0) + 1,
          });
        } else {
          byField.set(key, { ...existing, count: existing.count + 1 });
        }
      }
    }
  }

  return {
    byCode: [...byCode.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    byJudgedAgainstSource: [...bySource.entries()]
      .map(([source, count]) => ({ source: source as "settings" | "default" | "none", count }))
      .sort((a, b) => b.count - a.count),
    byField: [...byField.values()].sort((a, b) => b.count - a.count),
  };
}
