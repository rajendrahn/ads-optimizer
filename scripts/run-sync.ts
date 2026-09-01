// Runs ONE sync task against PRODUCTION Firestore and the live Meta/Shopify APIs.
//
// This calls `handleSyncTaskDispatch` — the exact entry point the deployed Cloud Function
// invokes — so it exercises the real registry, the real task wrapper (idempotency, retry
// classification, syncRuns lifecycle) and the real handlers. The only difference from
// production is the identity: this runs as YOUR gcloud ADC rather than the sync-functions
// service account, so it does not prove that SA's permissions. Use it for the first run
// because the diagnostics are immediate; use the deployed function to validate IAM.
//
// Run:
//   npx tsx scripts/run-sync.ts                          # list task types, write nothing
//   npx tsx scripts/run-sync.ts META_SYNC_ENTITIES       # run one task for real
//   npx tsx scripts/run-sync.ts META_SYNC_INSIGHTS --payload '{"since":"2026-08-24","until":"2026-08-30"}'
//
// WRITES TO PRODUCTION. Every write goes through A2's monotonic version guard, so re-running
// is safe and cannot move a record backwards - but it is real data in a real database.

import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { handleSyncTaskDispatch } from "@services/ingest/sync/runtime.ts";
import { SYNC_TASK_TYPES } from "@services/ingest/sync/taskTypes.ts";
import { GCP_PROJECT_ID, META_AD_ACCOUNT_ID } from "./config.ts";

const args = process.argv.slice(2);
const taskType = args.find((a) => !a.startsWith("--"));

function flagValue(flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1] ?? null;
}

async function main() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: GCP_PROJECT_ID });
  }
  const db = getFirestore();

  if (!taskType) {
    console.log("Usage: npx tsx scripts/run-sync.ts <TASK_TYPE> [--payload '<json>']\n");
    console.log("Registered task types:");
    for (const t of SYNC_TASK_TYPES) console.log(`  ${t}`);
    return;
  }

  if (!SYNC_TASK_TYPES.includes(taskType as (typeof SYNC_TASK_TYPES)[number])) {
    throw new Error(`Unknown task type "${taskType}". Run with no arguments to list them.`);
  }

  // Fail here rather than inside the handler: A3's loader throws on a missing canon, and the
  // resulting error deep in a task is far less obvious than this one.
  const settings = await db.collection("settings").doc(META_AD_ACCOUNT_ID).get();
  if (!settings.exists) {
    throw new Error(
      `settings/${META_AD_ACCOUNT_ID} does not exist. Run scripts/seed-settings.ts --write first ` +
        `- every task fails without the reporting canon (sec 5).`,
    );
  }

  const rawPayload = flagValue("--payload");
  const payload: unknown = rawPayload ? JSON.parse(rawPayload) : {};

  console.log(`project  : ${GCP_PROJECT_ID}  (PRODUCTION)`);
  console.log(`task     : ${taskType}`);
  console.log(`payload  : ${JSON.stringify(payload)}`);
  console.log("");
  console.log("running...");

  const startedAt = Date.now();
  const result = await handleSyncTaskDispatch({ taskType, payload });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("");
  console.log(`HTTP status : ${result.status}`);
  console.log(`runId       : ${result.body.runId}`);
  console.log(`status      : ${result.body.status}`);
  if (result.body.error) console.log(`error       : ${result.body.error}`);
  if (result.body.summary) console.log(`summary     : ${JSON.stringify(result.body.summary)}`);
  console.log(`elapsed     : ${elapsed}s`);

  // The syncRuns document is the durable record; print it so the run can be inspected without
  // a second tool.
  const run = await db.collection("syncRuns").doc(result.body.runId).get();
  if (run.exists) {
    const d = run.data() ?? {};
    console.log("");
    console.log("syncRuns entry:");
    console.log(`  taskType    : ${d.taskType}`);
    console.log(`  status      : ${d.status}`);
    console.log(`  startedAt   : ${d.startedAt?.toDate?.()?.toISOString?.() ?? d.startedAt}`);
    console.log(`  finishedAt  : ${d.finishedAt?.toDate?.()?.toISOString?.() ?? d.finishedAt}`);
    if (d.error) console.log(`  error       : ${JSON.stringify(d.error)}`);
  }

  if (result.body.status !== "SUCCEEDED") {
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
