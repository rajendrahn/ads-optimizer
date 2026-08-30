// Shared test fixtures for insightsSync.emulator.test.ts and pollAsyncReport.emulator.test.ts —
// a fake Meta fetch implementation covering the async report submit/poll/page endpoints. Not a
// *.test.ts file itself — mirrors entities/testFixtures.ts's own "not a test file" convention.

import { vi } from "vitest";
import { META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import type { CanonSettings } from "@shared/canon/index.ts";

export const TEST_CANON: CanonSettings = {
  accountId: META_AD_ACCOUNT_ID,
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  attributionWindow: "7d_click_1d_view",
  purchaseActionType: "omni_purchase",
  modelConfig: {
    recommendationProvider: "anthropic",
    recommendationModel: "claude-fable-5",
    creativeReasoningModel: "claude-fable-5",
    backgroundCreativeTaggingModel: "claude-haiku-4-5",
    taggingUsesBatchApi: true,
    effort: "high",
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a page of synthetic ad-level insight rows for `adIds`, all on `date`. */
export function buildInsightsRows(adIds: string[], date: string) {
  return adIds.map((adId, i) => ({
    ad_id: adId,
    adset_id: `as_${adId}`,
    campaign_id: `cmp_${adId}`,
    date_start: date,
    date_stop: date,
    spend: `${(i + 1) * 10}.00`,
    impressions: String((i + 1) * 100),
    reach: String((i + 1) * 80),
    frequency: "1.25",
    clicks: String((i + 1) * 5),
    actions: [
      { action_type: "landing_page_view", value: String((i + 1) * 3) },
      { action_type: "add_to_cart", value: String(i + 1) },
      { action_type: "initiate_checkout", value: "1" },
      { action_type: "omni_purchase", value: "1" },
    ],
    action_values: [{ action_type: "omni_purchase", value: "999.00" }],
  }));
}

/** A fake fetch that always reports the submitted report as immediately "Job Completed" and
 * returns one page of `rows` with no further pages. */
export function buildImmediatelyReadyFetchImpl(reportRunId: string, rows: unknown[]) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(url as string, "https://graph.facebook.com");
    if (u.pathname.endsWith("/insights") && u.pathname.includes(META_AD_ACCOUNT_ID)) {
      return jsonResponse({ report_run_id: reportRunId });
    }
    if (u.pathname.endsWith(`/${reportRunId}/insights`)) {
      return jsonResponse({ data: rows, paging: { cursors: { after: "end" } } });
    }
    if (u.pathname.endsWith(`/${reportRunId}`)) {
      return jsonResponse({ async_status: "Job Completed", async_percent_completion: 100 });
    }
    if (u.pathname.endsWith(`/${META_AD_ACCOUNT_ID}`)) {
      return jsonResponse({ currency: "INR" });
    }
    throw new Error(`unexpected path in test fixture: ${u.pathname}`);
  });
}

/** A fake fetch reporting "Job Running" (not yet ready) for status polls. */
export function buildPendingFetchImpl(reportRunId: string) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(url as string, "https://graph.facebook.com");
    if (u.pathname.endsWith(`/${reportRunId}`)) {
      return jsonResponse({ async_status: "Job Running", async_percent_completion: 40 });
    }
    throw new Error(`unexpected path in test fixture: ${u.pathname}`);
  });
}

/** A fake fetch that pages `pages` (an array of row arrays) across successive calls, honoring
 * the `after` cursor as a page index. */
export function buildMultiPageFetchImpl(reportRunId: string, pages: unknown[][]) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(url as string, "https://graph.facebook.com");
    if (u.pathname.endsWith(`/${reportRunId}/insights`)) {
      const after = u.searchParams.get("after");
      const pageIndex = after ? Number.parseInt(after, 10) : 0;
      const rows = pages[pageIndex] ?? [];
      const isLast = pageIndex >= pages.length - 1;
      return jsonResponse({
        data: rows,
        paging: isLast
          ? { cursors: { after: String(pageIndex) } }
          : { cursors: { after: String(pageIndex + 1) }, next: "has-more" },
      });
    }
    if (u.pathname.endsWith(`/${reportRunId}`)) {
      return jsonResponse({ async_status: "Job Completed", async_percent_completion: 100 });
    }
    if (u.pathname.endsWith(`/${META_AD_ACCOUNT_ID}`)) {
      return jsonResponse({ currency: "INR" });
    }
    throw new Error(`unexpected path in test fixture: ${u.pathname}`);
  });
}
