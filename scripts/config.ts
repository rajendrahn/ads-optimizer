// Non-secret identifiers recorded during A0. These are IDs and domains, not credentials —
// safe to commit. Actual secret values live in Secret Manager only; see SETUP.md.

export const GCP_PROJECT_ID = "sng-meta-ads-optimizer";

export const META_API_VERSION = "v21.0";
export const META_AD_ACCOUNT_ID = "act_456833154967349";

export const SHOPIFY_SHOP_DOMAIN = "shopsparkleandglow.myshopify.com";
export const SHOPIFY_API_VERSION = "2025-01";

export const ANTHROPIC_MODEL = "claude-fable-5";

// §23 raw data archive bucket, created in A0 (SETUP.md §1). Same region as Firestore
// (asia-south1), IAM-only access — never the client-facing default Firebase Storage bucket.
export const RAW_ARCHIVE_BUCKET = "sng-meta-ads-optimizer-archive";

// The deployed `syncTaskDispatch` Cloud Function's HTTPS URL — the Cloud Tasks target the
// Shopify webhook receiver enqueues onto (B6's `SYNC_TASK_DISPATCH_URL`).
//
// Kept HERE, in source control, rather than only as a deployed env var. Setting it by hand with
// `gcloud run services update` works exactly until the next `firebase deploy --only functions`,
// which manages that service's environment and silently drops anything it does not know about —
// so the webhook receiver would start throwing again with no code change to explain it. It is a
// non-secret deployment identifier, the same category as the bucket and ad-account id above.
// An env var of the same name still wins where one is set (see webhooks/runtime.ts), so a
// second environment can override it without editing this file.
export const SYNC_TASK_DISPATCH_URL = "https://synctaskdispatch-tferenuybq-el.a.run.app";
export const SYNC_TASKS_SERVICE_ACCOUNT_EMAIL =
  "sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com";

// B5: the restricted bucket holding the one-time Matrixify order-history export(s) — never
// the general raw archive bucket above (SETUP.md §3: this file carries customer identifiers,
// so it gets its own IAM-scoped bucket, readable only by `sync-functions` and the project
// owner). The object key is the default this account's export was uploaded as; B5's importer
// accepts a different key per invocation (see services/ingest/shopify/orders/csvSource.ts)
// so a later, larger export can be imported without a code change — see IMPLEMENTATION_PLAN.md
// B5 notes on why this must stay re-runnable against multiple export files.
export const SHOPIFY_PII_IMPORT_BUCKET = "sng-meta-ads-optimizer-pii-imports";
export const SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY = "shopify-orders-backfill.csv";
