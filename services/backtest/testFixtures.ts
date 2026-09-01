// Shared, non-test fixtures for this directory's own test files — an in-memory bucket
// satisfying both archiver.ts's `StorageBucketLike` (so the REAL `GcsRawArchiveStore` is under
// test, matching archiver.test.ts's own precedent) and this directory's own `ArchiveListable`,
// plus a hand-rolled `SyncRunSource`. Not a *.test.ts file itself — nothing here is a test.

import type { StorageBucketLike, StorageFileLike } from "@services/ingest/sync/archiver.ts";
import type { ArchiveListable, SyncRunKnowledge, SyncRunSource } from "./pointInTimeArchive.ts";

export function createFakeArchiveBucket(): StorageBucketLike &
  ArchiveListable & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    file(name: string): StorageFileLike {
      return {
        async save(data) {
          files.set(name, data);
        },
        async download() {
          const data = files.get(name);
          if (!data) throw new Error(`fake bucket: no object at "${name}"`);
          return [data];
        },
      };
    },
    async listObjectNames(prefix: string): Promise<string[]> {
      return [...files.keys()].filter((name) => name.startsWith(prefix));
    },
  };
}

export function createFakeSyncRunSource(runs: readonly SyncRunKnowledge[]): SyncRunSource {
  return {
    async listAllSyncRuns(): Promise<SyncRunKnowledge[]> {
      return [...runs];
    },
  };
}
