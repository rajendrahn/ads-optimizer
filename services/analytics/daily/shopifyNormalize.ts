// Pure ShopifyOrder/ShopifyRefund -> normalized-row mapping (§5). No Firestore. Unlike Meta,
// there is no native/reporting timezone distinction to bridge here — `createdAt` is already a
// real UTC instant (B5 parses Shopify's own `±HHMM`-offset timestamps explicitly), so
// `toReportingDay` is the whole job for the day; currency normalization mirrors metaNormalize.ts
// exactly. No metric is derived, summed or joined here — one row in, one row out (see
// shared/schema/analytics.ts's module comment for why C1 deliberately does not pre-aggregate
// Shopify data by day).

import { toReportingDay } from "@shared/canon/index.ts";
import type {
  ShopifyOrder,
  ShopifyOrderNormalized,
  ShopifyRefund,
  ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import { normalizeAmountToReportingCurrency } from "./currency.ts";

export interface NormalizeShopifyRowCtx {
  reportingTimezone: string;
  reportingCurrency: string;
  computedAt: Date;
}

export function normalizeShopifyOrder(
  order: ShopifyOrder,
  ctx: NormalizeShopifyRowCtx,
): ShopifyOrderNormalized {
  return {
    orderId: order.orderId,
    reportingDay: toReportingDay(order.createdAt, ctx.reportingTimezone),
    reportingTimezone: ctx.reportingTimezone,
    nativeCreatedAt: order.createdAt,
    totalPrice: normalizeAmountToReportingCurrency(
      order.totalPriceMinorUnits,
      order.currency,
      ctx.reportingCurrency,
    ),
    subtotalPrice: normalizeAmountToReportingCurrency(
      order.subtotalPriceMinorUnits,
      order.currency,
      ctx.reportingCurrency,
    ),
    totalDiscounts: normalizeAmountToReportingCurrency(
      order.totalDiscountsMinorUnits,
      order.currency,
      ctx.reportingCurrency,
    ),
    totalShipping:
      order.totalShippingMinorUnits == null
        ? null
        : normalizeAmountToReportingCurrency(
            order.totalShippingMinorUnits,
            order.currency,
            ctx.reportingCurrency,
          ),
    isNewCustomer: order.isNewCustomer,
    country: order.country,
    customerId: order.customerId,
    resolvedAdId: order.resolvedAdId,
    resolvedCampaignId: order.resolvedCampaignId,
    // C2 addition — see shared/schema/analytics.ts's comment on shopifyOrderNormalizedSchema for
    // why these were missing and why C2 needed them carried through.
    resolutionMethod: order.resolutionMethod ?? null,
    resolutionConfidence: order.resolutionConfidence ?? null,
    source: order.source,
    sourceUpdatedAt: order.sourceUpdatedAt,
    computedAt: ctx.computedAt,
  };
}

export function normalizeShopifyRefund(
  refund: ShopifyRefund,
  ctx: NormalizeShopifyRowCtx,
): ShopifyRefundNormalized {
  return {
    orderId: refund.orderId,
    refundId: refund.refundId,
    reportingDay: toReportingDay(refund.createdAt, ctx.reportingTimezone),
    reportingTimezone: ctx.reportingTimezone,
    nativeCreatedAt: refund.createdAt,
    amount: normalizeAmountToReportingCurrency(
      refund.amountMinorUnits,
      refund.currency,
      ctx.reportingCurrency,
    ),
    reason: refund.reason,
    sourceUpdatedAt: refund.sourceUpdatedAt,
    computedAt: ctx.computedAt,
  };
}
