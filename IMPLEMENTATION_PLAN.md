# Implementation Plan

**Design reference:** `meta_ads_genai_recommendation_system_design_v2.md` (cited below as **§n**)
**Structure:** 26 steps across five phases. Each step is sized to be planned and implemented in one agent
session — except A0, which is mostly yours (see below).

---

## How to use this document

Each step below is a self-contained work order. To execute one, launch a planning agent with the prompt
template in §0.3. The agent reads the design document and its own step spec, produces a detailed plan, then
implements it.

Steps are ordered by dependency, not priority. Do not start a step whose dependencies are unfinished — the
`Depends on` line is load-bearing, because a cold agent has no way to discover a missing prerequisite except
by failing.

### 0.1 Progress tracking

Each step carries a `Status:` line. Update it as work proceeds — this file is the shared state between
sessions, and an agent starting cold reads it to understand what already exists.

```
Not started  →  Planned  →  In progress  →  Done
```

When a step finishes, the implementing agent should update its `Status:` line and append anything it learned
that later steps need under `Notes from implementation:`.

### 0.2 Standing conventions

Decisions already made. An agent should not relitigate these; if one appears wrong, raise it rather than
silently diverging.

| Area | Decision |
|---|---|
| Language | TypeScript throughout, strict mode |
| Backend runtime | Cloud Run for the reasoner and web API; Cloud Functions 2nd gen for scheduled sync |
| Frontend | React (Next.js optional — not required before D6) |
| Database | Cloud Firestore, flat top-level collections per §8 |
| Model access | First-party Claude API via `@anthropic-ai/sdk` — **not** Vertex, **not** a raw `fetch` |
| Model | `claude-fable-5` for reasoning, `claude-haiku-4-5` for bulk tagging |
| Meta API | Marketing API, async report jobs for insights |
| Shopify API | GraphQL Admin API + Bulk Operations. REST is legacy — do not use it |
| Secrets | Google Secret Manager, never `.env` in source control |
| Money | Integer minor units (paise), never floats |
| Time | Store UTC instants; derive reporting days via the §5.1 canon |
| Testing | Vitest; Firestore emulator for integration tests |

**Repository layout** (established in A1, assumed by every later step):

```
/functions        Cloud Functions — scheduled sync entrypoints
/services
  /ingest         Meta + Shopify clients, sync tasks
  /analytics      normalization, features, statistics
  /evidence       decision evidence engines, packet builder
  /reasoner       Claude integration, tools, guardrails
/shared
  /schema         Firestore document types, zod validators
  /canon          reporting canon: timezone, currency, attribution
/web              React app
/scripts          one-off operational scripts (e.g. the UTM audit)
/test
```

### 0.3 Prompt template for a planning agent

Copy this, substituting the step ID:

```
Read meta_ads_genai_recommendation_system_design_v2.md and IMPLEMENTATION_PLAN.md
in this repo.

Your task is step <ID> only. Read its spec in IMPLEMENTATION_PLAN.md, including its
Depends on, Out of scope, and Done when lines, and read the design sections it cites.

First produce a detailed implementation plan for that step: files to create or change,
data shapes, the order of work, and how you will verify each piece. Surface any
ambiguity you find in the design rather than guessing at it.

Then implement the plan. Stay inside the step's scope — if you find work that belongs
to another step, note it and leave it.

When you are done, update the step's Status line in IMPLEMENTATION_PLAN.md and append
anything you learned that later steps depend on.
```

For **D3** specifically, add: `Load the claude-api skill before writing any Claude API code.`

### 0.4 Dependency graph

```text
A0 provisioning + credentials  ◀── mostly manual, do this first
 │
A1 scaffold
 ├─ A2 schema+rules
 │   ├─ A3 canon ──────────────┐
 │   └─ A4 api clients ◀── needs A0 credentials
 │       └─ B1 sync framework   │
 │           ├─ B2 meta entities┤
 │           │   ├─ B3 insights ┤
 │           │   ├─ B4 changes  │
 │           │   └─ B8 creative identity
 │           ├─ B5 shopify orders
 │           │   └─ B6 webhooks
 │           └─ B7 attribution join ◀── needs B2 + B5
 │
 └─────────────────► C1 normalization ◀── needs B3 + B5 + A3
                      └─ C2 features
                          ├─ C3 statistics
                          └─ C4 change/learning features ◀── needs B4
                              │
                              ▼
                          D1 evidence engine
                           └─ D2 packets
                               └─ D3 claude integration
                                   ├─ D4 job pipeline
                                   │   └─ D6 web app
                                   └─ D5 guardrails
                                       │
                                       ▼
                                   E1 backtest ─ E2 outcomes ─ E3 calibration
```

**Critical path:** A0 → A1 → A2 → A4 → B1 → B3 → C1 → C2 → C3 → D1 → D2 → D3 → D4 → D6.

**Parallelisable:** B5/B6 (Shopify) runs alongside B2/B3/B4 (Meta). B8 runs any time after B2. A3 runs
alongside A4.

---

