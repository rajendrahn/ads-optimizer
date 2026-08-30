# Setup Runbook

This is the reproducible record of step **A0** (cloud provisioning and credential collection) from
`IMPLEMENTATION_PLAN.md`. It exists so a second environment can be stood up without archaeology, and so
later steps (A4 onward) have a single place to look up region, IDs, and secret names rather than asking.

Update this file as each section of A0 is completed. Do not put actual secret values here — only names,
IDs, and which Secret Manager entry holds the value.

---

## 1. Google Cloud / Firebase — ✅ Done

**Project ID:** `sng-meta-ads-optimizer`
**Firestore region:** `asia-south1` (native mode) — ⚠️ permanent, chosen once, do not attempt to change
**Billing account:** `01BC4B-FCF10D-10648F` — billing enabled, budget alert set at ₹5,000/month

### Reproduction steps

```powershell
# 1. Create the project and link billing (console: console.cloud.google.com/projectcreate),
#    then enable Firebase on it (console.firebase.google.com/ > Add project > select existing GCP project).

# 2. Create the Firestore database — NATIVE MODE, region is permanent.
gcloud firestore databases create --database='(default)' `
  --location=asia-south1 `
  --type=firestore-native `
  --project=sng-meta-ads-optimizer

# 3. Enable required APIs.
gcloud services enable `
  firestore.googleapis.com `
  run.googleapis.com `
  cloudfunctions.googleapis.com `
  cloudtasks.googleapis.com `
  cloudscheduler.googleapis.com `
  secretmanager.googleapis.com `
  storage.googleapis.com `
  cloudbuild.googleapis.com `
  --project=sng-meta-ads-optimizer

# 4. Create the raw archive bucket (§23) — same region as Firestore, IAM-only access.
gcloud storage buckets create "gs://sng-meta-ads-optimizer-archive" `
  --project=sng-meta-ads-optimizer `
  --location=asia-south1 `
  --uniform-bucket-level-access

# 5. Create service accounts.
gcloud iam service-accounts create sync-functions `
  --project=sng-meta-ads-optimizer `
  --display-name="Meta/Shopify sync functions"

gcloud iam service-accounts create reasoner `
  --project=sng-meta-ads-optimizer `
  --display-name="Claude reasoner (Cloud Run)"

# 6. Grant least-privilege IAM roles.
foreach ($SA in @("sync-functions", "reasoner")) {
  gcloud projects add-iam-policy-binding sng-meta-ads-optimizer `
    --member="serviceAccount:$SA@sng-meta-ads-optimizer.iam.gserviceaccount.com" `
    --role="roles/datastore.user"
}

gcloud storage buckets add-iam-policy-binding "gs://sng-meta-ads-optimizer-archive" `
  --member="serviceAccount:sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com" `
  --role="roles/storage.objectAdmin"

# 7. Budget alert: console → Billing → Budgets & alerts → ₹5,000/month, scoped to this project.
```

### Resources created

| Resource | Value |
|---|---|
| Project ID | `sng-meta-ads-optimizer` |
| Firestore region | `asia-south1` (native mode) |
| Raw archive bucket | `gs://sng-meta-ads-optimizer-archive` (asia-south1, uniform bucket-level access) |
| Default Firebase Storage bucket | `sng-meta-ads-optimizer.firebasestorage.app` (us-east1) — **not used** for the raw archive; see note below |
| Sync service account | `sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com` |
| Reasoner service account | `reasoner@sng-meta-ads-optimizer.iam.gserviceaccount.com` |

### IAM roles granted

| Service account | Role | Scope |
|---|---|---|
| `sync-functions` | `roles/datastore.user` | project |
| `sync-functions` | `roles/storage.objectAdmin` | `gs://sng-meta-ads-optimizer-archive` only |
| `sync-functions` | `roles/secretmanager.secretAccessor` | per-secret, see §5 below — pending until secrets exist |
| `reasoner` | `roles/datastore.user` | project |
| `reasoner` | `roles/secretmanager.secretAccessor` | `anthropic-api-key` only — pending until secret exists |

