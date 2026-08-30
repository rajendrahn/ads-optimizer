// The Cloud Tasks controller — §10.2: "A controller creates small retryable jobs rather than
// one `syncEverything()`." This is the enqueue side; `httpHandler.ts` is the receiving side a
// Cloud Tasks HTTP target calls into.
//
// `TaskQueueClient` is the seam (same pattern as the rest of this step): `CloudTasksQueueClient`
// is the real implementation over `@google-cloud/tasks`, `InMemoryTaskQueueClient` is what
// tests (and, later, B2–B8's own tests) use instead. Neither this step nor any of its tests
// create a real Cloud Tasks queue — see the safety constraints in this step's brief;
// `createDefaultTaskQueueClient()` exists for a later step or deploy script to call for real,
// once a queue actually exists to point at.
//
// Idempotency at the queue layer: an explicit Cloud Tasks task *name* (not just an ID field in
// the body) makes Cloud Tasks itself reject a duplicate enqueue of the same logical task within
// its own dedupe window (documented as roughly one hour after the task is completed/deleted).
// That is a second, independent idempotency layer on top of `runSyncTask`'s own — Cloud Tasks
// can prevent the same task from being enqueued twice; `runSyncTask` (taskWrapper.ts) handles
// the case where it's dispatched twice anyway (at-least-once delivery is still Cloud Tasks'
// contract even with a named task).

import { randomUUID } from "node:crypto";
import { CloudTasksClient } from "@google-cloud/tasks";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";

export interface EnqueueInput {
  taskType: string;
  payload: unknown;
  /** Idempotency key. Defaults to a random UUID. Passed through to `runSyncTask` as `taskId`
   * (== the `syncRuns` document id) by whatever calls this queue's HTTP target — see
   * httpHandler.ts. Also becomes the Cloud Tasks task name's final path segment. */
  taskId?: string;
}

export interface EnqueueResult {
  taskId: string;
}

export interface TaskQueueClient {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
}

/** The narrow slice of `@google-cloud/tasks`'s `CloudTasksClient` this module actually calls —
 * a real client satisfies this structurally, no adapter needed at the real call site. */
export interface CloudTasksClientLike {
  queuePath(project: string, location: string, queue: string): string;
  createTask(request: {
    parent: string;
    task: Record<string, unknown>;
  }): Promise<[{ name?: string | null }, ...unknown[]]>;
}

export interface CloudTasksQueueClientOptions {
  client: CloudTasksClientLike;
  project: string;
  location: string;
  queue: string;
  /** The HTTP endpoint Cloud Tasks will POST to — the deployed httpHandler.ts target. */
  targetUrl: string;
  /** Service account Cloud Tasks authenticates as when calling `targetUrl` (OIDC). Omit only
   * for a target that doesn't require authentication (not recommended for anything real). */
  serviceAccountEmail?: string;
}

export class CloudTasksQueueClient implements TaskQueueClient {
  constructor(private readonly opts: CloudTasksQueueClientOptions) {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const taskId = input.taskId ?? randomUUID();
    const parent = this.opts.client.queuePath(
      this.opts.project,
      this.opts.location,
      this.opts.queue,
    );
    const body = Buffer.from(
      JSON.stringify({ taskType: input.taskType, payload: input.payload, taskId }),
    ).toString("base64");

    const task: Record<string, unknown> = {
      name: `${parent}/tasks/${taskId}`,
      httpRequest: {
        httpMethod: "POST",
        url: this.opts.targetUrl,
        headers: { "Content-Type": "application/json" },
        body,
        ...(this.opts.serviceAccountEmail
          ? { oidcToken: { serviceAccountEmail: this.opts.serviceAccountEmail } }
          : {}),
      },
    };

    const [created] = await this.opts.client.createTask({ parent, task });
    const createdId = created.name?.split("/").pop();
    return { taskId: createdId ?? taskId };
  }
}

/** Test-only in-memory queue. `onEnqueue`, if given, lets a test synchronously simulate the
 * dispatch side (e.g. call `handleTaskRequest` immediately) without a real queue in between. */
export function createInMemoryTaskQueueClient(
  onEnqueue?: (input: EnqueueInput & { taskId: string }) => void,
): TaskQueueClient & { readonly enqueued: readonly (EnqueueInput & { taskId: string })[] } {
  const enqueued: (EnqueueInput & { taskId: string })[] = [];
  return {
    enqueued,
    async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
      const taskId = input.taskId ?? randomUUID();
      const recorded = { ...input, taskId };
      enqueued.push(recorded);
      onEnqueue?.(recorded);
      return { taskId };
    },
  };
}

/** Real client, resolved from A0's project id. Requires `location`/`queue`/`targetUrl` (and
 * usually `serviceAccountEmail`) to be supplied by the caller — these are deploy-time facts
 * (the queue's region, its name, the deployed function's URL) this module has no way to know
 * on its own. Not called anywhere in this step's own tests — see module comment. */
export function createDefaultTaskQueueClient(
  opts: Omit<CloudTasksQueueClientOptions, "client" | "project">,
): CloudTasksQueueClient {
  return new CloudTasksQueueClient({
    client: new CloudTasksClient(),
    project: GCP_PROJECT_ID,
    ...opts,
  });
}
