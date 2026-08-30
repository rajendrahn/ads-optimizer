// New-vs-repeat derivation (§7.2, §12) — "New-versus-repeat is derived from each customer's
// order sequence across the imported and synced data (first order chronologically = new), not
// read from any single-order or point-in-time field."
//
// IMPLEMENTATION_PLAN.md B5's orchestrator brief is explicit that this must be **recomputable
// across the full accumulated dataset**, not a one-shot decision baked in at import time — a
// customer's true first order is inside the current (earliest-orders) CSV export, but will not
// be for a later export covering a later period, and an ongoing GraphQL-synced order for an
// *existing* customer needs to know about that customer's earlier CSV-imported orders to be
// classified correctly as a repeat purchase.
//
// `computeNewVsRepeat` is the pure decision (no Firestore); `recomputeAndPersistNewVsRepeat` is
// the full-collection pass that reads every order, recomputes, and writes back only what
// changed. Called once at the end of both MATRIXIFY_IMPORT and SHOPIFY_SYNC_ORDERS (see those
// handlers) rather than as its own scheduled task — a full scan is cheap at this account's
// scale (tens of thousands of orders, not millions), matching §10.1's "full recompute over
// incremental complexity" precedent already established for Meta features.

import { collectionRef, COLLECTIONS, upsertWithVersionGuard } from "@shared/firestore/index.ts";
import { shopifyOrderSchema, type ShopifyOrder } from "@shared/schema/index.ts";
import type { Firestore } from "firebase-admin/firestore";

export interface CustomerOrderRef {
  orderId: string;
  customerId: string;
  createdAt: Date;
}

/**
 * Pure: given every order that has a customer id, decide which one is each customer's
 * chronological first (new = true) vs. every later one (repeat = false). Orders with no
 * customer id are the caller's responsibility to exclude — this function has no notion of
 * "unknown" (see shared/schema/shopify.ts: `isNewCustomer` stays `null` for those, this
 * function is never asked about them). Ties (identical `createdAt`, which Matrixify timestamps
 * are precise to the second and could theoretically collide) are broken by `orderId` so the
 * result is deterministic regardless of input order.
 */
export function computeNewVsRepeat(orders: readonly CustomerOrderRef[]): Map<string, boolean> {
  const byCustomer = new Map<string, CustomerOrderRef[]>();
  for (const o of orders) {
    let group = byCustomer.get(o.customerId);
    if (!group) {
      group = [];
      byCustomer.set(o.customerId, group);
    }
    group.push(o);
  }

  const result = new Map<string, boolean>();
  for (const group of byCustomer.values()) {
    const sorted = [...group].sort((a, b) => {
      const diff = a.createdAt.getTime() - b.createdAt.getTime();
      return diff !== 0 ? diff : a.orderId.localeCompare(b.orderId);
    });
    sorted.forEach((o, index) => result.set(o.orderId, index === 0));
  }
  return result;
}

export interface RecomputeNewVsRepeatResult {
  ordersScanned: number;
  ordersWithCustomerId: number;
  customersConsidered: number;
  changed: number;
}

/**
 * Reads every `shopifyOrders` document, recomputes new-vs-repeat over the full accumulated
 * dataset, and writes back only the orders whose `isNewCustomer` actually changed — through the
 * A2 version guard, using each order's own already-stored `sourceUpdatedAt` (an equal-version
 * write, which the guard accepts per its documented idempotency rule; see
 * shared/firestore/versionGuard.ts).
 */
export async function recomputeAndPersistNewVsRepeat(
  db: Firestore,
): Promise<RecomputeNewVsRepeatResult> {
  const ordersRef = collectionRef(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
  const snap = await ordersRef.get();
  const allOrders: ShopifyOrder[] = snap.docs.map((d) => d.data());

  const withCustomer = allOrders.filter(
    (o): o is ShopifyOrder & { customerId: string } => o.customerId !== null,
  );
  const computed = computeNewVsRepeat(
    withCustomer.map((o) => ({
      orderId: o.orderId,
      customerId: o.customerId,
      createdAt: o.createdAt,
    })),
  );

  let changed = 0;
  for (const order of withCustomer) {
    const isNew = computed.get(order.orderId) ?? null;
    if (order.isNewCustomer === isNew) continue;
    changed++;
    await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.shopifyOrders,
      docId: order.orderId,
      incoming: { ...order, isNewCustomer: isNew },
      schema: shopifyOrderSchema,
    });
  }

  return {
    ordersScanned: allOrders.length,
    ordersWithCustomerId: withCustomer.length,
    customersConsidered: new Set(withCustomer.map((o) => o.customerId)).size,
    changed,
  };
}
