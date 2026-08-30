import { describe, expect, it } from "vitest";
import {
  buildRawArchivePath,
  GcsRawArchiveStore,
  type StorageBucketLike,
  type StorageFileLike,
} from "./archiver.ts";

/** An in-memory stand-in for `@google-cloud/storage`'s `Bucket` — implements exactly the
 * `StorageBucketLike` surface `GcsRawArchiveStore` calls, so the real class is under test. */
function createFakeBucket(): StorageBucketLike & { files: Map<string, Buffer> } {
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
  };
}

describe("buildRawArchivePath — §23", () => {
  it("builds the date-partitioned path with no leading slash", () => {
    const path = buildRawArchivePath({
      source: "meta",
      day: "2026-08-30",
      resource: "insights",
      runId: "run_abc",
    });
    expect(path).toBe("raw/meta/2026/08/30/insights_run_abc_0.json");
  });

  it("uses the seq argument to disambiguate multiple payloads", () => {
    const path = buildRawArchivePath(
      { source: "shopify", day: "2026-01-05", resource: "orders", runId: "run_xyz" },
      3,
    );
    expect(path).toBe("raw/shopify/2026/01/05/orders_run_xyz_3.json");
  });

  it("throws on a malformed day", () => {
    expect(() =>
      buildRawArchivePath({
        source: "meta",
        day: "2026/08/30",
        resource: "insights",
        runId: "run_abc",
      }),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("GcsRawArchiveStore — round-trips a payload through a fake bucket", () => {
  it("archives a payload and reads it back byte-for-byte equal (parsed)", async () => {
    const bucket = createFakeBucket();
    const store = new GcsRawArchiveStore(bucket);
    const payload = { campaigns: [{ id: "1", name: "Test" }], fetchedAt: "2026-08-30T00:00:00Z" };

    const { path } = await store.archive({
      source: "meta",
      day: "2026-08-30",
      resource: "campaigns",
      runId: "run_1",
      payload,
    });

    expect(path).toBe("raw/meta/2026/08/30/campaigns_run_1_0.json");
    const readBack = await store.read(path);
    expect(readBack).toEqual(payload);
  });

  it("auto-increments seq across repeated archive() calls for the same run/resource/day", async () => {
    const bucket = createFakeBucket();
    const store = new GcsRawArchiveStore(bucket);

    const first = await store.archive({
      source: "meta",
      day: "2026-08-30",
      resource: "insights",
      runId: "run_page",
      payload: { page: 1 },
    });
    const second = await store.archive({
      source: "meta",
      day: "2026-08-30",
      resource: "insights",
      runId: "run_page",
      payload: { page: 2 },
    });

    expect(first.path).toBe("raw/meta/2026/08/30/insights_run_page_0.json");
    expect(second.path).toBe("raw/meta/2026/08/30/insights_run_page_1.json");
    await expect(store.read(first.path)).resolves.toEqual({ page: 1 });
    await expect(store.read(second.path)).resolves.toEqual({ page: 2 });
  });

  it("does not collide across different runs", async () => {
    const bucket = createFakeBucket();
    const store = new GcsRawArchiveStore(bucket);

    const a = await store.archive({
      source: "shopify",
      day: "2026-08-30",
      resource: "orders",
      runId: "run_a",
      payload: { who: "a" },
    });
    const b = await store.archive({
      source: "shopify",
      day: "2026-08-30",
      resource: "orders",
      runId: "run_b",
      payload: { who: "b" },
    });

    expect(a.path).not.toBe(b.path);
    await expect(store.read(a.path)).resolves.toEqual({ who: "a" });
    await expect(store.read(b.path)).resolves.toEqual({ who: "b" });
  });

  it("rejects reading a path that was never archived", async () => {
    const store = new GcsRawArchiveStore(createFakeBucket());
    await expect(store.read("raw/meta/2026/08/30/missing_run_0.json")).rejects.toThrow();
  });
});
