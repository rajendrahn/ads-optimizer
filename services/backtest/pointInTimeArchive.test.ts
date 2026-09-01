import { describe, expect, it } from "vitest";
import { GcsRawArchiveStore } from "@services/ingest/sync/archiver.ts";
import {
  PointInTimeArchiveReader,
  type PointInTimeArchiveReaderDeps,
} from "./pointInTimeArchive.ts";
import { createFakeArchiveBucket, createFakeSyncRunSource } from "./testFixtures.ts";

const T = new Date("2026-02-01T00:00:00Z");

describe("PointInTimeArchiveReader — structural point-in-time boundary", () => {
  it("cannot be constructed without asOfInstant — a compile-time guarantee, not a runtime check", () => {
    // @ts-expect-error — asOfInstant is required; this must fail `tsc`, not just fail at runtime.
    // Removing this comment and running `npm run typecheck` reproduces the real compile error
    // (matches services/reasoner/guardrails.test.ts's own precedent for proving a structural
    // guarantee this way).
    const deps: PointInTimeArchiveReaderDeps = {
      archive: createFakeArchiveBucket() as never,
      listable: createFakeArchiveBucket(),
      syncRuns: createFakeSyncRunSource([]),
    };
    expect(deps).toBeDefined();
  });

  it("includes a payload whose producing run succeeded strictly before T", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-01-28",
      resource: "insights_page",
      runId: "run-early",
      payload: { data: [{ ad_id: "1" }] },
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-early", status: "SUCCEEDED", finishedAt: new Date("2026-01-29T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: T,
      archive,
      listable: bucket,
      syncRuns,
    });
    const records = await reader.readArchivedPayloads("meta", "insights_page");
    expect(records).toHaveLength(1);
    expect(records[0].runId).toBe("run-early");
  });

  it("excludes a payload whose producing run finished strictly AFTER T", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-01-30",
      resource: "insights_page",
      runId: "run-late",
      payload: { data: [{ ad_id: "1" }] },
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-late", status: "SUCCEEDED", finishedAt: new Date("2026-02-15T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: T,
      archive,
      listable: bucket,
      syncRuns,
    });
    const records = await reader.readArchivedPayloads("meta", "insights_page");
    expect(records).toHaveLength(0);
  });

  it(
    "THE LEAKAGE CASE: a payload ABOUT a day well before T, but archived by a run that only " +
      "finished AFTER T, is excluded — proves the filter is run-completion time, not the " +
      "payload's own day. Filtering on day<=T alone (the naive, wrong implementation) would " +
      "let this through, since 2026-01-05 <= T=2026-02-01.",
    async () => {
      const bucket = createFakeArchiveBucket();
      const archive = new GcsRawArchiveStore(bucket);
      // Simulates a late reconciliation/backfill run: the archived payload's own `day` (what B3's
      // pollAsyncReport.ts stamps it with) is an OLD day, but this specific run that produced it
      // did not finish until well after T.
      await archive.archive({
        source: "meta",
        day: "2026-01-05", // <= T — a naive day-only filter would wrongly admit this
        resource: "insights_page",
        runId: "run-late-reconciliation",
        payload: { data: [{ ad_id: "999", date_start: "2026-01-05", spend: "999999" }] },
      });
      const syncRuns = createFakeSyncRunSource([
        {
          runId: "run-late-reconciliation",
          status: "SUCCEEDED",
          finishedAt: new Date("2026-03-01T00:00:00Z"), // finished AFTER T
        },
      ]);
      const reader = await PointInTimeArchiveReader.create({
        asOfInstant: T,
        archive,
        listable: bucket,
        syncRuns,
      });
      const records = await reader.readArchivedPayloads("meta", "insights_page");
      expect(records).toHaveLength(0);

      // Sanity: the SAME payload IS visible once T moves past the run's own completion — proving
      // this is genuinely about knowledge-at-T, not a bug that hides everything.
      const laterReader = await PointInTimeArchiveReader.create({
        asOfInstant: new Date("2026-03-02T00:00:00Z"),
        archive,
        listable: bucket,
        syncRuns,
      });
      const laterRecords = await laterReader.readArchivedPayloads("meta", "insights_page");
      expect(laterRecords).toHaveLength(1);
    },
  );

  it("excludes a payload from a run that never succeeded (FAILED or still RUNNING)", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-01-20",
      resource: "insights_page",
      runId: "run-failed",
      payload: { data: [] },
    });
    await archive.archive({
      source: "meta",
      day: "2026-01-20",
      resource: "insights_page",
      runId: "run-running",
      payload: { data: [] },
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-failed", status: "FAILED", finishedAt: new Date("2026-01-21T00:00:00Z") },
      { runId: "run-running", status: "RUNNING", finishedAt: null },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: T,
      archive,
      listable: bucket,
      syncRuns,
    });
    const records = await reader.readArchivedPayloads("meta", "insights_page");
    expect(records).toHaveLength(0);
  });

  it("filters by resource when supplied, and by source always", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-01-20",
      resource: "insights_page",
      runId: "run1",
      payload: "insights",
    });
    await archive.archive({
      source: "meta",
      day: "2026-01-20",
      resource: "campaigns",
      runId: "run1",
      payload: "campaigns",
    });
    await archive.archive({
      source: "shopify",
      day: "2026-01-20",
      resource: "orders_csv_import",
      runId: "run1",
      payload: "orders",
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run1", status: "SUCCEEDED", finishedAt: new Date("2026-01-21T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: T,
      archive,
      listable: bucket,
      syncRuns,
    });
    expect(await reader.readArchivedPayloads("meta", "insights_page")).toHaveLength(1);
    expect(await reader.readArchivedPayloads("meta")).toHaveLength(2);
    expect(await reader.readArchivedPayloads("shopify", "orders_csv_import")).toHaveLength(1);
  });

  it("runFinishedAt returns the run's own finishedAt for an allowed run, undefined otherwise", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-ok", status: "SUCCEEDED", finishedAt: new Date("2026-01-15T00:00:00Z") },
      { runId: "run-excluded", status: "FAILED", finishedAt: new Date("2026-01-15T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: T,
      archive,
      listable: bucket,
      syncRuns,
    });
    expect(reader.runFinishedAt("run-ok")).toEqual(new Date("2026-01-15T00:00:00Z"));
    expect(reader.runFinishedAt("run-excluded")).toBeUndefined();
    expect(reader.runFinishedAt("run-unknown")).toBeUndefined();
  });
});
