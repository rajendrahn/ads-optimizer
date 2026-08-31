// Pure computation of shopifyDailyCoverage rows (see shared/schema/analytics.ts's module
// comment for why this is the one place C1 aggregates by day). Reads `knownGaps` from
// `syncState/shopify_orders` — recomputed fresh by B5 on every run of its own tasks — and never
// re-derives the gap itself; that's B5's `computeShopifyOrdersGap`, not C1's job to duplicate.
//
// Iterates every calendar day in `[fromDay, toDay]` via A3's `addCalendarDays` (pure calendar
// arithmetic, no timezone — exactly the tool that function exists for, per its own module
// comment), not `reportingDayToUtcRange`, since this loop never needs to touch an instant.

import { addCalendarDays } from "@shared/canon/index.ts";
import type {
  ReportingDay,
  ShopifyDailyCoverage,
  SyncStateKnownGap,
} from "@shared/schema/index.ts";

export interface ComputeShopifyDailyCoverageInput {
  reportingTimezone: string;
  accountId: string;
  /** Inclusive. */
  fromDay: ReportingDay;
  /** Inclusive. */
  toDay: ReportingDay;
  ordersObservedByDay: ReadonlyMap<ReportingDay, number>;
  refundsObservedByDay: ReadonlyMap<ReportingDay, number>;
  knownGaps: readonly SyncStateKnownGap[];
  computedAt: Date;
}

function findMatchingGap(
  day: ReportingDay,
  knownGaps: readonly SyncStateKnownGap[],
): SyncStateKnownGap | null {
  // `[startDate, endDateExclusive)` — plain string comparison is correct here because every
  // reporting day is a validated YYYY-MM-DD string, which sorts lexicographically exactly like
  // it sorts chronologically.
  return knownGaps.find((gap) => day >= gap.startDate && day < gap.endDateExclusive) ?? null;
}

export function computeShopifyDailyCoverage(
  input: ComputeShopifyDailyCoverageInput,
): ShopifyDailyCoverage[] {
  if (input.fromDay > input.toDay) return [];

  const rows: ShopifyDailyCoverage[] = [];
  for (let day = input.fromDay; day <= input.toDay; day = addCalendarDays(day, 1)) {
    const gap = findMatchingGap(day, input.knownGaps);
    rows.push({
      reportingDay: day,
      reportingTimezone: input.reportingTimezone,
      accountId: input.accountId,
      hasCoverageGap: gap !== null,
      gapReason: gap?.reason ?? null,
      ordersObserved: input.ordersObservedByDay.get(day) ?? 0,
      refundsObserved: input.refundsObservedByDay.get(day) ?? 0,
      computedAt: input.computedAt,
      sourceUpdatedAt: input.computedAt,
    });
  }
  return rows;
}
