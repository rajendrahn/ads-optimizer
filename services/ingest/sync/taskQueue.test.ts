import { describe, expect, it, vi } from "vitest";
import {
  CloudTasksQueueClient,
  createInMemoryTaskQueueClient,
  type CloudTasksClientLike,
} from "./taskQueue.ts";

describe("CloudTasksQueueClient — real class, fake Cloud Tasks client", () => {
  function createFakeCloudTasksClient(): CloudTasksClientLike & {
    created: { parent: string; task: Record<string, unknown> }[];
  } {
    const created: { parent: string; task: Record<string, unknown> }[] = [];
    return {
      created,
      queuePath: (project, location, queue) =>
        `projects/${project}/locations/${location}/queues/${queue}`,
      async createTask(request) {
        created.push(request as { parent: string; task: Record<string, unknown> });
        return [{ name: `${request.parent}/tasks/created-id` }];
      },
    };
  }

  it("builds the task with a deterministic name from taskId and base64-encodes the body", async () => {
    const fake = createFakeCloudTasksClient();
    const client = new CloudTasksQueueClient({
      client: fake,
      project: "proj",
      location: "asia-south1",
      queue: "sync-tasks",
      targetUrl: "https://example.com/dispatch",
      serviceAccountEmail: "sync-functions@proj.iam.gserviceaccount.com",
    });

    const result = await client.enqueue({
      taskType: "SYNC_NOOP",
      payload: { hello: "world" },
      taskId: "fixed-id",
    });

    expect(fake.created).toHaveLength(1);
    const { parent, task } = fake.created[0];
    expect(parent).toBe("projects/proj/locations/asia-south1/queues/sync-tasks");
    expect(task.name).toBe(`${parent}/tasks/fixed-id`);
    const httpRequest = task.httpRequest as Record<string, unknown>;
    expect(httpRequest.url).toBe("https://example.com/dispatch");
    expect(httpRequest.oidcToken).toEqual({
      serviceAccountEmail: "sync-functions@proj.iam.gserviceaccount.com",
    });
    const decoded = JSON.parse(Buffer.from(httpRequest.body as string, "base64").toString("utf8"));
    expect(decoded).toEqual({
      taskType: "SYNC_NOOP",
      payload: { hello: "world" },
      taskId: "fixed-id",
    });
    // Returned id comes from the server-assigned task name's last segment.
    expect(result.taskId).toBe("created-id");
  });

  it("generates a taskId when none is given", async () => {
    const fake = createFakeCloudTasksClient();
    const client = new CloudTasksQueueClient({
      client: fake,
      project: "proj",
      location: "asia-south1",
      queue: "sync-tasks",
      targetUrl: "https://example.com/dispatch",
    });
    await client.enqueue({ taskType: "SYNC_NOOP", payload: {} });
    expect(fake.created[0].task.name).toMatch(/\/tasks\/[0-9a-f-]{36}$/);
  });

  it("omits oidcToken when no serviceAccountEmail is configured", async () => {
    const fake = createFakeCloudTasksClient();
    const client = new CloudTasksQueueClient({
      client: fake,
      project: "proj",
      location: "asia-south1",
      queue: "sync-tasks",
      targetUrl: "https://example.com/dispatch",
    });
    await client.enqueue({ taskType: "SYNC_NOOP", payload: {}, taskId: "x" });
    const httpRequest = fake.created[0].task.httpRequest as Record<string, unknown>;
    expect(httpRequest.oidcToken).toBeUndefined();
  });
});

describe("createInMemoryTaskQueueClient", () => {
  it("records enqueued tasks and assigns a taskId when missing", async () => {
    const queue = createInMemoryTaskQueueClient();
    const result = await queue.enqueue({ taskType: "SYNC_NOOP", payload: { a: 1 } });
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].taskId).toBe(result.taskId);
    expect(queue.enqueued[0].payload).toEqual({ a: 1 });
  });

  it("calls onEnqueue synchronously, letting a test simulate immediate dispatch", async () => {
    const onEnqueue = vi.fn();
    const queue = createInMemoryTaskQueueClient(onEnqueue);
    await queue.enqueue({ taskType: "SYNC_NOOP", payload: {}, taskId: "abc" });
    expect(onEnqueue).toHaveBeenCalledWith({ taskType: "SYNC_NOOP", payload: {}, taskId: "abc" });
  });
});