# Phase A — Foundation

A0 provisions real cloud resources and credentials. A1–A3 are local and testable against emulators; A4 is
the first step that touches a live external API.

---

### A0 — Cloud provisioning and credential collection

**Status:** Done — `scripts/verify-credentials.ts` passes on Meta, Shopify and Anthropic; all secrets resolve
from Secret Manager; `SETUP.md` complete. Two non-blocking loose ends remain before B5 (not before A1–A4):
confirming Shopify protected customer data access approval, and uploading the Matrixify CSV export to the
PII bucket once the file is ready. See `SETUP.md` §6.
**Depends on:** —
**Design refs:** §9.6, §16.2, §17, §19.1
**Size:** M — but mostly wall-clock, not work

> **This step is different.** Most of it is console clicks, OAuth flows and access requests that an agent
> cannot perform: creating a Google Cloud project, registering a Meta app, generating an Anthropic key.
> Two of the items below involve **approval waits measured in days**, so start them first and do the rest
> while they process.

#### What you do

**1. Google Cloud / Firebase**
- Create the project; enable billing; **set a budget alert** before anything can run up a bill
- Enable APIs: Firestore, Cloud Run, Cloud Functions, Cloud Tasks, Cloud Scheduler, Secret Manager, Cloud
  Storage, Cloud Build
- Create the **Firestore database in native mode**. ⚠️ **The region is permanent and cannot be changed
  later** — pick the one nearest your users and record it
- Create a Cloud Storage bucket for the raw archive (§23) and creative assets, in the same region
- Create service accounts for the sync functions and the reasoner, with least-privilege IAM roles

**2. Meta**
- Create a Business app with Marketing API access
- ⚠️ **Use a System User token, not a personal user token.** System user tokens do not expire when a person
  changes their password or leaves, which is the failure mode §9.6 warns about
- Grant **`ads_read` and `business_management` only.** Do **not** grant `ads_management` — the system is
  read-only until Phase F, and least privilege is the whole point of that sequencing
- Record: app ID, app secret, system user token, **ad account ID** (the `act_` prefixed one)
- ⏳ Marketing API access may require app review depending on your account's standing. Start this first.

**3. Shopify**
- Create a **custom app** in the store admin (not a public app — you own the store)
- Admin API scopes: `read_orders`, `read_products`, `read_customers`. **`read_all_orders` is not requested**
  — B5's historical backfill is seeded from a Matrixify CSV export instead (below), so the Shopify approval
  wait that scope requires is off the critical path entirely
- ⚠️ Enable **protected customer data access** in the app configuration — required for any customer field,
  including the new-vs-repeat determination §12 depends on
- **Export full order history via Matrixify** (the Excel Export/Import app) now — no approval wait. A first
  export on this store already returned **~22.6K orders**, confirming it is not subject to the 60-day API
  restriction. Save the export somewhere B5 can read it (Cloud Storage, **not** the repo — it contains
  customer PII)
- Record: shop domain, Admin API access token, **webhook signing secret** (needed by B6), API version

**4. Anthropic**
- Create an API key at the Claude Console
- ⚠️ **Verify the organisation's data retention setting.** Claude Fable 5 requires 30-day retention and is
  unavailable under zero data retention — under ZDR, requests fail with a 400 (§19.1). Confirm this before
  the reasoner is built in D3, not after
- Set a spend limit on the key

#### What the agent does

- Write `SETUP.md` — the runbook version of the above, so this is reproducible and so a second environment
  can be stood up without archaeology
- Push every collected secret into **Secret Manager** under a documented naming convention, e.g.
  `meta-system-user-token`, `meta-app-secret`, `shopify-admin-token`, `shopify-webhook-secret`,
  `anthropic-api-key`. A4 and every later step resolve secrets by these names — **fix them here and do not
  change them later**
- Write `scripts/verify-credentials.ts`: for each credential, make one minimal live call and print a
  pass/fail table. Meta — fetch the ad account name. Shopify — fetch the shop record (no order-age
  assertion needed — historical coverage beyond 60 days is proven separately by the Matrixify import in B5,
  not by an API scope). Anthropic — a one-token `claude-fable-5` call, which also proves the retention
  setting permits it
- Record the chosen Firestore region, ad account ID, shop domain and Shopify API version in `SETUP.md` —
  later steps need these and should not have to ask
- **Verify nothing is committed.** No token, key or secret in source control; `.gitignore` covers local
  credential files

**Out of scope.** Building the API clients — that is A4. This step proves credentials work; A4 makes them
useful. No business logic, no data fetched beyond the verification calls.

**Done when.** `scripts/verify-credentials.ts` passes on every row, **including the Fable 5 call**; every
secret resolves from Secret Manager rather than a local file; `SETUP.md` is complete enough that someone
else could redo it.

**Notes for the planning agent.** One item gates later work and involves waiting on someone else: Meta
Marketing API access. Surface it to the user immediately rather than discovering it at B2. If it is still
pending, the rest of Phase A and much of Phase B can proceed — say so rather than stalling.

