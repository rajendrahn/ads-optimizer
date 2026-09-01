// The structural point-in-time boundary E1's spec calls for: "make the point-in-time constraint
// structural (filter at the archive read boundary), not a convention that later code can
// forget." Modelled directly on C2's `GapAware<T>` precedent (services/analytics/features/
// gapAware.ts) — that type made the unsafe thing fail to typecheck; this class makes the unsafe
// READ impossible to construct in the first place.
//
// ============================================================================================
// THE SUBTLE PART — read this before touching the filter condition below.
// ============================================================================================
// §23's archive path (services/ingest/sync/archiver.ts) partitions by the reporting day a
// payload is ABOUT, not the day it was fetched: "a backfill task archives payloads under the day
// the data is about, so replay lines up with §23's date-partitioned tree regardless of when the
// fetch actually ran." That is exactly right for browsing/replay, and exactly WRONG as a leakage
// filter on its own: a Shopify order for 2026-01-05 that only becomes visible to this system
// after a LATE reconciliation sync completes on 2026-03-01 is still archived under
// raw/shopify/2026/01/05/... — filtering "day <= T" for a backtest at T = 2026-02-01 would let
// that late-arriving fact straight through, even though nothing in this system actually knew it
// on 2026-02-01. This is precisely the "silent" failure mode the step brief warns about: the
// result would look like an ordinary, uneventful backtest, not an obviously broken one.
//
// The only honest boundary is WHEN THE SYNC RUN THAT PRODUCED THE PAYLOAD FINISHED, never the day
// the payload's own data is about. `PointInTimeArchiveReader.create()` reads `syncRuns` (B1's own
// bookkeeping — one doc per sync run, with `status`/`finishedAt`) and allows a payload through
// only when the run that archived it (`payload.runId`, matched against `syncRuns/{runId}`)
// SUCCEEDED and finished at or before `asOfInstant`. The `day` field parsed out of the object
// name is carried through on the returned record for windowing (it says what the row is about),
// but it plays NO role in the leakage decision itself.
// ============================================================================================
//
// Cannot be constructed without an `asOfInstant` (private constructor + a required field on the
// only public factory) and exposes no passthrough to the underlying archive's `read(path)` —
// `readArchivedPayloads` is the only way out, and it is always filtered. There is no sibling
// "just give me everything" method for a future author to reach for instead, mirroring
// `GapAware`'s own "no unwrapped export sits next to the safe one" discipline.

import type { RawArchiveStore } from "@services/ingest/sync/archiver.ts";
import { parseRawArchivePath, type ParsedArchivePath } from "./archivePath.ts";

/** The narrow enumeration capability the real archive bucket needs beyond `RawArchiveStore`'s
 * own `archive`/`read` (§23's own store is deliberately narrow and has no listing method — see
 * archiver.ts's module comment). A real `@google-cloud/storage` `Bucket` already exposes
 * `getFiles`, so `GcsArchiveListable` below is a structural wrapper, not a new capability grafted
 * onto B1's own class. Kept as its OWN interface (not added to `RawArchiveStore`) specifically so
 * this step never has to touch archiver.ts — every existing `dummyArchiver: RawArchiveStore`
 * fixture across ~20 other steps' test files is untouched by this addition. */
export interface ArchiveListable {
  /** Every object name under `prefix` (no trailing-slash assumptions beyond §23's own
   * convention). A real bucket paginates internally; implementations should return the full
   * list — this account's archive volume (§22: well under BigQuery scale) never approaches a
   * size where that's a problem. */
  listObjectNames(prefix: string): Promise<string[]>;
}

/** A real `@google-cloud/storage` `Bucket.getFiles` wrapped down to `ArchiveListable`. */
export function wrapGcsBucketAsListable(bucket: {
  getFiles(options: { prefix: string }): Promise<[{ name: string }[], unknown, unknown]>;
}): ArchiveListable {
  return {
    async listObjectNames(prefix: string): Promise<string[]> {
      const [files] = await bucket.getFiles({ prefix });
      return files.map((f) => f.name);
    },
  };
}

export interface SyncRunKnowledge {
  runId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  finishedAt: Date | null;
}

/** Reads every `syncRuns` doc this system knows about — a full collection scan, matching this
 * codebase's own established "account scale is small, a full read pass is fine" precedent (C2's
 * own recompute algorithm, B1's own `syncRuns` volume). No composite index needed; no new one
 * added to firestore.indexes.json. */
export interface SyncRunSource {
  listAllSyncRuns(): Promise<SyncRunKnowledge[]>;
}

