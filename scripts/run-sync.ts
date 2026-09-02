// Runs ONE sync task against PRODUCTION Firestore and the live Meta/Shopify APIs.
//
// This calls `handleSyncTaskDispatch` — the exact entry point the deployed Cloud Function
// invokes — so it exercises the real registry, the real task wrapper (idempotency, retry
// classification, syncRuns lifecycle) and the real handlers. The only difference from
// production is the identity: this runs as YOUR gcloud ADC rather than the sync-functions
// service account, so it does not prove that SA's permissions. Use it for the first run
// because the diagnostics are immediate; use the deployed function to validate IAM.
//
// RETRIES AUTOMATICALLY. A retryable failure (rate limit, transient 5xx) is retried with
// exponential backoff and jitter until it succeeds, the attempt budget runs out, or the wall-
// clock budget does - so a Meta throttle no longer needs a human to come back in an hour and
// re-run. A TERMINAL failure (bad token, malformed payload) stops immediately: retrying it
// cannot help and would spend the rate-limit budget the retryable case needs.
//
// Run:
//   npx tsx scripts/run-sync.ts                          # list task types, write nothing
//   npx tsx scripts/run-sync.ts META_SYNC_ENTITIES       # run, auto-retrying on throttle
//   npx tsx scripts/run-sync.ts META_SYNC_ENTITIES --max-attempts 20 --max-hours 12
//   npx tsx scripts/run-sync.ts META_SYNC_ENTITIES --no-retry
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

  const maxAttempts = Number(flagValue("--max-attempts") ?? 12);
  const maxHours = Number(flagValue("--max-hours") ?? 6);
  const noRetry = args.includes("--no-retry");

  console.log(`project     : ${GCP_PROJECT_ID}  (PRODUCTION)`);
  console.log(`task        : ${taskType}`);
  console.log(`payload     : ${JSON.stringify(payload)}`);
  console.log(
    `retry       : ${noRetry ? "disabled" : `up to ${maxAttempts} attempts / ${maxHours}h`}`,
  );

  const deadline = Date.now() + maxHours * 3_600_000;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    console.log("");
    console.log(`--- attempt ${attempt}${noRetry ? "" : ` of ${maxAttempts}`} ---`);

    const startedAt = Date.now();
    const result = await handleSyncTaskDispatch({ taskType, payload });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log(`HTTP status : ${result.status}`);
    console.log(`runId       : ${result.body.runId}`);
    console.log(`status      : ${result.body.status}`);
    if (result.body.error) console.log(`error       : ${result.body.error}`);
    if (result.body.summary) console.log(`summary     : ${JSON.stringify(result.body.summary)}`);
    console.log(`elapsed     : ${elapsed}s`);

    // The syncRuns document is the durable record; print it so a run can be inspected without
    // reaching for a second tool.
    const run = await db.collection("syncRuns").doc(result.body.runId).get();
    if (run.exists) {
      const d = run.data() ?? {};
      console.log(
        `syncRuns    : ${d.status} (${d.startedAt?.toDate?.()?.toISOString?.() ?? d.startedAt})`,
      );
    }

    if (result.body.status === "SUCCEEDED") {
      console.log("");
      console.log(`SUCCEEDED after ${attempt} attempt(s).`);
      return;
    }

    // B1's own convention, reused rather than re-derived: httpHandler.ts maps a RETRYABLE
    // failure to HTTP 500 (so Cloud Tasks redelivers) and a TERMINAL one to HTTP 200 carrying
    // the real outcome, because Cloud Tasks has no "terminal, do not retry" status. Retrying a
    // terminal failure - a bad token, a malformed payload - just burns the rate-limit budget
    // that the retryable case actually needs.
    const isRetryable = result.status >= 500;
    if (!isRetryable) {
      console.log("");
      console.log("TERMINAL failure - not retrying. This will not fix itself on a retry;");
      console.log("read the error above (auth, payload or a genuine bug).");
      process.exitCode = 1;
      return;
    }

    if (noRetry) {
      console.log("");
      console.log("Retryable failure, but --no-retry was passed.");
      process.exitCode = 1;
      return;
    }
    if (attempt >= maxAttempts) {
      console.log("");
      console.log(`Giving up after ${attempt} attempts. Progress made so far is persisted;`);
      console.log("re-run to continue from where it stopped.");
      process.exitCode = 1;
      return;
    }

    // Backoff. A Meta ad-account throttle is measured in tens of minutes, not seconds, so a
    // rate-limit failure starts far higher than a transient one - retrying a throttle every few
    // seconds just consumes budget and extends the lockout. Jitter avoids lock-stepping with
    // any other client on the same account.
    const looksRateLimited = /rate limit|too many calls|80\d{3}/i.test(result.body.error ?? "");
    const baseMs = looksRateLimited ? 5 * 60_000 : 30_000;
    const capMs = 30 * 60_000;
    const backoffMs = Math.min(baseMs * Math.pow(2, attempt - 1), capMs);
    const jittered = Math.round(backoffMs * (0.8 + Math.random() * 0.4));

    if (Date.now() + jittered > deadline) {
      console.log("");
      console.log(`Next wait would exceed the ${maxHours}h budget. Stopping.`);
      console.log("Progress made so far is persisted; re-run to continue.");
      process.exitCode = 1;
      return;
    }

    const mins = (jittered / 60_000).toFixed(1);
    const at = new Date(Date.now() + jittered).toLocaleTimeString();
    console.log("");
    console.log(
      `Retryable${looksRateLimited ? " (rate limit)" : ""}. Waiting ${mins} min, next attempt at ${at}. Ctrl+C to stop.`,
    );
    await new Promise((resolve) => setTimeout(resolve, jittered));
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
