// Barrel for the sync framework (B1). This file is also the esbuild entry point
// functions/scripts/bundle.mjs bundles into functions/lib/generated/syncBundle.js — see that
// script's comment and functions/src/generated/syncBundle.d.ts for the module-system decision
// this implements (IMPLEMENTATION_PLAN.md B1: `functions/` cannot import `/shared` or
// `/services` directly). Keep this barrel's exported surface and that `.d.ts` in sync by hand;
// nothing enforces the two match automatically.

export { SYNC_TASK_TYPES, SYNC_NOOP, type KnownTaskType } from "./taskTypes.ts";
export {
  computeReconciliationWindow,
  type ComputeReconciliationWindowInput,
  type ReconciliationWindow,
  type ReconciliationWindowKind,
} from "./reconciliationWindow.ts";
export { createFirestoreSyncStore, createInMemorySyncStore, type SyncStore } from "./store.ts";
export {
  buildRawArchivePath,
  GcsRawArchiveStore,
  createDefaultRawArchiveStore,
  type ArchivePayloadInput,
  type RawArchiveStore,
  type StorageBucketLike,
  type StorageFileLike,
} from "./archiver.ts";
export {
  CloudTasksQueueClient,
  createDefaultTaskQueueClient,
  createInMemoryTaskQueueClient,
  type TaskQueueClient,
  type EnqueueInput,
  type EnqueueResult,
  type CloudTasksClientLike,
} from "./taskQueue.ts";
export {
  createTaskRegistry,
  createDefaultRegistry,
  type TaskRegistry,
  type TaskRegistration,
  type SyncStateTarget,
} from "./registry.ts";
export {
  runSyncTask,
  type TaskContext,
  type TaskHandler,
  type TaskHandlerResult,
  type RunSyncTaskOptions,
  type RunSyncTaskResult,
  type RunSyncTaskStatus,
} from "./taskWrapper.ts";
export {
  handleTaskRequest,
  type TaskDispatchRequestBody,
  type TaskDispatchResponse,
  type TaskDispatchResponseBody,
  type HandleTaskRequestDeps,
} from "./httpHandler.ts";
export { handleSyncTaskDispatch } from "./runtime.ts";
