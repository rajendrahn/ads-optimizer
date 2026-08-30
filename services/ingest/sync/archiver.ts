// The raw payload archiver — §23: "For debugging, replay after feature-engine changes,
// reprocessing after schema changes, the backtest harness (§21.2), and reduced dependence on
// re-downloading history from external APIs."
//
//   /raw/meta/YYYY/MM/DD/…
//   /raw/shopify/YYYY/MM/DD/…
//
// §23's paths are written with a leading slash as a conceptual tree, but a Cloud Storage
// object *name* has no real notion of a leading "/" (a key literally named "/raw/..." is
// legal but idiosyncratic and awkward to browse) — `buildRawArchivePath` therefore emits keys
// without one (`raw/meta/2026/08/30/...`), which is the standard GCS convention for the exact
// same tree shape.
//
// `RawArchiveStore` is deliberately narrow (`archive` + `read`, JSON-serializable payloads
// only) — this is a debugging/replay archive, not a general blob store. `GcsRawArchiveStore`
// is the real implementation; it depends on `StorageBucketLike`, a structural slice of
// `@google-cloud/storage`'s `Bucket` (same seam pattern as A2/A4: `versionGuard`'s
// `VersionGuardFirestoreLike`, A4's `SecretManagerClientLike`), so tests exercise the REAL
// class's path-building and serialization logic against a hand-rolled in-memory bucket fake —
// no live bucket, no network — while a real `Bucket` from `@google-cloud/storage` satisfies
// the interface automatically at the real call site.
//
// Per this step's safety constraints, the real archive bucket (`gs://sng-meta-ads-optimizer-
// archive`, created in A0 — see SETUP.md §1) is never actually written to or read from here;
// `createDefaultRawArchiveStore()` is provided for B2–B8 to call for real, but nothing in this
// step's own code path invokes it against live Cloud Storage.

import { Storage } from "@google-cloud/storage";
import { RAW_ARCHIVE_BUCKET } from "../../../scripts/config.ts";

export interface ArchivePayloadInput {
  source: "meta" | "shopify";
  /** The reporting day (shared/canon `ReportingDay`, `YYYY-MM-DD`) this payload belongs to —
   * not necessarily "today"; a backfill task archives payloads under the day the data is
   * about, so replay lines up with §23's date-partitioned tree regardless of when the fetch
   * actually ran. */
  day: string;
  /** e.g. "insights", "orders", "campaigns" — free text, matches syncState's `resource`. */
  resource: string;
  /** The syncRuns id that produced this payload — ties an archived file back to its run. */
  runId: string;
  /** Anything JSON-serializable. Not validated against any schema — this is the raw payload
   * as received from the platform, before any normalization. */
  payload: unknown;
}

export interface RawArchiveStore {
  archive(input: ArchivePayloadInput): Promise<{ path: string }>;
  read(path: string): Promise<unknown>;
}

/** Builds the §23 object key. `seq` disambiguates multiple payloads from the same run/resource
 * (e.g. one per page of a paginated fetch) — callers should pass a monotonically increasing
 * value per run when archiving more than one payload for the same (source, day, resource,
 * runId) tuple; it defaults to 0 for the common single-payload case. */
export function buildRawArchivePath(
  input: Pick<ArchivePayloadInput, "source" | "day" | "resource" | "runId">,
  seq = 0,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.day);
  if (!match) {
    throw new Error(`buildRawArchivePath: "day" must be YYYY-MM-DD, got "${input.day}"`);
  }
  const [, yyyy, mm, dd] = match;
  return `raw/${input.source}/${yyyy}/${mm}/${dd}/${input.resource}_${input.runId}_${seq}.json`;
}

/** The narrow slice of `@google-cloud/storage`'s `File`/`Bucket` this module actually calls —
 * a real `Bucket` satisfies this structurally, no adapter needed. */
export interface StorageFileLike {
  save(data: Buffer, options?: { contentType?: string }): Promise<void>;
  download(): Promise<[Buffer]>;
}
export interface StorageBucketLike {
  file(name: string): StorageFileLike;
}

export class GcsRawArchiveStore implements RawArchiveStore {
  private readonly bucket: StorageBucketLike;
  private seqCounters = new Map<string, number>();

  constructor(bucket: StorageBucketLike) {
    this.bucket = bucket;
  }

  async archive(input: ArchivePayloadInput): Promise<{ path: string }> {
    const counterKey = `${input.source}|${input.day}|${input.resource}|${input.runId}`;
    const seq = this.seqCounters.get(counterKey) ?? 0;
    this.seqCounters.set(counterKey, seq + 1);

    const path = buildRawArchivePath(input, seq);
    const body = Buffer.from(JSON.stringify(input.payload), "utf8");
    await this.bucket.file(path).save(body, { contentType: "application/json" });
    return { path };
  }

  async read(path: string): Promise<unknown> {
    const [buf] = await this.bucket.file(path).download();
    return JSON.parse(buf.toString("utf8"));
  }
}

/** Real bucket, resolved from A0's fixed name. Not called anywhere in this step's own tests —
 * see module comment. B2+ should call this (or inject their own `StorageBucketLike`) rather
 * than constructing `new Storage()` themselves. */
export function createDefaultRawArchiveStore(): GcsRawArchiveStore {
  return new GcsRawArchiveStore(new Storage().bucket(RAW_ARCHIVE_BUCKET));
}
