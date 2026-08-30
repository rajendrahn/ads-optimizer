// The Cloud Tasks HTTP target — the receiving half of §10.2's controller. `taskQueue.ts`
// enqueues; this is what the enqueued task's `httpRequest.url` points at.
//
// Deliberately framework-agnostic: `handleTaskRequest` takes a plain parsed JSON body and
// returns a plain `{status, body}` pair, with no dependency on Express/`onRequest`/Cloud
// Functions' request-response types at all. That is what makes retry semantics fully unit-
// testable without a Functions emulator or a live Cloud Tasks queue — see this step's brief
// ("interfaces thin enough to fake in tests"). `functions/src/index.ts` wraps this in ~5 lines
// of `onRequest` glue; nothing about *how* a task runs, retries, or gets recorded lives there.
//
// HTTP status mapping to Cloud Tasks retry semantics: Cloud Tasks treats any non-2xx response
// from an HTTP target as "retry" and any 2xx as "done" — it does not itself distinguish a 4xx
// from a 5xx the way some other queues do. That means the *only* way to tell Cloud Tasks "this
// failed and retrying will not help" is to return 2xx anyway. So: a retryable failure gets 500
// (Cloud Tasks retries per the queue's own backoff/max-attempts config); a terminal failure
// (including "unknown task type") gets 200, with the failure fully visible in the response body
// and in `syncRuns` — Cloud Tasks stops, and observability comes from `syncRuns`, not from the
// HTTP status of a task nobody will look at again.

import { runSyncTask, type RunSyncTaskOptions } from "./taskWrapper.ts";

export interface TaskDispatchRequestBody {
  taskType: string;
  payload: unknown;
  /** Cloud Tasks' own task id, threaded through as `runSyncTask`'s idempotency key — see
   * taskQueue.ts's module comment on the two independent idempotency layers. */
  taskId?: string;
}

export interface TaskDispatchResponseBody {
  runId: string;
  status: string;
  error?: string;
  summary?: Record<string, unknown>;
}

export interface TaskDispatchResponse {
  status: number;
  body: TaskDispatchResponseBody;
}

export type HandleTaskRequestDeps = Omit<RunSyncTaskOptions, "taskType" | "payload" | "taskId">;

export async function handleTaskRequest(
  request: TaskDispatchRequestBody,
  deps: HandleTaskRequestDeps,
): Promise<TaskDispatchResponse> {
  if (!request || typeof request.taskType !== "string" || request.taskType.length === 0) {
    return {
      status: 200, // malformed request — retrying an unparseable body will never help.
      body: { runId: "", status: "FAILED", error: "handleTaskRequest: missing/invalid taskType" },
    };
  }

  const result = await runSyncTask({
    ...deps,
    taskType: request.taskType,
    payload: request.payload,
    taskId: request.taskId,
  });

  return {
    status: result.shouldRetry ? 500 : 200,
    body: {
      runId: result.runId,
      status: result.status,
      error: result.error,
      summary: result.summary,
    },
  };
}
