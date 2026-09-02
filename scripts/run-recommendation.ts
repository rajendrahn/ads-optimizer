// Requests ONE recommendation against PRODUCTION, end to end: D2 packet -> D3 reasoner (a real
// Claude Fable 5 call) -> D5 guardrails -> the terminal write on recommendations/{id}.
//
// Why this is separate from scripts/run-sync.ts: D4 deliberately keeps GENERATE_RECOMMENDATION
// OUT of the shared Cloud Functions registry that run-sync dispatches through, because a Fable
// turn can exceed the 60s ceiling sec 16.1 describes. It has its own worker registry, bound for a
// separate Cloud Run service. This script drives that worker's own entry point
// (`handleReasonerTaskDispatch`), so it exercises the same code path the deployed worker runs.
//
// COSTS MONEY: makes a real Anthropic API call. One per invocation.
//
// Run:
//   npx tsx scripts/run-recommendation.ts ADSET 120239462136610171
//   npx tsx scripts/run-recommendation.ts AD 123456789

import { randomUUID } from "node:crypto";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { handleReasonerTaskDispatch } from "@services/reasoner/job/workerRuntime.ts";
import { requestRecommendation } from "@services/reasoner/job/request.ts";
import { createInMemoryTaskQueueClient } from "@services/ingest/sync/taskQueue.ts";
import { GENERATE_RECOMMENDATION } from "@services/ingest/sync/taskTypes.ts";
import { GCP_PROJECT_ID } from "./config.ts";

const [rawType, entityId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

async function main() {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: GCP_PROJECT_ID });
  }
  const db = getFirestore();

  if (!rawType || !entityId) {
    console.log("Usage: npx tsx scripts/run-recommendation.ts <AD|ADSET|CAMPAIGN> <entityId>");
    return;
  }
  const type = rawType.toUpperCase();
  if (!["AD", "ADSET", "CAMPAIGN"].includes(type)) {
    throw new Error(`entity type must be AD, ADSET or CAMPAIGN (got "${rawType}")`);
  }

  const recommendationId = randomUUID();
  console.log(`project          : ${GCP_PROJECT_ID}  (PRODUCTION)`);
  console.log(`namedEntity      : ${type} ${entityId}`);
  console.log(`recommendationId : ${recommendationId}`);

  // D4's contract: the API writes recommendations/{id} as PENDING and THEN enqueues, so the
  // worker never invents a document it was not asked for. Reproduce both halves here - the
  // real `requestRecommendation` for the PENDING write, with an in-memory queue standing in
  // for Cloud Tasks since this process dispatches the work itself a moment later.
  await requestRecommendation({
    db,
    recommendationId,
    namedEntity: { type: type as "AD" | "ADSET" | "CAMPAIGN", id: entityId },
    queue: createInMemoryTaskQueueClient(),
  });
  console.log("PENDING document written; dispatching worker...");
  console.log("");
  console.log("running (this makes a real Claude call)...");

  const startedAt = Date.now();
  const result = await handleReasonerTaskDispatch({
    taskType: GENERATE_RECOMMENDATION,
    payload: { recommendationId, namedEntity: { type, id: entityId } },
    taskId: recommendationId,
  });
  console.log("");
  console.log(`HTTP status : ${result.status}`);
  console.log(`status      : ${result.body.status}`);
  if (result.body.error) console.log(`error       : ${result.body.error}`);
  console.log(`elapsed     : ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const doc = await db.collection("recommendations").doc(recommendationId).get();
  if (!doc.exists) {
    console.log("\nNo recommendations/{id} document was written.");
    process.exitCode = 1;
    return;
  }
  const r = doc.data() ?? {};
  console.log("");
  console.log("=== recommendation ===");
  console.log(`status            : ${r.status}`);
  if (r.errorMessage) console.log(`errorMessage      : ${r.errorMessage}`);
  if (r.guardrailRejection) {
    console.log(`guardrailRejection: ${JSON.stringify(r.guardrailRejection)}`);
  }
  console.log(`decisionUnit      : ${JSON.stringify(r.decisionUnit)}`);
  console.log(`recommendation    : ${r.recommendation}`);
  console.log(`changePercent     : ${r.changePercent}`);
  console.log(`confidence        : ${r.confidence}`);
  if (r.currentBudgetMinorUnits != null) {
    console.log(`current budget    : INR ${(r.currentBudgetMinorUnits / 100).toFixed(2)}`);
  }
  if (r.recommendedBudgetMinorUnits != null) {
    console.log(`recommended budget: INR ${(r.recommendedBudgetMinorUnits / 100).toFixed(2)}`);
  }
  console.log("");
  console.log(`summary: ${r.summary ?? "-"}`);
  for (const [label, list] of [
    ["primaryReasons", r.primaryReasons],
    ["risks", r.risks],
    ["doNotDo", r.doNotDo],
  ] as const) {
    if (Array.isArray(list) && list.length > 0) {
      console.log(`\n${label}:`);
      for (const item of list) console.log(`  - ${item}`);
    }
  }
  if (r.recheckConditions) {
    console.log(`\nrecheckConditions: ${JSON.stringify(r.recheckConditions)}`);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
