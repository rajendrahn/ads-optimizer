// Shared test fixtures for entitySync.emulator.test.ts and configSnapshot.emulator.test.ts —
// a small synthetic account mirroring the real one's shape: one CBO campaign, one ABO campaign
// (ad-set-owned budget), one orphan campaign (no budget, no ad sets — the live UNKNOWN case),
// a standard creative and a composite one, and one ad with no creative at all. Not a *.test.ts
// file itself — nothing here is a test.

import { vi } from "vitest";
import { META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import type { CanonSettings } from "@shared/canon/index.ts";

export const TEST_CANON: CanonSettings = {
  accountId: META_AD_ACCOUNT_ID,
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  attributionWindow: "7d_click_1d_view",
  purchaseActionType: "offsite_conversion.fb_pixel_purchase",
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

export function buildTestFetchImpl() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(url as string);
    if (u.pathname.endsWith(`/${META_AD_ACCOUNT_ID}`)) return jsonResponse({ currency: "INR" });
    if (u.pathname.endsWith("/campaigns")) {
      return jsonResponse({
        data: [
          {
            id: "cmp_cbo",
            name: "CBO campaign",
            status: "ACTIVE",
            objective: "OUTCOME_SALES",
            buying_type: "AUCTION",
            daily_budget: "50000",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
          {
            id: "cmp_abo",
            name: "ABO campaign",
            status: "ACTIVE",
            objective: "OUTCOME_SALES",
            buying_type: "AUCTION",
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
          {
            id: "cmp_orphan",
            name: "Old orphan campaign",
            status: "PAUSED",
            created_time: "2024-01-01T00:00:00+0530",
            updated_time: "2024-01-01T00:00:00+0530",
          },
        ],
      });
    }
    if (u.pathname.endsWith("/adsets")) {
      return jsonResponse({
        data: [
          {
            id: "as_under_cbo",
            campaign_id: "cmp_cbo",
            name: "Ad set under CBO",
            status: "ACTIVE",
            optimization_goal: "OFFSITE_CONVERSIONS",
            targeting: { publisher_platforms: ["facebook", "instagram"] },
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
          {
            id: "as_under_abo",
            campaign_id: "cmp_abo",
            name: "Ad set under ABO",
            status: "ACTIVE",
            daily_budget: "3000",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
        ],
      });
    }
    if (u.pathname.endsWith("/ads")) {
      return jsonResponse({
        data: [
          {
            id: "ad_standard",
            adset_id: "as_under_cbo",
            campaign_id: "cmp_cbo",
            name: "Ad with standard creative",
            status: "ACTIVE",
            creative: { id: "cr_standard" },
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
          {
            id: "ad_composite",
            adset_id: "as_under_abo",
            campaign_id: "cmp_abo",
            name: "Ad with composite creative",
            status: "ACTIVE",
            creative: { id: "cr_composite" },
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
          {
            id: "ad_no_creative",
            adset_id: "as_under_abo",
            campaign_id: "cmp_abo",
            name: "Ad with no creative",
            status: "PAUSED",
            creative: null,
            created_time: "2026-01-01T00:00:00+0530",
            updated_time: "2026-01-01T00:00:00+0530",
          },
        ],
      });
    }
    if (u.pathname.endsWith("/adcreatives")) {
      return jsonResponse({
        data: [
          {
            id: "cr_standard",
            name: "Standard creative",
            image_hash: "hash1",
            object_story_spec: {
              link_data: {
                link: "https://sparkleandglow.co.in/?utm_content=ad_standard",
                message: "body text",
                name: "headline",
              },
            },
          },
          {
            id: "cr_composite",
            name: "Composite creative",
            asset_feed_spec: { images: [{ hash: "a1" }, { hash: "b2" }] },
            object_story_spec: {
              link_data: { link: "https://sparkleandglow.co.in/?utm_content=ad_composite" },
            },
          },
        ],
      });
    }
    throw new Error(`unexpected path in test fixture: ${u.pathname}`);
  });
}
