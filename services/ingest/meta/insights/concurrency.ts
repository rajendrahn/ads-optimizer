// A small bounded-concurrency mapper — no dependency added (this repo hand-rolls its own
// primitives per §0.2's convention elsewhere: retry, BUC parsing, HMAC).
//
// Why this exists: `upsertWithVersionGuard` (A2) does one Firestore transaction per document —
// there is no bulk/version-guarded write primitive, and this step's brief is explicit that every
// insight write goes through it. At this account's real scale (1,139 ads; a rolling 14-day
// reconciliation window alone is ~16K rows, a year's backfill ~415K — see B2's Notes on account
// size), writing one row at a time, serially, would make even a single reconciliation pass take
// an impractically long time. Bounded concurrency gets real throughput out of many small
// transactions without the unbounded-parallelism failure mode (thousands of simultaneous
// transactions hammering Firestore / Meta's BUC budget at once).

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (concurrency < 1) {
    throw new Error(`mapWithConcurrency: concurrency must be >= 1, got ${concurrency}`);
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
