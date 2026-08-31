// The ONLY function in this codebase that sums `shopifyOrdersNormalized`/
// `shopifyRefundsNormalized` rows into a window total — see gapAware.ts's module comment for why
// that "only" is load-bearing, not incidental. Every Shopify-derived figure C2 writes
// (attributed revenue/purchases, net revenue, new-customer counts, refund amounts, and —
// upstream of this file — the account-level blended MER) is built by calling this once and
// reading `.value` out of the `GapAware` it returns; there is no lower-level "just sum the
// orders" helper exported for a future author to reach for and accidentally skip the flag.
//
// Callers pre-filter `orders`/`refunds` to whatever entity/window they're asking about — the
// same convention B7's `coverage.ts` already established ("the caller has already filtered a
// set of resolved orders down to whatever window/entity it's asking about"). This function does
// not re-filter by day itself (a caller building an "account, all-time-in-window" total and a
// caller building "this one ad's attributed orders" total both look the same to it) — it DOES
// independently determine the gap verdict from `window` + `coverageByDay`, because the verdict
// is a property of the WINDOW's Shopify coverage, not of which orders happen to be in the
// filtered list (an ad with zero attributed orders in a gap window is exactly as affected as one
// with several — the gap means "we cannot trust this range's completeness", not "this list looks
// short").

import type {
  ReportingDay,
  ShopifyDailyCoverage,
  ShopifyOrderNormalized,
  ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import { daysInRange, type DayRange } from "./windows.ts";
import { markGap, type GapAware } from "./gapAware.ts";

export interface ShopifyWindowTotals {
  currency: string;
  ordersCount: number;
  newCustomerOrdersCount: number;
  grossRevenueMinorUnits: number;
  /** Refunds whose OWN reportingDay falls in `window` (§5.1/C1: a refund is its own event on its
   * own day, not backdated to its parent order's day) — a cash-basis "returns booked this
   * period" figure, matching what `shopifyDailyCoverage.refundsObserved` already counts by. */
  refundsAmountMinorUnits: number;
  /** grossRevenueMinorUnits - refundsAmountMinorUnits. Not "the accounting-correct net of every
   * order's own eventual refund" — see this module's own note on why a window is a period, not a
   * per-order ledger. */
  netRevenueMinorUnits: number;
}

function zeroTotals(currency: string): ShopifyWindowTotals {
  return {
    currency,
    ordersCount: 0,
    newCustomerOrdersCount: 0,
    grossRevenueMinorUnits: 0,
    refundsAmountMinorUnits: 0,
    netRevenueMinorUnits: 0,
  };
}

/** Every day in `window` that is gap-affected — flagged `hasCoverageGap: true`, OR has no
 * coverage row at all. Missing coverage is treated as unknown-therefore-a-gap, never as "must be
 * fine" — `shopifyDailyCoverage` is written for every calendar day from the earliest observed
 * order/gap through today (C1's own note), so a genuinely missing row here means either this
 * window reaches earlier than any data C1 has ever seen, or C1 hasn't run yet; either way, "we
 * don't know" is the safe default, not "assume clean". */
function findGapDays(
  window: DayRange,
  coverageByDay: ReadonlyMap<ReportingDay, ShopifyDailyCoverage>,
): ReportingDay[] {
  const gapDays: ReportingDay[] = [];
  for (const day of daysInRange(window)) {
    const coverage = coverageByDay.get(day);
    if (!coverage || coverage.hasCoverageGap) gapDays.push(day);
  }
  return gapDays;
}

/**
 * Sums already entity/window-filtered orders and refunds into a `ShopifyWindowTotals`, wrapped
 * with the window's own gap verdict. `orders`/`refunds` may be empty (a genuine zero, distinct
 * from a gap — an entity can have real zero attributed orders in a perfectly well-covered
 * window, and this correctly returns `windowHasDataGap: false` for it).
 *
 * Throws if `orders`/`refunds` mix currencies — every amount here is expected to already be in
 * the reporting currency (§5.2), which `shopifyOrdersNormalized`/`shopifyRefundsNormalized`
 * guarantee (C1's `NormalizedMoney.currency`); a mismatch means a caller passed unnormalized
 * data, which is a bug worth failing loudly on rather than silently mixing.
 */
export function aggregateShopifyWindow(
  orders: readonly ShopifyOrderNormalized[],
  refunds: readonly ShopifyRefundNormalized[],
  coverageByDay: ReadonlyMap<ReportingDay, ShopifyDailyCoverage>,
  window: DayRange,
  reportingCurrency: string,
): GapAware<ShopifyWindowTotals> {
  const totals = zeroTotals(reportingCurrency);

  for (const order of orders) {
    if (order.totalPrice.currency !== reportingCurrency) {
      throw new Error(
        `aggregateShopifyWindow: order ${order.orderId} currency ${order.totalPrice.currency} != reporting currency ${reportingCurrency}`,
      );
    }
    totals.ordersCount += 1;
    totals.grossRevenueMinorUnits += order.totalPrice.amountMinorUnits;
    if (order.isNewCustomer === true) totals.newCustomerOrdersCount += 1;
  }

  for (const refund of refunds) {
    if (refund.amount.currency !== reportingCurrency) {
      throw new Error(
        `aggregateShopifyWindow: refund ${refund.orderId}_${refund.refundId} currency ${refund.amount.currency} != reporting currency ${reportingCurrency}`,
      );
    }
    totals.refundsAmountMinorUnits += refund.amount.amountMinorUnits;
  }

  totals.netRevenueMinorUnits = totals.grossRevenueMinorUnits - totals.refundsAmountMinorUnits;

  const gapDays = findGapDays(window, coverageByDay);
  return markGap(totals, gapDays.length > 0, gapDays);
}
