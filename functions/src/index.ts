// B1 — the Cloud Tasks HTTP target. This is deliberately the entire runtime footprint of
// `functions/`: parse the request body, hand it to the bundled sync framework, write the
// response. See functions/src/generated/syncBundle.d.ts for why this is a bundled import
// rather than a direct one, and services/ingest/sync/httpHandler.ts for the retry-semantics
// reasoning behind the status codes this function ends up returning (they come straight
// through from `handleSyncTaskDispatch`, untouched).
//
// B2–B8 do not need to touch this file to add real task handlers — those register into
// services/ingest/sync/registry.ts's default registry, which this already dispatches through.
// This file only changes if the framework itself needs a second entrypoint (e.g. a dedicated
// enqueue/controller endpoint, or per-task-type Cloud Tasks queues instead of one shared one).

import { onRequest } from "firebase-functions/v2/https";
import { handleSyncTaskDispatch, type TaskDispatchRequestBody } from "./generated/syncBundle";

export const syncTaskDispatch = onRequest(async (req, res) => {
  const body = req.body as Partial<TaskDispatchRequestBody> | undefined;
  const result = await handleSyncTaskDispatch({
    taskType: body?.taskType ?? "",
    payload: body?.payload,
    taskId: body?.taskId,
  });
  res.status(result.status).json(result.body);
});