Shopify's historical order access no longer waits on anyone: B5 seeds pre-60-day order history from a
one-time Matrixify CSV export instead of `read_all_orders`. Get that export done early — it has no approval
step, only the store's own order volume gates how long it takes to run.

The verification script is the real deliverable here. Credentials that are merely *collected* fail at B3 or
B5 with a confusing error; credentials that are *verified* fail here, where the fix is obvious.

---

### A1 — Repository scaffold and local development

**Status:** Not started
**Depends on:** A0 (needs the project ID and region)
**Design refs:** §16.2
**Size:** S

**Goal.** A repository that builds, tests, lints and runs against the Firebase emulator suite, with the
directory layout in §0.2 in place.

**Deliverables**
- TypeScript project, strict mode, path aliases matching the layout above
- Firebase project configuration; emulator suite for Firestore, Auth and Functions
- Vitest configured, with one trivial passing test proving the harness works
- Lint + format; a single `npm run check` that runs typecheck, lint and tests
- `README.md` covering local setup and how to run the emulators

**Out of scope.** Any business logic. Any real cloud resource. Any API client.

**Done when.** `npm run check` passes on a clean clone, and the emulator suite starts.

**Notes for the planning agent.** Keep this deliberately thin — its only job is to make every later step
cheap to start. Do not create placeholder modules for future steps; empty directories with a `.gitkeep` are
enough.

---

### A2 — Firestore schema, security rules and data access layer

**Status:** Not started
**Depends on:** A1
**Design refs:** §8, §9.5, §17.1
**Size:** M

**Goal.** Typed, validated access to every collection in §8, with rules that deny all client access.

**Deliverables**
- Zod schemas and TypeScript types for every collection in §8, in `/shared/schema`
- A thin repository layer: typed get/set/query per collection, no business logic
- **Deterministic key helpers** per §9.5 (`metaInsightsDaily/{adId}_{date}` and the rest)
- **A monotonic-version upsert helper** (§9.5) — takes a document, a source `updated_at`, and refuses
  writes that would move a record backwards, logging the refusal
- `firestore.rules` denying all client reads and writes, with tests proving it
- Composite index definitions for the queries later steps will need

**Out of scope.** Populating anything. The features/packets/recommendations collections can be typed now but
their semantics land in C2/D2/D4.

**Done when.** Rules tests pass against the emulator; the version-guard helper has tests covering
in-order, out-of-order and equal-version writes.

**Notes for the planning agent.** The version-guard helper is the single most reused primitive in Phase B —
get its ergonomics right. Every Shopify write and every reconciled Meta insight goes through it.

---

### A3 — Reporting canon and settings

**Status:** Not started
**Depends on:** A2
**Design refs:** §5, §19.2
**Size:** S

**Goal.** One validated settings document, loaded once, that fixes timezone, currency, attribution window
and purchase action type — plus the conversion helpers everything else uses.

**Deliverables**
- `settings/` document schema and a cached, validated loader that fails loudly on a missing or invalid value
- `toReportingDay(instant, timezone)` and its inverse — the only sanctioned way to derive a reporting day
- Money helpers in integer minor units, with currency codes attached
- Model configuration per §19.2

**Out of scope.** Applying the canon to real data (that is C1). Changing the canon at runtime — treat these
as write-once values.

**Done when.** Day-boundary tests pass for instants either side of midnight in the reporting timezone, and
across a DST transition in a non-IST timezone to prove the helper is not hardcoded.

**Notes for the planning agent.** §5 is emphatic that these cannot be retrofitted. Make the loader throw on
absence rather than defaulting — a silent default here corrupts every stored record.

---

### A4 — API clients, secrets and rate limiting

**Status:** Not started
**Depends on:** A0 (live credentials), A1
**Design refs:** §7.1, §9.6, §16.2
**Size:** M

**Goal.** Authenticated, rate-aware, retrying clients for Meta and Shopify. Transport only — no business
logic.

**Deliverables**
- Secret Manager access wrapper
- Meta Marketing API client with **`X-Business-Use-Case-Usage` header parsing and pre-emptive backoff**
  (§7.1) — the client throttles itself before the account is throttled
- Shopify GraphQL Admin API client, with cost-aware throttling (the API returns query cost and a leaky
  bucket state; respect it)
- Retry with exponential backoff, distinguishing retryable from terminal failures
- Secrets resolved by the names fixed in A0 — never re-derived or hardcoded
- Health check distinguishing `no_new_data` from `unauthorized` (§9.6). **If A0 used a Meta system user
  token, the refresh job §9.6 describes is not needed** — those do not expire. Keep the health check either
  way; a revoked token is still a silent zero-row sync

**Out of scope.** Any specific Meta or Shopify resource. Fetching entities, insights or orders belongs to
Phase B.

**Done when.** Both clients authenticate against real sandbox/dev credentials and return one trivial
response; throttle logic has unit tests against synthetic headers.

