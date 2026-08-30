// The Shopify orders coverage-gap computation — IMPLEMENTATION_PLAN.md B5's orchestrator brief:
// "There is a data gap the user has accepted for now: 2025-12-13 -> ~2026-07-01 ... Record this
// gap explicitly and loudly in syncState ... so C1/C2 do not silently compute 28-day windows
// over a hole."
//
// The gap is between how far the one-time Matrixify backfill reached (measured from the data,
// `backfillCoverageThroughDate`) and how far ongoing GraphQL sync can currently reach (Shopify's
// `read_orders` scope: roughly the last 60 days from "today", enforced by Shopify itself — see
// graphqlFetch.ts's module comment). This is recomputed fresh on every run rather than a fixed
// date range: `today` advances every day and nothing currently fetches data for the widening
// span in between, so **this gap grows wider every day the account goes without a further
// Matrixify export or without B6 webhooks going live** — a genuinely important property to get
// right, not an incidental implementation detail. A caller should recompute this every run, not
// cache a value computed once.

import { addCalendarDays } from "@shared/canon/index.ts";
import type { ReportingDay, SyncStateKnownGap } from "@shared/schema/index.ts";

/** Matches `read_orders`' documented restriction: an app without `read_all_orders` can only see
 * orders created within roughly the last 60 days, enforced by Shopify regardless of query
 * filter (verified live — see graphqlFetch.ts). */
export const SHOPIFY_READ_ORDERS_WINDOW_DAYS = 60;

export interface ComputeShopifyOrdersGapInput {
  /** `syncState/shopify_orders.backfillCoverageThroughDate` — null if no historical backfill
   * has completed yet (in which case there's nothing yet to call a "gap" relative to; the
   * whole account is simply unsynced, a different condition). */
  backfillCoverageThroughDate: ReportingDay | null;
  today: ReportingDay;
  reachableWindowDays?: number;
}

export function computeShopifyOrdersGap(input: ComputeShopifyOrdersGapInput): SyncStateKnownGap[] {
  if (!input.backfillCoverageThroughDate) return [];
  const reachableWindowDays = input.reachableWindowDays ?? SHOPIFY_READ_ORDERS_WINDOW_DAYS;
  const earliestReachable = addCalendarDays(input.today, -(reachableWindowDays - 1));

  if (input.backfillCoverageThroughDate >= earliestReachable) {
    // The backfill already reaches into (or past) the currently-reachable window — no hole.
    return [];
  }

  const gapStart = addCalendarDays(input.backfillCoverageThroughDate, 1);
  return [
    {
      startDate: gapStart,
      endDateExclusive: earliestReachable,
      reason:
        `Matrixify historical backfill covers Shopify orders created through ` +
        `${input.backfillCoverageThroughDate}. Ongoing GraphQL sync (read_orders scope only, ` +
        `no read_all_orders) can currently only see orders created on or after ` +
        `${earliestReachable} (a ~${reachableWindowDays}-day rolling window from ${input.today}, ` +
        `which moves forward every day). No order data exists for [${gapStart}, ` +
        `${earliestReachable}) via any sanctioned sync path, and this range WIDENS over time ` +
        `until a further Matrixify export or Shopify webhooks (B6) close it — do not compute a ` +
        `windowed aggregate spanning this range as if it were zero-activity.`,
    },
  ];
}
