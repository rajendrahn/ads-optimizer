// §9.6: "syncState.status distinguishes no_new_data from unauthorized, and the latter
// surfaces in the UI." A0 used a Meta system-user token, which does not expire, so §9.6's
// scheduled refresh job is not needed here — but a *revoked* token is still a silent
// zero-row sync, so the distinction still matters and this still ships.
//
// This is deliberately the only piece of "health check" logic A4 owns. It is a pure
// classification function, not a task that fetches a resource and counts rows — that's
// Phase B's job (B1's syncState lifecycle, B3's insights sync). What A4 hands Phase B is the
// one signal it cannot derive on its own: whether the credential itself is still valid,
// which is what `MetaClient.checkAuth()` / `ShopifyClient.checkAuth()` answer with one
// trivial live call (see services/ingest/meta/client.ts, services/ingest/shopify/client.ts).
//
// A sync task combines that with what it already knows (how many new/changed rows it just
// fetched) to decide which of the three §9.6 states to write to `syncState`:
//
//   classifySyncStatus({ authorized: await client.checkAuth() then .authorized,
//                         newRowCount: rowsJustFetched.length })

import type { SyncStatus } from "@shared/schema/sync.ts";

export interface ClassifySyncStatusInput {
  /** From `checkAuth()` (or inferred from an `ApiError` with `kind: "unauthorized"` thrown
   * during the sync itself) — false means the credential is no longer valid. */
  authorized: boolean;
  /** Rows the sync actually fetched/upserted this run. Omit when the caller has not counted
   * rows yet (or the task type has no notion of "rows") — that defaults to `healthy`, since
   * only an explicit zero justifies `no_new_data`. */
  newRowCount?: number;
}

export function classifySyncStatus(input: ClassifySyncStatusInput): SyncStatus {
  if (!input.authorized) return "unauthorized";
  if (input.newRowCount === 0) return "no_new_data";
  return "healthy";
}