**Notes for the planning agent.** The BUC throttle is the piece most likely to be skipped and most likely to
cause pain later — a throttled account stalls every sync. Treat the header parsing as a first-class
component with its own tests, not an afterthought inside the request function.

---

# Phase B — Ingestion

---

### B1 — Sync framework

**Status:** Not started
**Depends on:** A2, A4
**Design refs:** §9.3, §9.4, §10.2, §23

**Size:** M

**Goal.** The task orchestration every ingestion step plugs into.

**Deliverables**
- Cloud Tasks controller and the task-type registry from §10.2
- `syncState` and `syncRuns` lifecycle: start, succeed, fail, watermark advance **only on success**
- Reconciliation-window helper (§9.4): given a watermark and a window, produce the date range to fetch
- Raw payload archiver writing to Cloud Storage per §23
- A uniform task wrapper providing idempotency, retry semantics and structured error recording

**Out of scope.** Any actual sync. This is the frame; B2–B8 are the pictures.

**Done when.** A no-op task can be enqueued, executed, retried on failure, and leaves correct `syncRuns`
state; the archiver round-trips a payload.

---

### B2 — Meta entity sync and config snapshots

**Status:** Not started
**Depends on:** B1, A3
**Design refs:** §7.1, §9.1, §9.2

**Size:** M

**Goal.** Campaigns, ad sets, ads and creatives normalized into Firestore, plus a full config snapshot on
every run.

**Deliverables**
- `META_SYNC_ENTITIES` task: campaigns, ad sets, ads, creatives
- Normalization capturing **budget ownership** explicitly (§7.1) — which level owns budget is required by D1
- `META_SNAPSHOT_CONFIG` task writing budget, status, targeting, bid strategy and creative assignment into
  `metaEntitySnapshots` on every run (§9.2)
- Raw payloads archived

**Out of scope.** Diffing snapshots into change events — that is B4. Insights — that is B3.

**Done when.** A full entity sync populates all four collections and one snapshot per entity; re-running
produces no duplicates.

**Notes for the planning agent.** Budget ownership determines the decision unit in D1. If it is ambiguous
for a given campaign structure, store the ambiguity explicitly rather than guessing — D1 needs to know when
it does not know.

---

### B3 — Meta insights sync

**Status:** Not started
**Depends on:** B2
**Design refs:** §5.3, §7.1, §9.4

**Size:** L

**Goal.** Daily insights, backfilled and then kept current, with attribution provenance on every record.

**Deliverables**
- `META_SYNC_INSIGHTS` and `META_POLL_ASYNC_REPORT` tasks — **backfill runs as async report jobs**
  (submit → poll `report_run_id` → page results), because a synchronous call over a long range will fail
- **Every insight document stores the attribution window and purchase action type used to produce it**
  (§5.3). This is not optional metadata; it is part of the measurement
- Reconciliation: rolling 14-day re-fetch and upsert, weekly 60-day deeper pass
- Meta action counts retained for the funnel: `landing_page_view`, `add_to_cart`, `initiate_checkout`
  (needed by C2 per §7.2)

**Out of scope.** Deriving any metric. Insights land raw-normalized; C1 and C2 compute from them.

**Done when.** A year of history backfills without a synchronous timeout; reconciliation updates a changed
recent day without duplicating it; every stored record carries its attribution provenance.

**Notes for the planning agent.** This is the largest ingestion step. The async report job flow is
substantially different from a normal paged fetch — plan it as its own state machine inside the task
framework, not as a loop.

---

### B4 — Change event derivation

**Status:** Not started
**Depends on:** B2
**Design refs:** §9.2, §13

**Size:** S

**Goal.** Change history derived from our own snapshots, not Meta's activity feed.

**Deliverables**
- Diff consecutive `metaEntitySnapshots` into `metaChangeEvents`, typed by what changed (budget, status,
  targeting, bid strategy, creative assignment)
- Budget changes record before, after and percent
- Optional: Meta activity feed consulted **only** for actor attribution (who made the change)

**Out of scope.** The derived features in §13 — those are C4.

**Done when.** A simulated budget edit between two snapshots produces exactly one correctly typed change
event, and an unchanged snapshot pair produces none.

---

### B5 — Shopify orders, lines and refunds

**Status:** Not started
**Depends on:** B1, A3
**Design refs:** §7.2, §9.1, §9.5

**Size:** L

**Goal.** Order history seeded from a Matrixify CSV export, ongoing order data via GraphQL, with
`landing_site` preserved for the attribution join.

**Deliverables**
- **Historical backfill via Matrixify CSV import**, not Bulk Operations and not the `read_all_orders`
  scope — A0 produced a Matrixify export of the full order history (~22.6K orders on this account, well
  beyond the 60-day API window). Parse it, group its rows into orders/line items/refunds, and write through
  the same A2 monotonic version guard as everything else. Matrixify's export is row-based, not nested JSON:
  each order's line items, refund lines and transactions are additional rows in the same sheet,
  discriminated by a `Line: Type` column — group by order `Name`/`ID` before writing
