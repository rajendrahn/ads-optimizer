// Diagnostic: makes ONE minimal, read-only Meta call and reports the rate-limit picture.
//
// The question this answers: are we hitting code 80004 because of genuine call volume, or
// because the app is on Marketing API **Development Access** rather than Standard Access?
// Development tier caps an app at a far lower per-ad-account ceiling, so a workload that is
// modest under Standard can be permanently throttled under Development.
//
// Meta reports the tier in the X-Business-Use-Case-Usage header as `ads_api_access_tier`,
// alongside the usage percentages sec 7.1's pre-emption reads. This prints the raw header so
// the answer is evidence, not inference.
//
// Run: npx tsx scripts/check-meta-limits.ts
// Never prints the access token.

import { getSecret } from "@shared/secrets/index.ts";
import { META_API_VERSION, META_AD_ACCOUNT_ID } from "./config.ts";

interface BucEntry {
  type?: string;
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
  ads_api_access_tier?: string;
}

async function main() {
  const token = await getSecret("meta-system-user-token");

  // The smallest possible read: one field, one object.
  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_AD_ACCOUNT_ID}?fields=id&access_token=${token}`;
  const res = await fetch(url);
  const body: unknown = await res.json().catch(() => undefined);

  console.log(`HTTP ${res.status}`);

  const raw = res.headers.get("x-business-use-case-usage");
  const appUsage = res.headers.get("x-app-usage");
  const adAccountUsage = res.headers.get("x-ad-account-usage");

  if (!raw) {
    console.log("\nNo X-Business-Use-Case-Usage header returned.");
  } else {
    console.log("\n=== X-Business-Use-Case-Usage ===");
    let parsed: Record<string, BucEntry[]> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, BucEntry[]>;
    } catch {
      console.log("  (unparseable) ", raw);
    }
    if (parsed) {
      for (const [key, entries] of Object.entries(parsed)) {
        for (const e of entries) {
          console.log(`  ${key} / ${e.type ?? "?"}`);
          console.log(`    call_count                     : ${e.call_count ?? 0}%`);
          console.log(`    total_cputime                  : ${e.total_cputime ?? 0}%`);
          console.log(`    total_time                     : ${e.total_time ?? 0}%`);
          console.log(
            `    estimated_time_to_regain_access: ${e.estimated_time_to_regain_access ?? 0} min`,
          );
          if (e.ads_api_access_tier) {
            console.log(`    ads_api_access_tier            : ${e.ads_api_access_tier}`);
          }
        }
      }
    }
  }

  if (appUsage) console.log(`\n=== X-App-Usage ===\n  ${appUsage}`);
  if (adAccountUsage) console.log(`\n=== X-Ad-Account-Usage ===\n  ${adAccountUsage}`);

  if (!res.ok) {
    const err = (body as { error?: { code?: number; message?: string } } | undefined)?.error;
    console.log(`\nError code ${err?.code}: ${err?.message}`);
  }

  // The interpretation, stated so a reader does not have to know Meta's tier semantics.
  // Meta keys this header by the BARE account id ("456833154967349"), while our config carries
  // the act_-prefixed form the Graph API path needs. Looking it up by the prefixed id silently
  // finds nothing and reports "tier not known" while the tier is sitting right there — so scan
  // the entries rather than assuming the key shape.
  let tier: string | undefined;
  if (raw) {
    const parsedForTier = JSON.parse(raw) as Record<string, BucEntry[]>;
    for (const entries of Object.values(parsedForTier)) {
      for (const e of entries) {
        if (e.ads_api_access_tier) tier = e.ads_api_access_tier;
      }
    }
  }
  console.log("\n=== verdict ===");
  if (tier === "development_access") {
    console.log("  DEVELOPMENT ACCESS. This is almost certainly the cause of repeated 80004.");
    console.log("  The ceiling is far lower than Standard Access and no amount of client-side");
    console.log("  backoff raises it. Apply for Advanced/Standard Access to the Marketing API");
    console.log("  in the app's App Review section (needs Business Verification).");
  } else if (tier) {
    console.log(`  Access tier reported as: ${tier}`);
  } else {
    console.log("  Tier not reported in this response - see the usage percentages above.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
