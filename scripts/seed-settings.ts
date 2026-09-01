// Seeds settings/{accountId} — the reporting canon (sec 5) plus model config (sec 19.2) and,
// optionally, your real business targets (sec 15.1).
//
// WHY THIS EXISTS AND WHY IT RUNS FIRST. A3's loader throws on a missing or invalid settings
// document, deliberately: sec 5 is emphatic that timezone, currency, attribution window and
// purchase action type cannot be retrofitted, because every stored record is derived using
// them. A silent default here would corrupt every insight, feature and verdict downstream.
// So until this document exists, EVERY task fails immediately — which is the designed
// behaviour, not a bug to work around.
//
// Run:
//   npx tsx scripts/seed-settings.ts                       # inspect only, writes nothing
//   npx tsx scripts/seed-settings.ts --write               # write with PLACEHOLDER targets
//   npx tsx scripts/seed-settings.ts --write --target-roas 4.2 --target-cpa 1400
//                                                          # write with YOUR real targets (INR)
//
// --target-cpa is given in whole INR and converted to paise (minor units, sec 0.2).

import { getFirestore } from "firebase-admin/firestore";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import {
  canonSettingsSchema,
  DEFAULT_STATISTICAL_THRESHOLDS,
  type CanonSettings,
} from "@shared/canon/index.ts";
import { GCP_PROJECT_ID, META_AD_ACCOUNT_ID, ANTHROPIC_MODEL } from "./config.ts";

const args = process.argv.slice(2);
const shouldWrite = args.includes("--write");
const force = args.includes("--force");

function numericArg(flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  const n = Number(args[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
  return n;
}

const targetRoasArg = numericArg("--target-roas");
const targetCpaRupeesArg = numericArg("--target-cpa");

// Measured on this account during C2's live reconciliation. Shown so the placeholder's
// wrongness is visible at the moment of writing it, not discovered later in a recommendation.
const MEASURED_ACCOUNT_CPA_RUPEES = 1761.63;

const settings: CanonSettings = {
  accountId: META_AD_ACCOUNT_ID,
  // sec 5.1 — confirmed live during C1 against BOTH platforms: the Meta ad account's own
  // timezone_name and the Shopify shop's ianaTimezone are each "Asia/Kolkata".
  reportingTimezone: "Asia/Kolkata",
  // sec 5.2 — Meta account currency, Shopify shop currency and 37,170/37,172 rows of the real
  // order export all agree on INR, so no FX conversion happens anywhere today (C1).
  reportingCurrency: "INR",
  // sec 5.3 — pinned onto every insight row by B3 and confirmed by the user.
  attributionWindow: "7d_click_1d_view",
  purchaseActionType: "omni_purchase",
  modelConfig: {
    recommendationProvider: "anthropic",
    recommendationModel: ANTHROPIC_MODEL,
    creativeReasoningModel: ANTHROPIC_MODEL,
    backgroundCreativeTaggingModel: "claude-haiku-4-5",
    taggingUsesBatchApi: true,
    effort: "medium",
  },
  statisticalThresholds: {
    // Spread C3's own exported defaults and override ONLY the two business targets, rather
    // than restating the object here. Restating it means silently omitting any field C3 adds
    // later (intervalZScore was missed exactly that way on the first run of this script), and
    // the omission surfaces as a schema error at best or a wrong default at worst.
    ...DEFAULT_STATISTICAL_THRESHOLDS,
    targetRoas: targetRoasArg ?? DEFAULT_STATISTICAL_THRESHOLDS.targetRoas,
    targetCpaMinorUnits:
      targetCpaRupeesArg !== null
        ? Math.round(targetCpaRupeesArg * 100)
        : DEFAULT_STATISTICAL_THRESHOLDS.targetCpaMinorUnits,
  },
};

async function main() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: GCP_PROJECT_ID });
  }
  const db = getFirestore();

  // Validate BEFORE touching Firestore, so a malformed document can never be written and then
  // read back by a loader that throws on it.
  const parsed = canonSettingsSchema.parse(settings);

  const usingPlaceholderRoas = targetRoasArg === null;
  const usingPlaceholderCpa = targetCpaRupeesArg === null;
  const thresholds = parsed.statisticalThresholds ?? DEFAULT_STATISTICAL_THRESHOLDS;
  const cpaRupees = thresholds.targetCpaMinorUnits / 100;

  console.log(`project    : ${GCP_PROJECT_ID}`);
  console.log(`document   : settings/${parsed.accountId}`);
  console.log(`timezone   : ${parsed.reportingTimezone}`);
  console.log(`currency   : ${parsed.reportingCurrency}`);
  console.log(`attribution: ${parsed.attributionWindow} / ${parsed.purchaseActionType}`);
  console.log(
    `targetRoas : ${thresholds.targetRoas}${usingPlaceholderRoas ? "   <-- PLACEHOLDER" : ""}`,
  );
  console.log(
    `targetCpa  : INR ${cpaRupees.toFixed(2)}${usingPlaceholderCpa ? "   <-- PLACEHOLDER" : ""}`,
  );

  if (usingPlaceholderCpa) {
    console.log("");
    console.log(`  !! The measured CPA on this account is INR ${MEASURED_ACCOUNT_CPA_RUPEES}.`);
    console.log(
      `  !! A target of INR ${cpaRupees.toFixed(2)} is BELOW that, so healthy ad sets will be`,
    );
    console.log("  !! judged CPA_ABOVE_TARGET and the system will decline to scale them.");
    console.log("  !! Pass --target-cpa <rupees> with your real target.");
  }

  const ref = db.collection("settings").doc(parsed.accountId);
  const existing = await ref.get();

  if (!shouldWrite) {
    console.log("");
    console.log(
      existing.exists
        ? "Document EXISTS. Re-run with --write --force to overwrite."
        : "Document does NOT exist. Re-run with --write to create it.",
    );
    console.log("(dry run - nothing written)");
    return;
  }

  if (existing.exists && !force) {
    throw new Error(
      "settings document already exists. Overwriting rewrites the reporting canon, which sec 5 says " +
        "cannot be retrofitted - every record already derived under the old values would disagree " +
        "with new ones. Re-run with --force only if you are certain nothing has been synced yet.",
    );
  }

  await ref.set(parsed);
  console.log("");
  console.log(`WROTE settings/${parsed.accountId}`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
