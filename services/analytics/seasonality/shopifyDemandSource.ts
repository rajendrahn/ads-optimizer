// Thin Firestore reader feeding demandIndex.ts's pure core: gross daily order revenue from C1's
// `shopifyOrdersNormalized`, and per-day gap status from C1's `shopifyDailyCoverage`. Both are
// range-queried on `reportingDay` (a single-field inequality range — no composite index needed;
// Firestore indexes every field singly by default) over exactly the day span
// context.ts determines it needs, rather than reading either collection in full.
//
// Revenue is GROSS `totalPrice` (order value at placement), not net of refunds — "demand" here
// means "orders placed", matching this step's own brief ("derived from the account's own order
// history"). Refunds are a separate, later event (C1's own module comment on
// shopifyRefundsNormalized) and out of scope for a demand signal.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "@shared/firestore/collections.ts";
import { createRepository } from "@shared/firestore/repository.ts";
import {
  shopifyDailyCoverageSchema,
  shopifyOrderNormalizedSchema,
  type ReportingDay,
  type ShopifyDailyCoverage,
  type ShopifyOrderNormalized,
} from "@shared/schema/index.ts";

export interface DemandSourceMaps {
  /** Gross order revenue (minor units), summed per reporting day, for days with at least one
   *  order in the queried range. A day with no orders is simply absent — demandIndex.ts treats
   *  an absent-but-clean day as revenue 0, and an absent-and-not-covered day as unusable; see its
   *  own module comment. */
  dailyRevenueMinorUnits: Map<ReportingDay, number>;
  /** `hasCoverageGap` per reporting day, for every day that has a coverage row in the queried
   *  range. A day with NO entry here was never covered by `shopifyDailyCoverage` at all (outside
   *  the account's observed history) — demandIndex.ts treats that the same as a gap. */
  coverageByDay: Map<ReportingDay, boolean>;
}

/** Loads both maps for the INCLUSIVE range `[fromDay, toDay]`. Returns empty maps for an empty
 *  (fromDay > toDay) range rather than querying Firestore. */
export async function loadDemandSourceMaps(
  db: Firestore,
  fromDay: ReportingDay,
  toDay: ReportingDay,
): Promise<DemandSourceMaps> {
  if (fromDay > toDay) {
    return { dailyRevenueMinorUnits: new Map(), coverageByDay: new Map() };
  }

  const ordersRepo = createRepository<ShopifyOrderNormalized>(
    db,
    COLLECTIONS.shopifyOrdersNormalized,
    shopifyOrderNormalizedSchema,
  );
  const coverageRepo = createRepository<ShopifyDailyCoverage>(
    db,
    COLLECTIONS.shopifyDailyCoverage,
    shopifyDailyCoverageSchema,
  );

  const [orders, coverageRows] = await Promise.all([
    ordersRepo.query(
      (ref) =>
        ref.where("reportingDay", ">=", fromDay).where("reportingDay", "<=", toDay) as typeof ref,
    ),
    coverageRepo.query(
      (ref) =>
        ref.where("reportingDay", ">=", fromDay).where("reportingDay", "<=", toDay) as typeof ref,
    ),
  ]);

  const dailyRevenueMinorUnits = new Map<ReportingDay, number>();
  for (const order of orders) {
    const prior = dailyRevenueMinorUnits.get(order.reportingDay) ?? 0;
    dailyRevenueMinorUnits.set(order.reportingDay, prior + order.totalPrice.amountMinorUnits);
  }

  const coverageByDay = new Map<ReportingDay, boolean>();
  for (const row of coverageRows) {
    coverageByDay.set(row.reportingDay, row.hasCoverageGap);
  }

  return { dailyRevenueMinorUnits, coverageByDay };
}
