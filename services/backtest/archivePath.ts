// The inverse of services/ingest/sync/archiver.ts's `buildRawArchivePath` — pure string
// parsing, no I/O. E1 needs this to turn a listed Cloud Storage object name (`raw/meta/2026/
// 08/30/insights_page_run123_0.json`) back into the (source, day, resource, runId) tuple that
// `PointInTimeArchiveReader` filters on.
//
// Deliberately NOT added to archiver.ts itself — B1 owns that file (Done), and this parser is
// only needed by E1's own read-side replay code, never by any write path. Round-tripped against
// the real `buildRawArchivePath` in archivePath.test.ts so the two can never silently drift.

export interface ParsedArchivePath {
  source: "meta" | "shopify";
  /** The reporting day (YYYY-MM-DD) the payload is ABOUT, per archiver.ts's own module comment —
   * NOT the day it was fetched. See pointInTimeArchive.ts's module comment for why that
   * distinction is exactly the leakage trap this system has to avoid. */
  day: string;
  resource: string;
  runId: string;
  seq: number;
}

const RAW_ARCHIVE_PATH_RE =
  /^raw\/(meta|shopify)\/(\d{4})\/(\d{2})\/(\d{2})\/(.+)_([^_]+)_(\d+)\.json$/;

/**
 * Parses a §23 archive object name. Returns `null` (never throws) for anything that doesn't
 * match — a listing may in principle contain objects this system didn't write (a stray upload,
 * a future path convention change); a caller replaying history should skip those, not crash.
 *
 * The resource/runId split is ambiguous in general (both are free text and the filename joins
 * them with `_`), so this relies on the one structural fact `buildRawArchivePath` guarantees:
 * `seq` is always the LAST `_`-separated numeric segment before `.json`, and `runId` is
 * everything between the second-to-last `_` and that. This means a `resource` string itself
 * containing `_` (e.g. "insights_page") parses correctly, but a `runId` containing `_` would not
 * — not a real constraint in practice, since every runId in this codebase is a Cloud Tasks task
 * id / `crypto.randomUUID()`-shaped string with no underscores.
 */
export function parseRawArchivePath(path: string): ParsedArchivePath | null {
  const match = RAW_ARCHIVE_PATH_RE.exec(path);
  if (!match) return null;
  const [, source, yyyy, mm, dd, resource, runId, seqStr] = match;
  const seq = Number.parseInt(seqStr, 10);
  if (!Number.isFinite(seq)) return null;
  return {
    source: source as "meta" | "shopify",
    day: `${yyyy}-${mm}-${dd}`,
    resource,
    runId,
    seq,
  };
}