- Incremental sync via `updated_at` watermark, over plain paginated GraphQL (no Bulk Operations needed —
  that machinery existed only for the historical backfill this replaces)
- Orders, line items, refunds, product/variant, customer ID, new-vs-repeat, country
- **New-vs-repeat derived from each customer's order sequence** (group by customer ID, sort by created date,
  first = new) — Matrixify's own `Customer: Orders Count` column is a snapshot as of export time, not as of
  each order, and will misclassify historical orders if used directly
- **`landing_site` and `referring_site` preserved verbatim** — from Matrixify's `Browser: Landing Page` /
  `Browser: Referrer` columns for imported history, from the GraphQL order for ongoing orders. B7 depends on
  the query string surviving
- **Customer PII dropped at parse time** — only customer ID, derived new-vs-repeat and country are written
  to Firestore; email, name, address and phone from the Matrixify export are never persisted there. Treat the
  raw CSV file itself as sensitive (restricted Cloud Storage path, not the general-access raw archive)
- All writes through the A2 monotonic version guard

**Out of scope.** Parsing UTMs or attributing orders to ads — that is B7. Funnel events — not in the Admin
API at all (§7.2). Re-running the Matrixify import — it is one-time; everything after the seed arrives via
incremental sync and B6 webhooks.

**Done when.** The Matrixify import completes with orders older than 60 days present in Firestore;
incremental sync picks up a new order; a replayed webhook payload does not duplicate or regress a record;
spot-checking new-vs-repeat against a known customer's order history matches.

**Notes for the planning agent.** Use GraphQL, not REST, for incremental sync. The Matrixify CSV needs its
own row-grouping parser — it is a flat sheet with one row per line item/refund/transaction, not the nested
JSONL Bulk Operations would have produced. Confirm the export file's column headers match what §7.2 lists
before writing the parser; Matrixify lets users customize which columns are included in a given export.

---

### B6 — Shopify webhooks

**Status:** Not started
**Depends on:** B5
**Design refs:** §9.5, §25

**Size:** M

**Goal.** Real-time order and refund updates that survive at-least-once, out-of-order delivery.

**Deliverables**
- HTTPS endpoint with HMAC signature verification
- Subscriptions for order create/update, refund create, order cancel
- **Every write through the monotonic version guard**, with rejections logged to `syncRuns` (§9.5)
- Idempotency on webhook ID; fast acknowledge, then process asynchronously via Cloud Tasks

**Out of scope.** Web Pixel / customer events — explicitly deferred in §7.2.

**Done when.** A replayed webhook is a no-op; an out-of-order older payload is rejected and logged; an
invalid signature is refused.

---

### B7 — Attribution join

**Status:** Not started
**Depends on:** B2, B5
**Design refs:** §6

**Size:** M

**Goal.** Resolve Shopify orders to Meta ads, and make the quality of that resolution measurable.

**Deliverables**
- UTM parser over `landing_site`, resolving to `adId` / `campaignId`
- **Raw tag string stored alongside the resolved ID** (§6.1), so a mapping correction can be replayed from
  the archive without re-fetching
- `AUDIT_AD_URL_TAGS` task: parse every live ad's destination URL; any ad that does not yield a resolvable
  ad ID is flagged and **excluded from Shopify-attributed metrics rather than reported as zero revenue**
- `attributionCoverageRatio` computed at entity and account level (§6.3)

**Out of scope.** Reconciling the disagreement between Meta-attributed and Shopify-attributed figures —
§6.2 says they disagree structurally and must never be merged. The job here is to measure the gap, not close
it.

**Done when.** Orders resolve to ads on real data; an untagged ad appears in the audit output; the coverage
ratio computes and is stored.

**Notes for the planning agent.** ⚠️ **Run the tag audit first, before writing the join.** If the live tags
carry `{{ad.name}}` rather than `{{ad.id}}`, the join must key differently and the account needs re-tagging
before backfill (§6.1). This is the one open question in the whole plan — resolve it at the start of this
step, and report the answer.

---

### B8 — Creative identity

**Status:** Not started
**Depends on:** B2
**Design refs:** §7.3, §11.1

**Size:** S

**Goal.** The cheap half of creative work — grouping ads by shared creative, with no model calls.

**Deliverables**
- Group by Meta's own `image_hash` / `video_id`; perceptual hash for near-duplicates
- `creativeAssets` and `creativeFamilies` populated
- **Composite/dynamic creatives typed explicitly** per §7.3, with
  `eligibleForFamilyFatigueScore: false`

**Out of scope.** Download, OCR, transcripts, vision analysis, embeddings — all Phase F (§11.2).

**Done when.** Ads sharing a creative land in one family; a dynamic creative is typed as composite and
excluded from fatigue eligibility.

**Notes for the planning agent.** This exists to raise sample size (§4.1), not to analyse creative. Resist
scope creep toward the expensive half — it is a later phase for a reason.

---

# Phase C — Analytics

---

### C1 — Daily normalization

**Status:** Not started
**Depends on:** B3, B5, A3
**Design refs:** §5, §12

**Size:** M

