import { describe, expect, it } from "vitest";
import { GcsMatrixifyCsvSource, type CsvStorageBucketLike } from "./csvSource.ts";

function fakeBucket(files: Record<string, string>): CsvStorageBucketLike {
  return {
    file(name: string) {
      return {
        async download(): Promise<[Buffer]> {
          const content = files[name];
          if (content === undefined) throw new Error(`no such object: ${name}`);
          return [Buffer.from(content, "utf8")];
        },
      };
    },
  };
}

describe("GcsMatrixifyCsvSource", () => {
  it("reads the named object as UTF-8 text", async () => {
    const source = new GcsMatrixifyCsvSource(
      fakeBucket({ "shopify-orders-backfill.csv": "ID,Name\n1,#1\n" }),
    );
    const text = await source.read("shopify-orders-backfill.csv");
    expect(text).toBe("ID,Name\n1,#1\n");
  });

  it("propagates a download failure for a missing object", async () => {
    const source = new GcsMatrixifyCsvSource(fakeBucket({}));
    await expect(source.read("missing.csv")).rejects.toThrow(/no such object/);
  });

  it("reads a different object key when a later export uses one", async () => {
    const source = new GcsMatrixifyCsvSource(
      fakeBucket({
        "shopify-orders-backfill.csv": "old",
        "shopify-orders-backfill-2.csv": "new",
      }),
    );
    expect(await source.read("shopify-orders-backfill-2.csv")).toBe("new");
  });
});
