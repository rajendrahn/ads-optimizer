// §18 get_product_mix() — product-category spend/volume mix over a rolling window. This is the
// one tool in this directory that aggregates over raw rows AT REQUEST TIME (shopifyOrderLines
// has no pre-computed feature-store equivalent — §12's feature set never asked for one) rather
// than reading an already-aggregated document. The rows never leave this function: only the
// grouped totals are returned (§18's contract — pre-aggregated evidence, never rows to sum).
//
// Deliberately ACCOUNT-LEVEL ONLY — no per-campaign/per-ad product mix. At ~0.02% attribution
// coverage (B7), a per-ad slice of Shopify order lines would be built from a handful of
// name-matched or unresolved orders and would not be a meaningful answer; §6.3 forbids exactly
// this kind of over-confident per-entity Shopify read. PII boundary (§17.2): only orderId and
// per-line product fields are read; customerId is never touched, and the output carries no
// order-level or customer-level rows — grouped counts only.

import { z } from "zod";
import type { Firestore } from "firebase-admin/firestore";
import { addCalendarDays, toReportingDay } from "@shared/canon/index.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderNormalizedSchema,
  type ReportingDay,
  type ShopifyOrderLine,
  type ShopifyOrderNormalized,
} from "@shared/schema/index.ts";
import { defineTool, WINDOW_LABEL_JSON_ENUM } from "./types.ts";

const inputSchema = z.object({
  window: z.enum(["7d", "14d", "28d", "56d"]).default("28d"),
});

const WINDOW_DAYS: Readonly<Record<string, number>> = { "7d": 7, "14d": 14, "28d": 28, "56d": 56 };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadLinesForOrders(
  db: Firestore,
  orderIds: readonly string[],
): Promise<ShopifyOrderLine[]> {
  if (orderIds.length === 0) return [];
  const repo = createRepository<ShopifyOrderLine>(
    db,
    COLLECTIONS.shopifyOrderLines,
    shopifyOrderLineSchema,
  );
  const batches = await Promise.all(
    chunk(orderIds, 30).map((ids) => repo.query((ref) => ref.where("orderId", "in", ids))),
  );
  return batches.flat();
}

export const getProductMixTool = defineTool({
  name: "get_product_mix",
  description:
    "Account-level product-category mix (order lines grouped by product type) over a rolling " +
    "window — pre-aggregated counts and quantities, never individual orders. Account-level " +
    "only: at this account's ~0.02% attribution coverage, a per-campaign product mix would not " +
    "be a meaningful read.",
  inputSchema: {
    type: "object",
    properties: {
      window: { type: "string", enum: WINDOW_LABEL_JSON_ENUM, description: "Defaults to 28d." },
    },
    additionalProperties: false,
  },
  zodSchema: inputSchema,
  execute: async (input, ctx) => {
    const days = WINDOW_DAYS[input.window] ?? 28;
    const untilDay = toReportingDay(new Date(), ctx.canon.reportingTimezone);
    const sinceDay = addCalendarDays(untilDay, -(days - 1));

    const ordersRepo = createRepository<ShopifyOrderNormalized>(
      ctx.db,
      COLLECTIONS.shopifyOrdersNormalized,
      shopifyOrderNormalizedSchema,
    );
    const orders = await ordersRepo.query((ref) =>
      ref.where("reportingDay", ">=", sinceDay).where("reportingDay", "<=", untilDay),
    );
    const orderIds = orders.map((o) => o.orderId);
    const lines = await loadLinesForOrders(ctx.db, orderIds);

    interface Agg {
      productType: string;
      quantity: number;
      revenueMinorUnits: number;
      currency: string | null;
      orderIds: Set<string>;
    }
    const byType = new Map<string, Agg>();
    for (const line of lines) {
      const key = line.productType ?? "UNKNOWN";
      const existing = byType.get(key) ?? {
        productType: key,
        quantity: 0,
        revenueMinorUnits: 0,
        currency: line.currency,
        orderIds: new Set<string>(),
      };
      existing.quantity += line.quantity;
      // Only summed when every line seen so far agrees on currency — §5.2 forbids summing money
      // across currencies without an explicit FX conversion, and per-line prices are in the
      // ORIGINAL order currency (not FX-normalized, unlike the order-level totals), so this stays
      // a same-currency-only running total rather than silently mixing currencies.
      if (existing.currency === line.currency) {
        existing.revenueMinorUnits += line.priceMinorUnits * line.quantity;
      } else {
        existing.currency = null; // mixed currencies seen — stop claiming a total
      }
      existing.orderIds.add(line.orderId);
      byType.set(key, existing);
    }

    const byProductType = Array.from(byType.values())
      .map((a) => ({
        productType: a.productType,
        quantity: a.quantity,
        orderCount: a.orderIds.size,
        revenueMinorUnits: a.currency ? a.revenueMinorUnits : null,
        currency: a.currency,
      }))
      .sort((a, b) => b.quantity - a.quantity);

    return {
      window: input.window,
      sinceDay,
      untilDay: untilDay as ReportingDay,
      totalOrders: orders.length,
      byProductType,
      note:
        "Account-level aggregate only (no per-ad/per-campaign breakdown — see tool description). " +
        "revenueMinorUnits is null for a product type whose lines spanned more than one currency " +
        "in this window, rather than silently summing across currencies.",
    };
  },
});