**Goal.** Meta and Shopify data expressed on the same days, in the same currency.

**Deliverables**
- Meta insights and Shopify orders mapped to reporting days via the A3 canon
- Currency normalized to reporting currency, FX rate stored where any conversion occurs
- Every daily record stamped with the timezone it was computed in (§5.1)

**Out of scope.** Windowed aggregation and derived metrics — C2.

**Done when.** An order placed near midnight lands on the same reporting day as the Meta spend it is
attributed to; the timezone stamp is present on every record.

---

### C2 — Feature engine

**Status:** Not started
**Depends on:** C1, B7, B8
**Design refs:** §4.2, §10.1, §12

**Size:** L

**Goal.** Full recompute of every feature for every entity, on every sync.

**Deliverables**
- **Full recompute, not incremental** (§10.1) — no affected-entity propagation, no version vectors
- Window set per §4.2: **28d primary, 14d secondary, 7d trend-only. No 1d or 3d in the decision path**
- Delivery, traffic, funnel (from Meta actions), business and trend metrics per §12
- Computed at ad, ad set, campaign, creative family and account level
- `accountDataVersion` bumped once per sync run
- Funnel rates sourced from Meta action counts, per §7.2

**Out of scope.** Intervals and shrinkage — C3 layers those on. Learning-phase features — C4.

**Done when.** A full recompute over real data completes well inside a sync interval; spot-checked metrics
reconcile against Meta Ads Manager for the same window and attribution setting.

**Notes for the planning agent.** The performance target is deliberately loose because the account is small
(§2.1). Prefer clarity over cleverness — if a full recompute takes ten seconds, that is fine.

---

### C3 — Statistics layer

**Status:** Not started
**Depends on:** C2
**Design refs:** §2.1, §15

**Size:** L

**Goal.** Every business metric carries its own uncertainty. **This is the step that makes the whole
evidence-first premise true rather than decorative.**

**Deliverables**
- Minimum purchase floors per window, configurable (§15.1)
- Intervals on ROAS and CPA, with sample sizes attached (§15.2)
- Three-state verdict: `ABOVE_TARGET` / `BELOW_TARGET` / `NOT_DISTINGUISHABLE`
- **Shrinkage toward the account mean, weighted by purchase volume** (§15.3) — both the raw and shrunk
  values stored, since D1 gates on the shrunk one and the UI shows both

**Out of scope.** Change-point and anomaly detection (§15.5). Historical analogues — deferred in §15.4
until minimum-N is reachable.

**Done when.** A low-volume entity returns `NOT_DISTINGUISHABLE` where a naive point estimate would have
claimed a difference; shrinkage pulls a small-sample outlier toward the mean by a defensible amount, with
tests demonstrating both.

**Notes for the planning agent.** Read §15.3 carefully before designing this. The regression-to-the-mean
correction is not a refinement — without it, outcome tracking in E2 will systematically record correct
decisions as failures. Keep the estimator simple and explainable; a Gamma-Poisson or bootstrap approach
that you can describe in the packet text beats something more sophisticated that the model cannot reason
about.

---

### C4 — Change-aware and learning-phase features

**Status:** Not started
**Depends on:** C2, B4
**Design refs:** §13

**Size:** M

**Goal.** The features that stop "creative fatigue" being the answer to every question.

**Deliverables**
- The `hoursSince…` and `…ChangesLastNDays` family from §13, derived from `metaChangeEvents`
- **Learning-phase features** (§13.1): `inLearningPhase`, `conversionsToExitLearning`, `learningResetAt`,
  `learningResetCause`
- Detection of learning resets triggered by material budget edits

**Out of scope.** Using these in a decision — D1.

**Done when.** A simulated budget edit produces a learning reset with the correct cause and timestamp; an ad
set below the conversion threshold reports `inLearningPhase: true`.

**Notes for the planning agent.** §13.1 explains why this matters more here than at a larger account: at
20–35 conversions per ad set per week against a ~50 threshold, several ad sets sit below it indefinitely,
and that is frequently the true answer to "why did ROAS move?".

---

# Phase D — First decision, end to end

By the end of this phase the system answers one question well. That is the milestone worth optimising for.

---

### D1 — Scaling evidence engine

**Status:** Not started
**Depends on:** C3, C4
**Design refs:** §4, §14

**Size:** L

**Goal.** Deterministic evidence for a budget-scaling decision, resolved at the right altitude.

**Deliverables**
- Resolve any named entity to its **budget owner** — the decision unit (§4.1)
- **Escalation logic:** when the named ad lacks volume, answer at its ad set and record
  `escalatedFrom` with a reason. Returning `INSUFFICIENT_DATA` and stopping is a product failure, not rigour
- Assemble the evidence object in §14: multi-window performance with intervals, shrunk baseline, Shopify
  metrics, attribution coverage, funnel health, learning state, creative fatigue, recent changes
- Candidate safe action range and eligibility

**Out of scope.** Other decision types (Phase F). The model call — D3.