**Note on buckets:** Firebase auto-creates a default Storage bucket (the `.firebasestorage.app` one) intended
for client-SDK access under Firebase Storage Rules. The raw archive (§23) deliberately uses a *separate*,
plain Cloud Storage bucket instead — it has no client-SDK access path at all, only IAM-gated service-account
access, which matches the "all data served through the API, never direct client access" rule in §17.1. Do
not repurpose the default Firebase bucket for archive data.

**Note on service account keys:** no JSON key files were generated for either service account. Cloud Run and
Cloud Functions attach the service account identity directly at deploy time (`--service-account` flag); the
runtime gets credentials from the metadata server. This wiring happens in A4/B1, not here.

---

## 2. Meta — ✅ Done

- [x] Create a Business app with Marketing API access
- [x] Create a **System User** (not a personal user) and generate its token
- [x] Grant `ads_read` and `business_management` only — **not** `ads_management`
- [x] Record: app ID, app secret, system user token, ad account ID (`act_` prefixed)

**Values recorded:**

| Field | Value |
|---|---|
| App ID | `61594184750975` |
| Ad account ID | `act_456833154967349` |
| Marketing API access tier | **Standard Access** — confirmed sufficient. Advanced Access was never pursued: this app only ever touches the one ad account owned by its own Business Manager, which Standard Access already permits. No App Review / Business Verification wait was needed. |
| Verification call | `GET https://graph.facebook.com/v21.0/act_456833154967349?fields=name` with the system user token — returned the account name successfully |

### Setup notes for reproduction

- The app initially showed **App Type: None** and `business_management` did not appear in Permissions and
  Features. Root cause: the app needs a role assignment on it from the System User, separately from the ad
  account assignment — Business Settings → System Users → [user] → Assign Assets has **separate asset-type
  tabs for Ad Accounts and Apps**; granting only the ad account is not sufficient to unlock the app's
  permission checkboxes at token-generation time.
- Fix sequence that worked: Business Settings → Users → System Users → assign the **ad account** asset →
  separately assign the **app** asset (own tab in the same panel) → then Generate New Token → the `ads_read`
  / `business_management` checkboxes become selectable.
- **Do not paste tokens/secrets through PowerShell string interpolation into `gcloud secrets create/versions
  add --data-file=-` via a pipe** — this silently appended trailing whitespace in testing here and produced
  a token that Meta's API rejected with a generic `(#200) Provide valid app ID` error even though the token
  was valid (confirmed via Graph API Explorer). **Use the Cloud Console Secret Manager UI to paste secret
  values directly** (Create Secret / + New Version, paste into the value box) — this avoided the corruption
  entirely and is now the standard method for adding any secret in this project.
- Secrets created: `meta-system-user-token`, `meta-app-secret` — both granted `roles/secretmanager.secretAccessor`
  to `sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com`.

---

## 3. Shopify — ✅ Done

- [x] Create a **custom app** in store admin (not a public app)
- [x] Admin API scopes: `read_orders`, `read_products`, `read_customers`
- [x] ~~Request `read_all_orders`~~ — **not requested, resolved differently.** See note below.
- [x] Confirm protected customer data access status — **confirmed live during B5**: a read-only
      GraphQL query for `order.customer.id` against the real store succeeds (no `ACCESS_DENIED`),
      so this was auto-approved (or already granted) rather than pending review. Not otherwise
      re-verified for every possible customer field — B5 only ever reads `customer.id`, per §17.2's
      PII boundary.