export interface ArchivedPayloadRecord {
  source: "meta" | "shopify";
  /** The day the payload is ABOUT (see module comment) — informational/windowing use only,
   * never the leakage filter. */
  day: string;
  resource: string;
  runId: string;
  path: string;
  payload: unknown;
}

export interface PointInTimeArchiveReaderDeps {
  asOfInstant: Date;
  archive: RawArchiveStore;
  listable: ArchiveListable;
  syncRuns: SyncRunSource;
}

/**
 * Structurally cannot be constructed without a point in time: the constructor is private, and
 * the only factory (`create`) requires `asOfInstant` on its input object — there is no default,
 * no "create an unbounded reader" path, and TypeScript will not compile a call site that omits
 * it. See pointInTimeArchive.test.ts's "cannot be constructed without asOfInstant" case for the
 * compile-time proof (mirrors D5 guardrails.test.ts's own `@ts-expect-error` precedent for a
 * structural guarantee).
 */
export class PointInTimeArchiveReader {
  readonly asOfInstant: Date;
  private readonly archive: RawArchiveStore;
  private readonly listable: ArchiveListable;
  private readonly allowedRunIds: ReadonlySet<string>;
  private readonly runFinishedAtById: ReadonlyMap<string, Date>;

  private constructor(
    asOfInstant: Date,
    archive: RawArchiveStore,
    listable: ArchiveListable,
    allowedRunIds: ReadonlySet<string>,
    runFinishedAtById: ReadonlyMap<string, Date>,
  ) {
    this.asOfInstant = asOfInstant;
    this.archive = archive;
    this.listable = listable;
    this.allowedRunIds = allowedRunIds;
    this.runFinishedAtById = runFinishedAtById;
  }

  static async create(deps: PointInTimeArchiveReaderDeps): Promise<PointInTimeArchiveReader> {
    const runs = await deps.syncRuns.listAllSyncRuns();
    const allowedRunIds = new Set<string>();
    const runFinishedAtById = new Map<string, Date>();
    for (const run of runs) {
      if (run.status !== "SUCCEEDED") continue; // a failed/still-running sync taught us nothing
      if (run.finishedAt === null) continue;
      if (run.finishedAt.getTime() > deps.asOfInstant.getTime()) continue; // not yet known at T
      allowedRunIds.add(run.runId);
      runFinishedAtById.set(run.runId, run.finishedAt);
    }
    return new PointInTimeArchiveReader(
      deps.asOfInstant,
      deps.archive,
      deps.listable,
      allowedRunIds,
      runFinishedAtById,
    );
  }

  /** When the run that produced `runId` finished, for reconstruction code that wants to stamp an
   * honest historical `fetchedAt`/`syncedAt` rather than `new Date()` (which would read as "now",
   * long after the asOf date the reconstruction is replaying). `undefined` for any runId not in
   * the allowed set — callers should not be asking about a run this reader has already excluded. */
  runFinishedAt(runId: string): Date | undefined {
    return this.runFinishedAtById.get(runId);
  }

  /**
   * The ONLY way to get archived payloads out of this reader. Lists every object under
   * `raw/{source}/`, parses each name, and returns only the ones whose producing run is in the
   * allowed set (computed once, at construction, from `syncRuns` — see the module comment for
   * why that is the correct and only filter). `resource`, when supplied, additionally restricts
   * to objects with that exact resource string (e.g. "insights_page", "orders_csv_import").
   *
   * There is no `read(path)` exposed here and no way to bypass this filter — a caller wanting a
   * specific payload still has to go through this method and then find it in the returned array.
   */
  async readArchivedPayloads(
    source: "meta" | "shopify",
    resource?: string,
  ): Promise<ArchivedPayloadRecord[]> {
    const names = await this.listable.listObjectNames(`raw/${source}/`);
    const parsed: { path: string; parsed: ParsedArchivePath }[] = [];
    for (const name of names) {
      const p = parseRawArchivePath(name);
      if (!p) continue;
      if (p.source !== source) continue;
      if (resource !== undefined && p.resource !== resource) continue;
      if (!this.allowedRunIds.has(p.runId)) continue; // the structural leakage filter
      parsed.push({ path: name, parsed: p });
    }

    const records: ArchivedPayloadRecord[] = [];
    for (const { path, parsed: p } of parsed) {
      const payload = await this.archive.read(path);
      records.push({
        source: p.source,
        day: p.day,
        resource: p.resource,
        runId: p.runId,
        path,
        payload,
      });
    }
    return records;
  }
}