**Done when.** The §14 evidence object is produced for a real ad set; a low-volume ad produces an escalated
answer naming the ad set and the reason.

---

### D2 — Decision packets

**Status:** Not started
**Depends on:** D1
**Design refs:** §10.1, §14, §24

**Size:** M

**Goal.** Render evidence into the packet the model reasons over, and cache it.

**Deliverables**
- Packet builder producing both the structured object and its **text rendering** — §15.2 requires intervals
  to appear in the text, not only the JSON, so the model reasons over them rather than past them
- Packets stamped with `accountDataVersion`; all packets marked stale when it advances (§10.1)
- Escalation stated prominently in the packet when it occurred

**Out of scope.** Sending it anywhere.

**Done when.** A packet renders with sample sizes and intervals visible in the text; a version bump marks it
stale.

---

### D3 — Claude integration and tools

**Status:** Not started
**Depends on:** D2
**Design refs:** §18, §19

**Size:** L

**Goal.** The reasoner: a schema-constrained recommendation from Claude Fable 5, with tool access.

> **Before writing any Claude API code, load the `claude-api` skill.** Several API shapes here changed
> recently and a stale pattern will fail at runtime rather than compile time.

**Deliverables**
- `@anthropic-ai/sdk` client against the first-party API, credentials from Secret Manager
- The §18 tool surface. **Contract: every tool returns pre-aggregated evidence with uncertainty attached,
  never event-level or daily rows the model would have to sum**
- Structured output via `output_config.format` matching the §20.1 schema
- Prompt assembled per §19.3 caching order: *tools → system → account context → packet*, volatile last
- **Untrusted-content framing** around all ingested creative and commerce text (§17.3)
- **PII boundary enforced in the tool layer** (§17.2) — aggregates and customer *type* only, never identity
- `stop_reason` checked before reading content; server-side `fallbacks` configured (§19.1)
- Provenance recorded per §19.4

**Out of scope.** The job pipeline — D4. Guardrail validation — D5.

**Done when.** A real packet yields a schema-valid recommendation; `usage.cache_read_input_tokens` is
non-zero on a repeated call, proving the cache prefix is stable; a tool returning raw rows fails review.

**Notes for the planning agent.** §19.3 lists the Fable 5 constraints that will otherwise cost you a
debugging cycle: thinking is always on and the parameter must be omitted, `temperature` and `budget_tokens`
return 400, and there is no assistant prefill.

---

### D4 — Recommendation job pipeline

**Status:** Not started
**Depends on:** D3
**Design refs:** §16.1

**Size:** M

**Goal.** Generation as a job, because a synchronous call cannot survive the turn.

**Deliverables**
- API writes `recommendations/{id}` as `PENDING` and enqueues on Cloud Tasks
- Reasoner worker on **Cloud Run** consumes the job and writes the result back
- Progress states surfaced on the document for the client to observe
- Failure states recorded, not swallowed

**Out of scope.** The UI — D6.

**Done when.** A request returns immediately with an ID; the document transitions to a completed
recommendation; a worker failure leaves a legible error state rather than a stuck `PENDING`.

**Notes for the planning agent.** §16.1 has the reasoning: a Firebase Hosting rewrite times out at 60
seconds and a Fable 5 turn can exceed that. Do not route the model call through a Hosting rewrite — if you
add streaming later, SSE goes direct from Cloud Run.

---

### D5 — Guardrail validator

**Status:** Not started
**Depends on:** D3
**Design refs:** §20.2

**Size:** S

**Goal.** Guardrails enforced in code after the model returns — never delegated to the model.

**Deliverables**
- Post-model validation: max change percent, minimum spend and purchases, decision unit actually being the
  budget owner
- Violations rejected and downgraded to `INSUFFICIENT_DATA`
- **Every rejection logged with its reason** — §20.2 notes this log is itself a calibration signal for E3
- Confidence reduced after very recent major edits and for composite creatives

**Out of scope.** Meta writes — Phase F.

**Done when.** A synthetic over-limit recommendation is rejected and logged; a recommendation naming a
non-budget-owner is rejected.

---

### D6 — Web application

**Status:** Not started
**Depends on:** D4
**Design refs:** §17.1, §24

**Size:** L

**Goal.** The interface: ask a question, get a recommendation card, accept or reject.

**Deliverables**
- Firebase Auth; **all data served through the API, never direct client Firestore reads** (§17.1)
- Recommendation cards per §24: action, decision unit **with escalation stated when it occurred**, current
  and recommended value, confidence, reasons, risks, evidence
- `onSnapshot` subscription driving live status from `PENDING` to complete
- **Display rules from §24: never a ROAS without its sample size; Meta-attributed and Shopify-attributed
  figures always labelled and never merged**
- Data freshness timestamp **and reporting timezone**; attribution coverage shown
- Accept / reject, persisted

**Out of scope.** Conversational follow-up and creative previews — these arrive with Phase F.

**Done when.** A question asked in the UI produces a card without a page reload; an escalated answer states
what it escalated from and why; no ROAS renders without a sample size.

---

# Phase E — Proof it works