- [x] Record: shop domain, Admin API access token, webhook signing secret, API version
- [x] Upload the Matrixify full-order-history export to the restricted PII bucket (below) — uploaded
      to `gs://sng-meta-ads-optimizer-pii-imports/shopify-orders-backfill.csv` (10.14 MiB). This
      first export turned out to be **partial**: 37,172 CSV rows covering only the earliest ~10,000
      of the ~22.6K orders quoted above, truncated by the exporting tool's own plan/row-size limit
      (a literal "###### YOUR PLAN ALLOWS FILE SIZE TILL HERE ###### UPGRADE IF YOU NEED LARGER
      FILES" row is present in the file). B5's importer is built to accept further, larger exports
      later without duplicating or regressing already-imported data — see `IMPLEMENTATION_PLAN.md`
      B5 notes.

**Values recorded:**

| Field | Value |
|---|---|
| Shop domain | `shopsparkleandglow.myshopify.com` (storefront: `sparkleandglow.co.in`) |
| Admin API version | `2025-01` |
| `read_all_orders` status | **Not requested — not needed.** See resolution note below |
| Verification call | `POST /admin/api/2025-01/graphql.json` with `{ shop { name } }` — returned `"Sparkle and Glow"` successfully |

### Resolution: historical backfill without `read_all_orders`

`read_all_orders` was never granted (it's a protected scope, not self-service for a store-admin custom app —
would have needed a Partner Dashboard request or a Shopify support ticket, and was the longest wait in all of
A0). Instead: a **Matrixify** (Excel Export/Import app) export of the full order history was run directly
against the store and returned **~22.6K orders**, unaffected by the 60-day REST/GraphQL Orders API
restriction. B5 now seeds historical data from this one-time CSV export instead of Bulk Operations; ongoing
sync uses plain `read_orders` (sufficient — nothing ongoing ever looks further back than 60 days). Full
reasoning recorded in `IMPLEMENTATION_PLAN.md` under B5 and the Open Questions section.

**Correction (verified during B5): the real export contains no name, email, address or phone —
only a numeric `Customer: ID`, `Billing: Country Code` and `Shipping: Country Code`.** This line
previously claimed otherwise before the actual file was inspected. A bare customer ID is still
personal data worth protecting carefully (§17.2), so the restricted-bucket handling below stands
regardless — it just isn't the name/email/address kind of PII originally assumed. The CSV must
still **not** go in the general raw archive bucket or the repo. Restricted storage location:

```powershell
gcloud storage buckets create "gs://sng-meta-ads-optimizer-pii-imports" `
  --project=sng-meta-ads-optimizer `
  --location=asia-south1 `
  --uniform-bucket-level-access

gcloud storage buckets add-iam-policy-binding "gs://sng-meta-ads-optimizer-pii-imports" `
  --member="serviceAccount:sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com" `
  --role="roles/storage.objectAdmin"

gcloud storage cp "<local path to export>.csv" "gs://sng-meta-ads-optimizer-pii-imports/shopify-orders-backfill.csv"
```

No explicit access was granted beyond `sync-functions` (`roles/storage.objectAdmin`, scoped to this bucket) —
B5 (not a human) is the intended reader. The project owner's account retains inherent access via the
project-level Owner role (GCS's default legacy bucket bindings), which is unavoidable and expected for the
account that owns the project; no other identity has access. **Status: bucket created ✅, file uploaded ✅**
(`shopify-orders-backfill.csv`, see above — a partial export; further, larger exports can be uploaded under a
different object key and imported without re-running or duplicating anything).

### Webhook signing secret note

For a custom app, there's no field literally labeled "webhook signing secret" — it's the app's **API secret
key** (Client Secret), found in the same API credentials tab as the Admin API token. Shopify signs webhook
payloads created via `webhookSubscriptionCreate` (Admin API) with this value; that's what `shopify-webhook-secret` holds.

---

## 4. Anthropic — ✅ Done

- [x] Create an API key at the Claude Console
- [x] **Verify org data retention permits Claude Fable 5** — confirmed via a live one-token call (below);
      no 400, so the org is not on zero data retention
- [x] Set a spend limit on the key

**Values recorded:**

| Field | Value |
|---|---|
| Data retention setting | Permits Fable 5 (confirmed functionally — not ZDR) |
| Spend limit | Set by user in Claude Console billing settings |
| Secret | `anthropic-api-key`, granted to `reasoner@sng-meta-ads-optimizer.iam.gserviceaccount.com` |
| Verification call | `POST /v1/messages`, `model: claude-fable-5`, `max_tokens: 1` — returned `stop_reason: "max_tokens"`, `usage.output_tokens: 1`. No `temperature` param sent, per the D3 constraint that Fable 5 rejects it with a 400 |

---

## 5. Secret Manager naming convention

Fixed here — **do not change later**. A4 and every later step resolve secrets by these exact names.

> ⚠️ **Add secret values through the Cloud Console UI (Secret Manager → Create Secret / + New Version),
> not by piping through PowerShell.** Piping a string into `--data-file=-` from PowerShell was observed to
> silently append trailing whitespace, producing a token that looked fine locally but was rejected by Meta's
> API with a generic auth error. Pasting directly into the Console's value box avoids this. This applies to
> every secret below, not just the Meta ones.

| Secret name | Holds | Accessible by |
|---|---|---|
| `meta-system-user-token` | Meta system user token | `sync-functions` |
| `meta-app-secret` | Meta app secret | `sync-functions` |
| `shopify-admin-token` | Shopify Admin API access token | `sync-functions` |
| `shopify-webhook-secret` | Shopify webhook signing secret | `sync-functions` |
| `anthropic-api-key` | Anthropic API key | `reasoner` |

Once a secret is created:

```powershell
gcloud secrets create <secret-name> --project=sng-meta-ads-optimizer --replication-policy="automatic"
gcloud secrets versions add <secret-name> --project=sng-meta-ads-optimizer --data-file=-
# (paste the value, then Ctrl+Z, Enter on Windows to terminate stdin)

gcloud secrets add-iam-policy-binding <secret-name> `
  --project=sng-meta-ads-optimizer `
  --member="serviceAccount:<sync-functions-or-reasoner>@sng-meta-ads-optimizer.iam.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor"
```

For local runs of `scripts/verify-credentials.ts`, the operator's own account was granted
`roles/secretmanager.secretAccessor` at the project level (single-operator project, §2.1):

```powershell
gcloud projects add-iam-policy-binding sng-meta-ads-optimizer `
  --member="user:rajendrahn38@gmail.com" `
  --role="roles/secretmanager.secretAccessor"
```

---

## 6. Verification — ✅ All checks pass

`scripts/verify-credentials.ts` (Node + TypeScript via `tsx`; run with `npm run verify-credentials`) makes
one live call per credential and prints a pass/fail table. Requires the operator's own `gcloud auth
application-default login` session (granted `secretmanager.secretAccessor` in §1) to resolve secrets locally.

Last run result:

```
[PASS] Meta — fetch ad account name          account name: "456833154967349"
[PASS] Shopify — fetch shop record            shop name: "Sparkle and Glow"
[PASS] Anthropic — one-token claude-fable-5 call   stop_reason: "max_tokens"
```

(The Meta account "name" is its own numeric ID — the ad account was never given a custom display name in
Ads Manager. Not an error.)

No order-age assertion is needed for Shopify — historical coverage beyond 60 days is proven by the Matrixify
import (§3), not by an API scope, per the resolved open question below.

**Open questions carried into later steps** (see `IMPLEMENTATION_PLAN.md` § Open questions):

1. Do live Meta UTM tags carry `{{ad.id}}` or an ad name? — unresolved, resolve at start of B7.
2. ~~Has Shopify granted `read_all_orders`?~~ — resolved: not needed, see §3.
3. ~~Does the Anthropic org's retention setting permit Fable 5?~~ — resolved: confirmed via the live call above.

**Loose ends carried from A0 — both resolved by B5, see §3:**

- ~~Confirm whether Shopify's protected customer data access request was auto-approved or is still pending
  review~~ — resolved: confirmed live, auto-approved.
- ~~Upload the Matrixify CSV export to `gs://sng-meta-ads-optimizer-pii-imports/`~~ — resolved: uploaded
  (partial export, ~10k of ~22.6k orders — see §3).
