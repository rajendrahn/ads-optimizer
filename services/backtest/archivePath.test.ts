import { describe, expect, it } from "vitest";
import { buildRawArchivePath } from "@services/ingest/sync/archiver.ts";
import { parseRawArchivePath } from "./archivePath.ts";

describe("parseRawArchivePath — inverse of buildRawArchivePath (§23)", () => {
  it("round-trips every field for a simple resource name", () => {
    // runId shaped like a real Cloud Tasks task id / randomUUID() — hyphens, no underscores (see
    // this module's own limitation note, and the dedicated case below that proves why).
    const path = buildRawArchivePath(
      { source: "meta", day: "2026-08-30", resource: "insights", runId: "run-abc123" },
      2,
    );
    expect(parseRawArchivePath(path)).toEqual({
      source: "meta",
      day: "2026-08-30",
      resource: "insights",
      runId: "run-abc123",
      seq: 2,
    });
  });

  it("round-trips a resource name that itself contains underscores", () => {
    const path = buildRawArchivePath({
      source: "meta",
      day: "2026-01-05",
      resource: "insights_page",
      runId: "run-xyz",
    });
    expect(parseRawArchivePath(path)).toEqual({
      source: "meta",
      day: "2026-01-05",
      resource: "insights_page",
      runId: "run-xyz",
      seq: 0,
    });
  });

  it(
    "documents the known limitation: a runId containing an underscore does NOT round-trip " +
      "cleanly (the underscore boundary between resource and runId is genuinely ambiguous) — " +
      "every real runId in this codebase is a Cloud Tasks task id / randomUUID()-shaped string " +
      "with no underscores, so this is a stated, accepted limitation, not a silent bug",
    () => {
      const path = buildRawArchivePath({
        source: "meta",
        day: "2026-01-05",
        resource: "insights",
        runId: "run_with_underscores",
      });
      const parsed = parseRawArchivePath(path);
      // The greedy match absorbs the underscored runId into "resource" instead — proving the
      // documented ambiguity is real, not hypothetical, rather than asserting it only in prose.
      expect(parsed?.runId).not.toBe("run_with_underscores");
    },
  );

  it("round-trips the shopify CSV import resource", () => {
    const path = buildRawArchivePath({
      source: "shopify",
      day: "2026-03-14",
      resource: "orders_csv_import",
      runId: "task-42",
    });
    expect(parseRawArchivePath(path)).toEqual({
      source: "shopify",
      day: "2026-03-14",
      resource: "orders_csv_import",
      runId: "task-42",
      seq: 0,
    });
  });

  it("returns null for a name that doesn't match the §23 convention", () => {
    expect(parseRawArchivePath("something-else.json")).toBeNull();
    expect(parseRawArchivePath("raw/meta/2026/08/30/insights_run_0")).toBeNull(); // no .json
    expect(parseRawArchivePath("raw/other/2026/08/30/insights_run_0.json")).toBeNull(); // bad source
  });
});
