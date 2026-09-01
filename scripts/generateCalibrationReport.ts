// E3 — the operator-facing calibration report/dashboard (IMPLEMENTATION_PLAN.md E3: "A small
// internal dashboard or report — this is for you, not for end users").
//
// Read-only against Firestore: `collectCalibrationInputs` (services/calibration/collect.ts) never
// writes anything, so this is safe to run against a real project as well as the emulator — the
// safety constraint this step was built under ("do NOT write to production Firestore") holds
// structurally, not by discipline. It picks up `FIRESTORE_EMULATOR_HOST` automatically (Admin
// SDK's own behaviour, same as every other script in this repo — see shared/firestore/client.ts).
//
// Run against the emulator (recommended — see IMPLEMENTATION_PLAN.md E3's own notes on why there
// is currently nothing real to read):
//   firebase emulators:exec --only firestore "npx tsx scripts/generateCalibrationReport.ts"
// Run against a real project (also safe — read-only, and as of this step there is nothing there
// yet either):
//   npx tsx scripts/generateCalibrationReport.ts
//
// Not wired into package.json's scripts — this step's safety constraints forbid touching
// package.json/package-lock.json (same precedent as scripts/verify-b8-creative-identity.ts);
// `tsx` is already a devDependency, so this runs directly.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../shared/firestore/client.ts";
import { loadReportingCanon } from "../shared/canon/index.ts";
import {
  collectCalibrationInputs,
  buildCalibrationReport,
  renderCalibrationDashboard,
} from "../services/calibration/index.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = join(REPO_ROOT, "reports");
const HTML_PATH = join(OUTPUT_DIR, "calibration-report.html");
const JSON_PATH = join(OUTPUT_DIR, "calibration-report.json");

/** A2/A3's own settled convention: `loadReportingCanon()` throws loudly if `settings/{accountId}`
 * does not exist yet, rather than silently defaulting (A3's own "Done when" instruction). That is
 * correct for anything computing a real metric — but this script's ONLY use for the timezone is
 * labeling which month a rejection-rate bucket falls in, which is cosmetic, not load-bearing (the
 * Brier score and calibration curve never touch a timezone at all). Falling back to UTC here for
 * that one cosmetic purpose, with a loud console warning, is a deliberate and narrow exception to
 * "never default the canon" — not a silent one. Nothing about the report's own headline numbers
 * depends on this choice.
 */
async function resolveReportingTimezone(): Promise<string> {
  try {
    const canon = await loadReportingCanon();
    return canon.reportingTimezone;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `\n⚠️  Could not load settings/{accountId} (${message}).\n` +
        `   Falling back to UTC for the guardrail-rejection-rate month labels ONLY — this does\n` +
        `   not affect the Brier score or the calibration curve, neither of which reads a\n` +
        `   timezone. Write a real settings/{accountId} document (A3) once this account is live.\n`,
    );
    return "UTC";
  }
}

async function main(): Promise<void> {
  console.log("\nE3 confidence calibration report\n" + "-".repeat(60));

  const db = getDb();
  const reportingTimezone = await resolveReportingTimezone();

  console.log(
    "Reading recommendations, recommendationOutcomes, backtestRuns, guardrailRejections...",
  );
  const inputs = await collectCalibrationInputs(db);
  console.log(
    `  recommendations: ${inputs.recommendations.length}\n` +
      `  recommendationOutcomes: ${inputs.outcomes.length}\n` +
      `  backtestRuns: ${inputs.backtestRuns.length}\n` +
      `  guardrailRejections: ${inputs.guardrailRejections.length}`,
  );

  const report = buildCalibrationReport(inputs, { reportingTimezone });

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(report, null, 2), "utf8");
  await writeFile(HTML_PATH, renderCalibrationDashboard(report), "utf8");

  console.log("-".repeat(60));
  console.log(
    `Live Brier:      n=${report.live.brier.n}  mean=${report.live.brier.meanBrier ?? "—"}`,
  );
  console.log(
    `Backtest Brier:  n=${report.backtest.systemBrier.n}  mean=${report.backtest.systemBrier.meanBrier ?? "—"}`,
  );
  console.log(
    `Combined Brier:  n=${report.combinedBrier.n}  mean=${report.combinedBrier.meanBrier ?? "—"}`,
  );
  console.log(
    `Guardrail rejection rate (overall): ${report.guardrailRejectionRate.overall.rejections}/${report.guardrailRejectionRate.overall.attempts}` +
      (report.guardrailRejectionRate.overall.rate === null
        ? ""
        : ` (${(report.guardrailRejectionRate.overall.rate * 100).toFixed(1)}%)`),
  );
  if (!report.dataProvenance.hasAnyJudgedData) {
    console.log(
      "\n⚠️  hasAnyJudgedData: false — there is no real judged data yet (no live outcome, no\n" +
        "   backtest run). The report above is structurally correct and ready to populate, but\n" +
        "   every number in it is currently vacuous. See IMPLEMENTATION_PLAN.md E3's own notes.",
    );
  }
  console.log(`\nWrote:\n  ${HTML_PATH}\n  ${JSON_PATH}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