Do this before adding decision types. The second one should be built on something measured.

---

### E1 — Backtest harness

**Status:** Not started
**Depends on:** D5, §23 archive populated
**Design refs:** §21.2, §23

**Size:** L

**Goal.** Replay history to find out whether the recommendations are any good, without waiting a year for
the learning loop.

**Deliverables**
- Point-in-time reconstruction from the raw archive: rebuild features as of date T using **only** data
  available at T
- Generate the recommendation that would have been made at T
- Compare against what actually happened afterward
- **Baseline comparison:** beat a naive "scale whatever had the highest recent ROAS" strategy (§29 criterion
  10)
- Results stored in `backtestRuns`

**Out of scope.** Automatic retraining from backtest results.

**Done when.** A backtest runs over available history and reports both strategies' outcomes; leakage tests
prove no post-T data enters the reconstruction.

**Notes for the planning agent.** Leakage is the failure mode here and it is silent — a backtest that
accidentally sees the future will look excellent. Make the point-in-time constraint structural (filter at
the archive read boundary), not a convention that later code can forget.

---

### E2 — Outcome evaluation

**Status:** Not started
**Depends on:** D5
**Design refs:** §21.1

**Size:** M

**Goal.** Evaluate what happened after an accepted recommendation — on evidence, not the calendar.

**Deliverables**
- `EVALUATE_RECOMMENDATION_OUTCOME` task triggered **when `recheckConditions` are met** (§21.1) —
  never on a fixed number of days
- **Comparison against the shrunk baseline** (§15.3), not the raw one
- Classification stored per §21.1

**Out of scope.** Feeding outcomes back into prompts — that is account memory, Phase F.

**Done when.** A recommendation with unmet recheck conditions is not evaluated; one that meets them is
evaluated against its shrunk baseline.

**Notes for the planning agent.** §21.1 exists because v1 evaluated on `roas3d`, and at this volume three
days is roughly two purchases. If you find yourself adding a time-based fallback trigger, re-read it —
a recommendation that never accumulates enough evidence to judge should stay unjudged.

---

### E3 — Confidence calibration

**Status:** Not started
**Depends on:** E1, E2
**Design refs:** §29

**Size:** M

**Goal.** Find out whether stated confidence means anything.

**Deliverables**
- Brier score over recommendations with evaluated outcomes
- Calibration curve: do 0.8-confidence recommendations succeed roughly 80% of the time? (§29 criterion 11)
- Guardrail rejection rate tracked over time (§29 criterion 12)
- A small internal dashboard or report — this is for you, not for end users

**Out of scope.** Automatically adjusting model confidence. Observe first.

**Done when.** Calibration reports over backtest and live outcomes together.

---

# Phase F — Deferred

Specified in the design, deliberately not planned in detail yet. Plan these once Phase E reports something
trustworthy.

| Area | Design ref | Why deferred |
|---|---|---|
| Creative intelligence — download, OCR, transcripts, vision analysis, embeddings, similarity, fatigue | §11.2 | The expensive half. Batches make it cheap; nothing before D6 needs it |
| Remaining decision types — pause/hold, funnel diagnosis, creative refresh | §27 | Build the second one on a measured foundation, not an assumed one |
| Account-level learned patterns | §21.3 | Needs outcome volume that does not yet exist |
| Historical analogue engine | §15.4 | Needs minimum-N; ~10–20 events/year means this may be a year out |
| Meta write path, approval workflow, rollback, audit | §28 Slice 6 | Read-only until the recommendations have earned trust |
| Shopify Web Pixel for first-party funnel events | §7.2 | Meta action counts cover v1 |

---

## Open questions

| # | Question | Blocks | Resolve by |
|---|---|---|---|
| 1 | Do the live UTM tags carry `{{ad.id}}` or an ad **name**? | B7, and a re-tagging pass before backfill if it is names | Inspect one live ad's destination URL — do this at the start of B7, or earlier |

**Resolved.** The Anthropic org's data retention setting permits Claude Fable 5. A live one-token call
(`model: claude-fable-5`, `max_tokens: 1`) during A0 returned normally (`stop_reason: "max_tokens"`) rather
than a 400, confirming the org is not on zero data retention. D3 can proceed without a retention change.

**Resolved.** Historical Shopify order access no longer depends on `read_all_orders` approval. A Matrixify
export of the store returned ~22.6K orders — full history, well beyond the 60-day API window — so B5's
historical backfill is seeded from a one-time Matrixify CSV import instead (see B5). `read_all_orders` is not
requested; `read_orders` covers everything ongoing, since webhooks and the 14-day/60-day reconciliation
windows never need to look further back than the rolling 60-day range that scope already grants. Webhook
delivery for cancellations/refunds on orders older than 60 days was evaluated and is a non-issue for this
account — orders are not cancelled or refunded past that age.

Everything else in the design is settled. §2 records the assumptions the plan is sized against; if any of
them moves by an order of magnitude, revisit C2 (full recompute), C3 (thresholds) and §22 (warehouse).
