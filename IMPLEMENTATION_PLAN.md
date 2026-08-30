# Implementation Plan

**Design reference:** `meta_ads_genai_recommendation_system_design_v2.md` (cited below as **§n**)
**Structure:** 27 steps across five phases. Each step is sized to be planned and implemented in one agent
session — except A0, which is mostly yours (see below). (C5 was added after B2, at the user's direction, and
is not derived from the design document — see that step for why.)

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
                      ├─ C5 calendar/seasonality
                      └─ C2 features ◀── consumes C5
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

**Status:** Done — `npm run check` (typecheck + lint + format:check + test) passes clean; the
Firebase emulator suite (Firestore, Auth, Functions) starts cleanly with `npm run emulators`,
verified locally. See Notes below for two things later steps need to know: a Java prerequisite
for the emulators, and that `functions/` is its own npm package.
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

**Notes from implementation:**

- **Layout as built:** `/functions`, `/services/{ingest,analytics,evidence,reasoner}`,
  `/shared/{schema,canon}`, `/web` are empty except for `.gitkeep` (and, for `/functions`, the
  minimal package described below). `/test` holds one real file, `test/sanity.test.ts` — the
  "trivial passing test" deliverable.
- **`/functions` is a separate npm package, not part of the root TS project.** Firebase requires
  Cloud Functions source to be self-contained (its own `package.json`, its own `node_modules`,
  its own build). It has its own `tsconfig.json` (CommonJS, `outDir: lib`) and depends on
  `firebase-admin` + `firebase-functions` — added now (not business logic, just what the
  Functions emulator needs to load the codebase without erroring) with `functions/src/index.ts`
  intentionally empty (`export {}`). Run `npm --prefix functions install` after `npm install` at
  the root. B1 is the first step that puts real code in `functions/src/index.ts`.
- **Root `tsconfig.json` needed `allowImportingTsExtensions: true` + `noEmit: true`.**
  `scripts/verify-credentials.ts` (A0) imports `./config.ts` with an explicit `.ts` extension,
  which TS rejects by default even under `moduleResolution: "Bundler"`. This was never caught
  before because A0 had no typecheck script. Fixed by adding those two compiler options — no
  change to A0's code or its import. `npm run verify-credentials` still passes on all three
  credentials (confirmed live).
- **Path aliases** (`@shared/*` → `shared/*`, `@services/*` → `services/*`) are defined once in
  `tsconfig.json` `paths` and mirrored in `vitest.config.ts`'s `resolve.alias`. Verified working
  end-to-end for `tsc --noEmit`, Vitest, and `tsx` (all three resolve `tsconfig.json` paths
  natively — no extra resolver package needed) using throwaway probe files, since deleted per
  the "no placeholder modules" instruction.
- **The Firestore/Functions emulators require a JVM on `PATH`; this machine didn't have one.**
  `java -version` failed outright. A `winget install` of a JDK requires interactive UAC
  elevation, which isn't available non-interactively — so this was verified instead with a
  portable (no-installer) Temurin JDK 21 zip, extracted outside the repo and pointed to via
  `JAVA_HOME`/`PATH` for the verification run only; nothing was installed system-wide or added
  to the repo. **Whoever runs `npm run emulators` next needs a real Java install** (`winget
  install Microsoft.OpenJDK.21`, accepting the elevation prompt interactively, or any JDK 11+ on
  `PATH`) — this is now called out in `README.md` under Prerequisites. `npm run check` itself
  has no Java dependency and is unaffected.
- **`functions/package.json` pins `engines.node: "22"`** (a current Cloud Functions Gen 2
  runtime) even though the local dev machine runs Node 24 — the emulator just logs a harmless
  mismatch warning and uses the host's Node anyway. Revisit the pinned version at whichever step
  first deploys `functions/` for real, since Cloud Functions' supported runtime list moves
  independently of local Node.
- **`npm audit`** reports 8–13 moderate/high findings, all transitive through
  `google-gax`/`teeny-request` pulled in by `@google-cloud/secret-manager` (A0) and
  `firebase-admin`/`firebase-tools` (A1) — no direct dependency of ours. Not addressed here;
  flagging for whoever next touches dependency versions.
- **`firestore.rules`** is a minimal blanket deny-all, matching §17.1's requirement but with none
  of A2's per-collection detail or rules tests — treat it as a bootstrap the emulator needs to
  start, not as A2's deliverable already done.
- **Ambiguity surfaced, resolved pragmatically:** the "no placeholder modules" instruction is in
  tension with "emulator suite for … Functions" — an empty `/functions` directory (just
  `.gitkeep`) cannot be loaded by the Functions emulator at all (no `package.json` to find a
  runtime with). Resolved by treating `functions/` as necessary infrastructure scaffolding (an
  empty, zero-logic entrypoint) rather than a placeholder for future business logic, since
  Firebase's own tooling requires the package to exist as a precondition for the emulator to run
  — distinct from the services/shared directories, which genuinely need nothing more than
  `.gitkeep` at this stage.
- **⚠️ Orchestrator note (added at A1 review, unresolved by design — B1 owns the fix).**
  `functions/` as scaffolded cannot import `/shared` or `/services`: it is CommonJS
  (`module: "CommonJS"`, no `"type": "module"`) while the root project is ESM; it declares no
  `paths`, so `@shared/*` does not resolve inside it; and its `rootDir: "src"` means `tsc` will
  refuse to compile any file outside `functions/src`. This is fine through A2–A4, which are all
  root-project code, but **B1 is the first step to put real logic in `functions/` and it depends
  on A2's schema and repository layer.** B1 must resolve this deliberately — the plausible
  options are making `functions/` ESM to match, or building `/shared` to a package that
  `functions/` depends on, or having functions be a thin deploy shim that imports a bundled root
  artifact. Pick one with the deploy story in mind; do not paper over it with relative
  `../../shared` imports, which defeat `rootDir` anyway.

---

### A2 — Firestore schema, security rules and data access layer

**Status:** Done — `npm run check` passes clean; `npm run test:integration` (Firestore emulator,
`firebase emulators:exec`) passes 103/103: 99 rules-deny tests across every collection in §8, plus 4
emulator-backed `upsertWithVersionGuard` tests (in-order, out-of-order, equal-version, a concurrency
race). See Notes below for the version-guard API shape and several ambiguities later steps should know
about.
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

**Notes from implementation:**

- **Layout as built.** `shared/schema/{common,meta,shopify,creative,features,decisions,sync,ai,settings,index}.ts`
  — one file per §8 collection group, barrel-exported from `index.ts`. `shared/firestore/{client,collections,
  repository,versionGuard,index}.ts` — the data-access layer. **`shared/firestore/` is a new subdirectory not
  named in §0.2's layout table** (which lists only `/shared/schema` and `/shared/canon`); A2's deliverables
  needed a home for the repository layer, key helpers and version guard that is neither "document types/zod
  validators" (schema) nor "reporting canon" (canon, and not A2's to touch — that's A3). If this should live
  somewhere else instead, it's a rename, not a rewrite. Test files sit next to what they test (`*.test.ts` for
  pure unit tests, `*.emulator.test.ts` for emulator-backed ones), plus `test/firestore.rules.emulator.test.ts`
  for the rules suite.
- **The version-guard API** (`shared/firestore/versionGuard.ts`):
  - `compareVersions(incoming: Date, current: Date | undefined): "no-existing-doc" | "newer" | "equal" | "older"`
    and `decideVersionGuard(...)` are pure — no Firestore — and are what "in-order/out-of-order/equal-version"
    actually means. Fully unit-tested without an emulator.
  - `upsertWithVersionGuard<T>({ db, collectionName, docId, incoming, schema, getUpdatedAt?, onRejected? })`
    wraps that decision in one Firestore transaction (read-compare-write), so two concurrent writers for the
    same doc can't both see "no existing doc". Returns `{action:"written", comparison, data}` or
    `{action:"rejected", comparison:"older", rejection}`. **Only `older` is rejected — `equal` writes are
    accepted.** This was a deliberate call, not an oversight: every sync task must be idempotent (§10.2), and
    a retried task resubmitting the same payload at the same source timestamp must succeed, not fail.
  - `db` is typed as a narrow structural interface (`VersionGuardFirestoreLike`/`VersionGuardTransactionLike`
    — just `collection().doc()` and `runTransaction(tx => {get, set})`), not the real `Firestore` type. A real
    `Firestore` instance satisfies it automatically (no adapter/cast needed at call sites); this is what let
    the in-order/out-of-order/equal/rejection-logging matrix get fully unit-tested against a hand-rolled fake
    in `versionGuard.test.ts`, independent of `versionGuard.emulator.test.ts`'s real-emulator coverage of the
    same cases.
  - `onRejected` fires **after** the transaction commits, exactly once — never inside the transaction body,
    which Firestore may retry on write contention; a side effect there could otherwise fire more than once
    per logical rejection. A rejection is always logged via `console.warn` regardless of `onRejected` — the
    debuggable minimum until B1 wires rejections into `syncRuns` for real (see next point).
  - **Callers must supply `db`, `collectionName`, `docId` and a schema whose parsed type exposes a
    `sourceUpdatedAt: Date` field** (or pass `getUpdatedAt` to read a differently-named field). Every
    version-guarded schema in `shared/schema` (`metaInsightsDailySchema`, `shopifyOrderSchema`,
    `shopifyOrderLineSchema`, `shopifyRefundSchema`) already has one.
- **Deterministic keys** live in `shared/firestore/collections.ts` (`COLLECTIONS` map + a helper function per
  composite key: `metaInsightsDailyKey`, `metaEntitySnapshotKey`, `metaChangeEventKey`, `shopifyOrderLineKey`,
  `shopifyRefundKey`, `recommendationOutcomeKey`, `syncStateKey`). Entities keyed directly by their own
  platform ID (`metaCampaigns/{campaignId}`, `shopifyOrders/{shopifyOrderId}`, `creativeAssets/{assetHash}`,
  etc.) need no helper — just use the ID. A handful of collections generate their own ID at write time
  (`recommendations`, `syncRuns`, `decisionPackets`, `creativeFamilies`, `backtestRuns`, `aiConversations`,
  `accountMemory`) — no helper was invented for those; whichever step owns that ID scheme should add one here
  rather than hand-building it inline, to keep this file the single place document IDs are decided.
- **Ambiguities in the design resolved, and how:**
  1. **§9.5's "source's own `updated_at`" is unambiguous for Shopify but Meta's Insights API has no per-row
     version field.** Resolved: for `metaInsightsDaily`, `sourceUpdatedAt` is *our own fetch/reconciliation-run
     timestamp*, not something Meta returns. This still delivers what §9.5 actually protects against — a slow
     retry finishing after a newer scheduled fetch must not clobber it — without inventing a field Meta
     doesn't provide. Documented in both `versionGuard.ts`'s module comment and `metaInsightsDailySchema`'s.
  2. **§12 computes metrics "at ad, ad set, campaign, creative family and account level" (five levels) but
     §8 lists only three feature collections** (`adFeatures`, `adsetFeatures`, `accountFeatures`) — no
     `campaignFeatures` or family-level features collection. Resolved pragmatically, not definitively: one
     generic `entityFeaturesSchema` (with an `entityType` discriminator) backs all three named collections, so
     C2 can decide later — store campaign features in `adsetFeatures` keyed by campaign ID with
     `entityType:"CAMPAIGN"`, put family metrics directly on `creativeFamilies` docs (§11.3 already lists them
     as fields there), or add a fourth collection — without this schema forcing the answer. **C2 needs to
     actually decide this**; it's flagged, not solved.
  3. **§14's evidence JSON uses flat window-suffixed field names** (`roas28d`, `roas28dShrunk`, `cpa28d`)
     but that's the shape of the assembled *evidence object*, not necessarily the feature-store document.
     `entityFeaturesSchema` instead nests metrics under `windows: {"7d"|"14d"|"28d"|"56d": {...}}`
     (`z.partialRecord`) to avoid hand-writing ~20 §12 metrics four times over. Flattening this into §14's
     shape is a small mechanical step for D1; the reverse would not have been. If C2 lands on the flat shape
     instead, that's a schema revision this file's comment already anticipates, not a design violation.
  4. **A3's own spec claims "settings/ document schema" as ITS deliverable, but A2's spec says to type every
     collection in §8, and `settings/` is one of them.** Resolved: A2 defines only the four reporting-canon
     fields §5 already gives verbatim (unambiguous, no judgment call needed) and fixes the key convention
     (`settings/{accountId}`, the real Meta ad account ID — not a magic singleton string, for consistency with
     every other level). A3 owns the loader, the throw-on-absence/invalid behaviour, and any extension (model
     config §19.2, statistical thresholds §15.1) — extend `reportingCanonSettingsSchema` with `.extend(...)`
     rather than replacing it.
  5. **`aiConversations`/`accountMemory`** have no step in this plan claiming them as an explicit deliverable
     yet (§21.3 describes them only briefly; account memory is Phase F per the deferred-work table). Typed as
     thinly as the design text supports, deliberately not embellished.
- **Composite indexes** (`firestore.indexes.json`) are a starting set for the query patterns clearly implied
  by the design — `metaInsightsDaily` by (adId|adsetId|campaignId, date), `metaChangeEvents` by (entityId,
  field, detectedAt desc) for §13's `hoursSinceLast*` family, `shopifyOrders` by (customerId, createdAt) for
  B5's new-vs-repeat derivation, `recommendations` by (status, createdAt desc), `syncRuns` by (taskType,
  startedAt desc). JSON has no comment syntax, so the rationale for each lives in a comment in
  `shared/firestore/collections.ts` instead of in the index file itself. Not exhaustive — extend as real
  queries land; a missing index fails loudly in the emulator/console with a direct link to add it.
- **`firestore.rules` is unchanged from A1's blanket `{document=**}` deny** — that already covers every
  collection identically, so there was no per-collection detail to add (§17.1 itself says as much). What A2
  added is the proof: `test/firestore.rules.emulator.test.ts` asserts deny-read and deny-write, for both an
  unauthenticated and an authenticated client, against every collection in `COLLECTIONS` (24 collections × 4
  assertions = 96 tests, plus 3 more: a collection-list denial, an arbitrary-unlisted-collection denial, and a
  count-matches-§8 guard against this test file silently drifting from `collections.ts`). All pass against
  the real emulator.
- **Java/emulator status: the JVM arrived mid-task.** It was not on `PATH` when this step started (verified
  via both the Bash tool's git-bash and PowerShell); a JDK install completed partway through and was
  confirmed working (`java -version` succeeds once `PATH` is refreshed — a shell open before the install needs
  that refresh explicitly, a fresh one does not). All emulator-backed tests were then actually run, not just
  written: `npm run test:integration` passes 103/103. Doing so caught one real bug before it could reach
  another step — `versionGuard.emulator.test.ts`'s own local test schema initially used a bare `z.date()`
  instead of `shared/schema/common.ts`'s `firestoreTimestamp`, which failed against a real Firestore
  `Timestamp` on read (the fake in `versionGuard.test.ts` never round-trips through real Firestore, so that
  mismatch couldn't have shown up there) — fixed, then re-verified green. **Anyone hitting `ZodError: expected
  date, received Timestamp` should suspect this same mismatch: schemas reading real Firestore documents must
  use `firestoreTimestamp`, not bare `z.date()`.**
- **The emulator-test split**: `*.emulator.test.ts` files are excluded from `vitest.config.ts` (used by
  `npm run test` / `npm run check`) and picked up only by `vitest.emulator.config.ts` (used by
  `npm run test:integration`, which wraps it in `firebase emulators:exec` so `FIRESTORE_EMULATOR_HOST` is set
  and torn down automatically). `tsc` still typechecks emulator test files either way (they're under
  `shared/**` / `test/**`, which `tsconfig.json` already includes), so a broken emulator test still fails
  `npm run check` at the typecheck stage even when it can't run — it just won't fail at the test stage.
- **Package additions:** `firebase-admin` and `zod` moved from transitive to direct `dependencies`;
  `@firebase/rules-unit-testing` added as a `devDependency`. `npm audit` now reports 15 vulnerabilities
  (13 moderate/1 high/1 critical), up from A1's 8–13 — same story as A1: all transitive through
  `google-gax`/`teeny-request`/`protobufjs` pulled in by `firebase-admin` and `@firebase/rules-unit-testing`,
  not a direct dependency of ours. Not addressed here; still flagged for whoever next touches dependency
  versions.
- **⚠️ Orchestrator note (added at A2 review; accepted as-is, but know the failure mode).**
  `upsertWithVersionGuard` calls `schema.parse(snap.data())` on the **stored** document inside the
  transaction, though the only value it needs from it is `sourceUpdatedAt`. Consequence: a stored document
  that no longer satisfies the current schema makes every subsequent upsert to that document throw, rather
  than being overwritten by the fresher data that would have fixed it. Adding an *optional* field is safe
  (zod strips unknowns); adding a **required** field to a collection that already holds documents is not,
  and would break B3/B5/B6 writes across the whole collection at once. Either add new fields as optional
  with a default, or relax this to read just the timestamp. Verified at review: `npm run check` green,
  `npm run test:integration` 103/103 against a real emulator.

---

### A3 — Reporting canon and settings

**Status:** Done — `npm run check`'s typecheck/lint/format/unit-test stages all pass for this step's own
files (`shared/canon/**`); the repo-wide `npm run check` is currently blocked by an unrelated, in-progress
A4 typecheck error in `shared/secrets/client.ts` — see Notes below. `npm run test:integration` (Firestore
emulator) passes 107/107 (the 103 from A2 plus 4 new `loader.emulator.test.ts` cases). See Notes below for
the canon API, the day-boundary/DST test results, and ambiguities resolved.
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

**Notes from implementation:**

- **Layout as built.** `shared/canon/{reportingDay,money,settings,loader,index}.ts`, plus
  `reportingDay.test.ts`, `money.test.ts`, `loader.test.ts` (pure) and `loader.emulator.test.ts`
  (emulator-backed, following A2's `*.emulator.test.ts` convention). No dependencies were added —
  `Intl.DateTimeFormat` with a `timeZone` option does all the IANA/DST work natively.
- **The canon API, for C1/B2/B3/B5 and later callers:**
  - `loadReportingCanon(options?: { db?: Firestore; accountId?: string }): Promise<CanonSettings>` —
    the ONLY way to get the canon. Defaults `db` to `shared/firestore/client.ts`'s `getDb()` and
    `accountId` to `scripts/config.ts`'s `META_AD_ACCOUNT_ID`, so a plain `await loadReportingCanon()`
    is normally all a caller needs. **Throws** (never defaults) if `settings/{accountId}` does not
    exist, or exists but fails `canonSettingsSchema`. Cached per `accountId` after the first
    successful load — call it as often as you like, it will not re-read Firestore, and per A3's
    "treat these as write-once values" it deliberately will NOT pick up a live edit to the
    document (proved by `loader.emulator.test.ts`'s "is loaded once" case). A failed load is NOT
    cached, so a genuinely transient error (e.g. emulator not yet up) can be retried. Test-only:
    `resetReportingCanonCacheForTests()` clears the cache between test cases — never call it from
    production code.
  - `CanonSettings` (`shared/canon/settings.ts`) = A2's four §5 fields (`accountId`,
    `reportingTimezone`, `reportingCurrency`, `attributionWindow`, `purchaseActionType`) plus a
    nested `modelConfig` object with §19.2's six fields verbatim
    (`recommendationProvider`/`recommendationModel`/`creativeReasoningModel`/
    `backgroundCreativeTaggingModel`/`taggingUsesBatchApi`/`effort`). Built via
    `reportingCanonSettingsSchema.extend({ modelConfig: modelConfigSchema })`, per A2's note —
    A2's original four-field schema and the `settings/{accountId}` key convention are untouched.
    **Nobody has written a real `settings/{accountId}` document yet** — that's an operational step
    for whoever runs this system for real (or an A0-style follow-up), not something this step does
    (Out of scope: "Applying the canon to real data"). Every later step that calls
    `loadReportingCanon()` against a real environment before that document exists will get the
    loud "no settings/{accountId} document exists" throw by design — that is not a bug to route
    around, it is the point of §5.
  - `toReportingDay(instant: Date, timezone: string): ReportingDay` and its inverse
    `reportingDayToUtcRange(day: ReportingDay, timezone: string): { startUtc: Date; endUtcExclusive: Date }`
    (half-open `[startUtc, endUtcExclusive)`) in `shared/canon/reportingDay.ts` — **the only
    sanctioned way** to move between an instant and a reporting day, per this step's spec. C1 calls
    `toReportingDay` on every Meta/Shopify timestamp to place it on a shared day; anything that
    needs to query "all data for reporting day D" (B3 reconciliation, C2 windowing, etc.) calls
    `reportingDayToUtcRange` to get the UTC bounds to query against. Both throw on an invalid IANA
    zone name or a malformed day string — never silently fall back to UTC or the host's local zone.
  - Money helpers in `shared/canon/money.ts`, built on `shared/schema/common.ts`'s existing
    `moneyMinorUnits` zod schema/`Money` type (A2): `makeMoney`, `zeroMoney`, `addMoney`,
    `subtractMoney`, `negateMoney`, `sumMoney`, `compareMoney` (all throw on a currency mismatch —
    money is never silently mixed across currencies), plus `parseDecimalToMinorUnits(decimalString,
    currency)` and its inverse `formatMinorUnitsAsDecimal(money)`. The parse function is the one
    B5/C1 should reach for when turning a Meta/Shopify decimal-string amount (e.g. `"199.00"`) into
    stored minor units — it works via `BigInt` on the string's digits, never
    `parseFloat(x) * 10^n`, which is the expression that produces `1998.9999999999998` for
    `19.99 * 100` in plain JS. A small ISO-4217 minor-unit-exponent override table handles
    zero-decimal (JPY, KRW, ...) and three-decimal (BHD, KWD, ...) currencies; everything else,
    including INR, defaults to 2.
- **Day-boundary and DST test results (all passing, `shared/canon/reportingDay.test.ts`):**
  - Asia/Kolkata (the account's actual §5.1 timezone, no DST): `2026-08-30T18:29:59Z` →
    `"2026-08-30"`, and one second later `2026-08-30T18:30:00Z` → `"2026-08-31"` — the exact
    midnight tick-over, either side. `reportingDayToUtcRange("2026-08-30", "Asia/Kolkata")` inverts
    to exactly `[2026-08-29T18:30:00Z, 2026-08-30T18:30:00Z)`, a flat 24h span.
  - **DST test, per this step's Done-when line**, using America/New_York (verified against Node's
    own tzdata during planning, not asserted from memory): the 2026 US spring-forward is
    2026-03-08 (EST → EDT), fall-back is 2026-11-01 (EDT → EST).
    `reportingDayToUtcRange("2026-03-08", "America/New_York")` returns
    `[2026-03-08T05:00:00Z, 2026-03-09T04:00:00Z)` — **23 real hours**, not 24, because
    `startUtc` is computed under the still-active EST offset (−05:00) and `endUtcExclusive` under
    the now-active EDT offset (−04:00) that took effect at 2am local earlier that same day.
    Symmetrically, `reportingDayToUtcRange("2026-11-01", "America/New_York")` returns a
    **25-hour** span. A third test confirms `toReportingDay` and `reportingDayToUtcRange` agree
    with each other on both sides of the exact transition instant. All of this fails immediately
    under a hardcoded-offset (or "compute the offset once per call" without re-deriving it for
    the end boundary) implementation — that's deliberately what makes it a real DST test rather
    than a decorative one.
  - `npx vitest run shared/canon` → **36/36 passed** (money 19, loader 7, reportingDay 10).
    Full `npm run test` → **140/140 passed**. `npm run test:integration` →
    **107/107 passed** (103 from A2 + 4 new `loader.emulator.test.ts` cases, run against the real
    Firestore emulator with `FIRESTORE_EMULATOR_HOST` set, not mocked).
- **§5 ambiguity resolved:** whether §19.2's model config belongs inside the same
  `settings/{accountId}` document as the four §5 fields, or is separate app config outside
  Firestore entirely. Resolved per A2's explicit steer ("extend `reportingCanonSettingsSchema`
  with `.extend(...)`, ... model config §19.2") — it's the same document, nested under a
  `modelConfig` key. A second, smaller ambiguity: §19.3 documents `output_config.effort` as the
  reasoning-depth control but the design never enumerates its legal values, and D3's own spec
  warns Fable 5's API "changed recently." `modelConfigSchema.effort` is therefore a non-empty
  `z.string()`, not a guessed `z.enum([...])` — tightening it to match the real SDK type belongs to
  D3, the first step that actually calls the API.
- **§15.1 statistical thresholds were deliberately NOT added here**, despite A2's note flagging them
  as a plausible `.extend(...)` target alongside model config. This step's own Deliverables list
  only names "Model configuration per §19.2"; §15.1 ("Minimum purchase floors per window,
  configurable") is C3's explicit deliverable. C3 should use the same `.extend(...)` mechanism on
  `canonSettingsSchema` (not `reportingCanonSettingsSchema` — extend the already-extended schema so
  A3's `modelConfig` addition also stays intact) when it gets there.
- **⚠️ Orchestrator note: repo-wide `npm run check` is currently red, but not because of this
  step.** `shared/secrets/client.ts` — A4's Secret Manager access wrapper, built concurrently with
  this step — has two live `tsc` errors (`SecretManagerServiceClient` not assignable to a narrower
  `SecretManagerClientLike`). Confirmed by running `npx tsc --noEmit -p tsconfig.json` in isolation:
  the only errors reported are in that file; `shared/canon/**` typechecks, lints (`npx eslint
  shared/canon/`) and formats (`npx prettier --check shared/canon/`) clean, and the full
  `npm run test` (140/140) and `npm run test:integration` (107/107) both pass — including
  `shared/secrets/client.test.ts`'s own unit tests, which apparently mock around the type mismatch
  rather than exercising the real client. Whoever finishes A4 should re-run `npm run check` once
  `shared/secrets/client.ts` is done; nothing in A3 needs to change for that to go green.

---

### A4 — API clients, secrets and rate limiting

**Status:** Done — `npm run check` passes clean (typecheck, lint, format, 177/177 unit tests, including
this step's own 86 new tests). `npm run verify-a4-clients` (new script, this step's live-verification
deliverable) passes against real credentials: `MetaClient.checkAuth()` and `ShopifyClient.checkAuth()`
both succeed live. See Notes below for the client APIs, the BUC/leaky-bucket throttle design, and what
Phase B needs to know.
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

**Notes from implementation:**

- **Layout as built.** `shared/secrets/{names,client,index}.ts` — the Secret Manager wrapper.
  `services/ingest/{health,index}.ts` plus `http/{errors,sleep,retry}.ts`, `meta/{buc,errors,client}.ts`,
  `shopify/{cost,errors,client}.ts`, each with a co-located `*.test.ts`. `scripts/verify-a4-clients.ts` is
  this step's live-verification script (new `npm run verify-a4-clients`), separate from A0's
  `scripts/verify-credentials.ts`, which is untouched. No new dependencies — `@google-cloud/secret-manager`
  was already a direct dependency from A0; everything else (retry, BUC/cost parsing, HMAC for
  `appsecret_proof`) is hand-rolled on `fetch`/`node:crypto`, both native to Node 22+. `package-lock.json`
  is unchanged.
- **Secrets wrapper** (`shared/secrets/client.ts`): `getSecret(name, opts?)` resolves a secret's latest
  version by the exact SETUP.md §5 names (`shared/secrets/names.ts`'s `SECRET_NAMES` — import this, never a
  string literal), trims it, throws loudly if missing/empty, and caches successful reads in memory per
  `${projectId}/${name}` (never on disk) so a long-running Cloud Run process or a sync task making many
  calls doesn't re-hit Secret Manager per request. Unit-tested against a hand-injected fake client
  (`SecretManagerClientLike`, a narrow structural interface a real `SecretManagerServiceClient` satisfies
  automatically — same pattern A2 used for `versionGuard.ts`'s Firestore seam), so no live credentials or
  ADC are needed for `npm run test`.
- **Config reuse, not duplication.** `scripts/config.ts` (A0/A1's existing home for `GCP_PROJECT_ID`,
  `META_API_VERSION`, `META_AD_ACCOUNT_ID`, `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_API_VERSION`) is imported
  directly by relative path from `services/ingest/meta/client.ts` and `services/ingest/shopify/client.ts`
  (`../../../scripts/config.ts`) — the same convention A2's `shared/firestore/client.ts` already
  established for `GCP_PROJECT_ID`. Neither `scripts/config.ts` nor `scripts/verify-credentials.ts` was
  modified.
- **The BUC header parser and backoff decision are pure, standalone functions** (`services/ingest/meta/
  buc.ts`), exactly as the step spec asked — not folded into the request path. `parseBucHeader(headerValue)`
  parses `X-Business-Use-Case-Usage` (JSON keyed by ad-account/business ID → array of `{call_count,
  total_cputime, total_time, estimated_time_to_regain_access}` entries — real Meta shape, not guessed),
  taking the max usage percentage across every field and every entry/key, and never throwing — a malformed
  header logs a warning and returns `null` rather than breaking the request it arrived on.
  `decideBucBackoff(usage, opts?)` is the pre-emptive decision: `null` (no data yet) → no throttle; ≥90%
  (configurable) → wait `cooldownMs`; ≥95% → `cooldownMs*2`; ≥100% → `cooldownMs*4`; and if Meta reports
  `estimated_time_to_regain_access > 0` (already throttling — reactive at that point, but the most reliable
  number available), wait that many minutes, capped at 15. `MetaClient` calls `decideBucBackoff` with the
  *previous* response's usage **before** sending the next request — that's what makes it pre-emptive rather
  than reactive to a 613/17/32/4 rate-limit error. Tested with 27 cases across `buc.test.ts` +
  `client.test.ts` against synthetic header strings: missing/empty header, malformed JSON, non-object JSON,
  single/multiple entries, single/multiple top-level keys, max-across-fields, threshold boundaries (89%
  doesn't throttle, 90% does, 95%/100% wait longer), custom threshold, `estimated_time_to_regain_access`
  with and without its 15-minute cap, and (in `client.test.ts`) that a real second `get()` call actually
  sleeps when the first response reported high usage, and does not sleep on the very first call.
- **Shopify's leaky-bucket cost throttle mirrors the same shape** (`services/ingest/shopify/cost.ts`):
  `parseShopifyCost(extensions)` reads `extensions.cost.throttleStatus` (`maximumAvailable`,
  `currentlyAvailable`, `restoreRate`), returning `null` (never throwing) if any required field is
  missing/non-numeric or `restoreRate <= 0`. `decideShopifyThrottle(cost, { nextRequestEstimatedCost?,
  safetyMarginPoints? })` waits `ceil((needed - available) / restoreRate * 1000)` ms when the bucket doesn't
  have enough for the next query's estimated cost — **the caller supplies the cost estimate** per query
  (`ShopifyClient.query(query, variables, { estimatedCost })`), defaulting to a conservative 50 points,
  since only Phase B knows what a given query actually costs; A4 has no resource-specific knowledge to
  estimate it. 15 tests cover parsing (missing extensions, missing cost, incomplete/zero-rate throttleStatus,
  defaulted `actualQueryCost`) and the wait decision (enough points → no wait, insufficient → wait sized to
  restore rate, safety margin, empty bucket).
- **Retry (`services/ingest/http/retry.ts`)** is one generic `withRetry(fn, opts)`, shared by both clients,
  full-jitter exponential backoff (`computeBackoffDelayMs`, unit-tested for its bounds independent of the
  async loop) capped at `maxDelayMs` (default 30s, 5 attempts default). The retryable/terminal split is
  `ApiError.retryable` (`services/ingest/http/errors.ts`) — one error class parametrized by `kind`
  (`unauthorized | rate_limited | server_error | client_error | network`) and `retryable`, rather than a
  class hierarchy, since `retryable` is the only thing the retry loop actually branches on. A non-`ApiError`
  (e.g. a raw network `TypeError` from `fetch`) defaults to retryable. 9 tests cover: first-try success (no
  sleep), retry-then-succeed with correct attempt/delay bookkeeping via `onRetry`, immediate bail on a
  terminal `ApiError` (`unauthorized` and `client_error` both), default-retryable treatment of a
  non-`ApiError`, exhausting `maxAttempts` and re-throwing the last error, and a custom `isRetryable`
  override.
- **Error classification is platform-specific** (`meta/errors.ts`, `shopify/errors.ts`), both producing
  `ApiError`. Meta: code 190 (OAuthException) → `unauthorized`/terminal; codes 4/17/32/613 (Meta's
  documented rate-limit-error-code family: app-level, user-level, page-level, custom/ads limits) →
  `rate_limited`/retryable; HTTP 401/403 → `unauthorized` fallback; HTTP 429 → `rate_limited` fallback; 5xx →
  `server_error`/retryable; anything else → `client_error`/terminal (fail fast rather than retry a request
  that will never succeed). These code lists are deliberately not exhaustive — a comment in `meta/errors.ts`
  says so — extend them if Phase B observes a code that should be classified differently, erring terminal for
  anything unrecognized. Shopify: GraphQL `extensions.code` of `THROTTLED` → `rate_limited`/retryable;
  `ACCESS_DENIED`/`UNAUTHENTICATED` → `unauthorized`/terminal; HTTP 401/429/5xx as fallbacks matching Meta's
  pattern; an unrecognized GraphQL error (e.g. a field/validation error) → `client_error`/terminal. 19 tests
  total across both files.
- **`MetaClient`/`ShopifyClient` are transport-only** — `get(path, params)` / `query(gql, variables, opts)`
  return the parsed response body verbatim with no normalization, matching the step's explicit scope
  boundary. Both expose `createMetaClient(overrides?)` / `createShopifyClient(overrides?)` async factories
  that resolve credentials from Secret Manager by the fixed A0 names and build a ready client — this is what
  Phase B should call (`const client = await createMetaClient(); const res = await client.get("/act_.../
  campaigns", { fields: "..." });`), with every option (including `fetchImpl`/`sleepImpl` for tests)
  individually overridable. `MetaClient` additionally computes `appsecret_proof`
  (`HMAC-SHA256(accessToken, key=appSecret)`, hex) and attaches it whenever an app secret is present — Meta's
  "Require App Secret" hardening — since `createMetaClient()` always resolves `meta-app-secret`; **confirmed
  live that adding this did not break authentication** (see verification below). 18 (Meta) + 8 (Shopify)
  client-level tests cover: request shape (token attached, `appsecret_proof` computed correctly, GraphQL
  POST body shape), BUC/cost state being stored and consulted pre-emptively across two sequential calls,
  retry-then-succeed on a rate-limited/THROTTLED response, no-retry on an unauthorized/access-denied
  response, and `checkAuth()`'s three-way behavior (see next point).
- **`checkAuth()` — the §9.6 health check primitive.** Both clients expose `checkAuth(): Promise<{
  authorized: boolean; detail: string }>`, making one minimal live call — Meta: `GET /{adAccountId}?
  fields=id` (the same trivial "prove the token works" call A0's `verify-credentials.ts` established, not a
  Phase B "fetch entities" call — nothing is normalized or stored); Shopify: `{ shop { name } }` — and
  classifying the **credential** as authorized or not. It deliberately does **not** attempt the full
  `healthy`/`no_new_data`/`unauthorized` tri-state: `no_new_data` needs a row count only a real sync task
  has, which is out of A4's scope by the step's own "no specific resource" boundary. What A4 hands Phase B
  instead is `services/ingest/health.ts`'s pure `classifySyncStatus({ authorized, newRowCount? })` — reusing
  `SyncStatus` from `@shared/schema/sync.ts` (A2) rather than inventing a parallel type — which B1/B3/B5
  should call after a sync attempt, combining `checkAuth()`'s (or a thrown `ApiError.kind === "unauthorized"`
  during the sync itself) authorization signal with the row count the sync task already knows:
  `!authorized → "unauthorized"`; `authorized && newRowCount === 0 → "no_new_data"`; otherwise `"healthy"`.
  4 tests cover all three branches plus the "row count not yet known" default. Per the step spec: A0 used a
  Meta **system user token** (does not expire), so §9.6's scheduled token-refresh job was correctly treated
  as out of scope and not built — but the health check itself was still built, since a *revoked* system-user
  token is exactly the silent-zero-row failure mode §9.6 warns about.
- **Live verification — exactly what ran and what it proved.** ADC was available in this environment
  (`gcloud auth application-default login`, per SETUP.md §5's operator grant), so `npm run
  verify-a4-clients` was actually run against real Secret Manager + live Meta/Shopify APIs, not merely
  written:
  ```
  [PASS] MetaClient.checkAuth() — GET ad account (fields=id)
         account id: act_456833154967349
  [PASS] ShopifyClient.checkAuth() — { shop { name } }
         shop name: "Sparkle and Glow"
  ```
  This exercises the real code path Phase B will use: `createMetaClient()`/`createShopifyClient()` →
  `shared/secrets/client.ts` → Secret Manager → the actual `MetaClient`/`ShopifyClient` classes, including
  `appsecret_proof` computation on the Meta side. Both calls are strictly read-only (a GET and a
  name-only GraphQL query); no mutating call was made against either platform, and no Firestore write
  occurred anywhere in this step's code (A4 has no Firestore dependency at all — `services/ingest/health.ts`
  imports only the `SyncStatus` *type* from `@shared/schema/sync.ts`, no runtime Firestore access). BUC/cost
  throttle *behavior under real sustained load* was **not** and could not be verified live — a single
  `fields=id` call and a single `{ shop { name } }` query are far too cheap to move either platform's usage
  meter into throttling range in one run; that behavior is proved instead by the 27 + 15 synthetic-header/
  synthetic-extensions unit tests described above, which is what the step's own "Done when" line asks for
  ("throttle logic has unit tests against synthetic headers", not a live throttle reproduction).
  Anthropic/Claude was not touched — out of scope for A4 (D3's job).
- **What Phase B needs from here:** import `createMetaClient`/`createShopifyClient` (or the individual
  classes for DI) from `services/ingest/meta/client.ts` / `services/ingest/shopify/client.ts` (or the
  `services/ingest/index.ts` barrel). `MetaClient.get()` and `ShopifyClient.query()` are the only two
  request primitives — B2/B3 build actual Meta resource fetches (campaigns, insights, async report
  job polling) on top of `get()`; B5 builds Shopify order/line/refund queries on top of `query()`, supplying
  a real `estimatedCost` per query shape once it knows one. B1's task wrapper is the natural place to call
  `classifySyncStatus` and write the result into `syncState.status`.
- **⚠️ Orchestrator note (added at A4 review — B1 must act on this).** BUC throttle state (`lastUsage`) is
  **per client instance, held in memory**, and `createMetaClient()` returns a fresh instance every call with
  `lastUsage: null`. `decideBucBackoff(null)` returns "no usage data yet" and does not throttle, so
  **pre-emption only works across calls that share one client instance.** A task that constructs a new client
  per request throttles never; a backfill loop that makes one client and pages with it throttles correctly.
  B1's task wrapper must therefore **create the client once per task and pass it down**, not per request.
  Note this is still per-process: two concurrent Cloud Run/Functions instances keep separate counters and
  can jointly overshoot Meta's budget. Acceptable at this account's size (§2.1) and not worth distributed
  state yet — but if B3's backfill ever runs sharded in parallel, revisit it there rather than discovering
  it as a stalled account.

---

# Phase B — Ingestion

---

### B1 — Sync framework

**Status:** Done — `npm run check` passes clean (typecheck across both the root ESM project and
`functions/`'s CommonJS project, lint, format, 230/230 unit tests — up from A4's 177, this step's own
53 new: 46 across `services/ingest/sync/**` + 7 for `addCalendarDays`). `npm run test:integration`
passes 110/110 against a real Firestore emulator (103 from A2 + 4 from A3 + 3 new
`taskWrapper.emulator.test.ts` cases). The `functions/` esbuild bundle was actually
built (`npm --prefix functions run build`) and its compiled artifact was actually executed end to end
against a live Firestore emulator (not just typechecked) — see Notes below. No real cloud resource
(Cloud Tasks queue, Cloud Storage bucket, live Firestore, deploy) was created, modified or touched.
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

**Notes from implementation:**

- **Layout as built.** All real logic lives in the root ESM project, under
  `services/ingest/sync/`: `taskTypes.ts` (the §10.2 task-type list + `SYNC_NOOP`),
  `reconciliationWindow.ts` (§9.4, pure), `store.ts` (`SyncStore` — the `syncState`/`syncRuns`
  get/set seam), `archiver.ts` (§23, `RawArchiveStore`/`GcsRawArchiveStore`), `taskQueue.ts`
  (§10.2's controller/enqueue side, `TaskQueueClient`/`CloudTasksQueueClient`), `registry.ts`
  (the task-type → handler map, `createDefaultRegistry()` registers `SYNC_NOOP`),
  `taskWrapper.ts` (`runSyncTask` — the uniform wrapper), `httpHandler.ts`
  (`handleTaskRequest` — the framework-agnostic Cloud Tasks HTTP-target logic, pure
  request-in/response-out), `runtime.ts` (`handleSyncTaskDispatch` — the same thing wired to
  real Firestore/registry/archiver), and `index.ts` (barrel + esbuild entry point). Every file
  has a co-located `*.test.ts`; `taskWrapper.emulator.test.ts` is the emulator-backed proof of
  this step's own "Done when" line. `scripts/config.ts` gained `RAW_ARCHIVE_BUCKET`.
  `shared/canon/reportingDay.ts` gained `addCalendarDays` (pure calendar-day arithmetic, no
  timezone — distinct from `reportingDayToUtcRange`), needed by the reconciliation window and
  reusable by any later step's own N-day windowing.

- **The `functions/` module-system decision (A1's orchestrator note) — resolved as a bundled
  thin deploy shim, the third option that note listed.** `functions/` is untouched as CommonJS
  with its original `rootDir: "src"` (A1's scaffold) and still cannot import `/shared` or
  `/services` directly. Instead:
  - All real logic is written, typechecked, unit-tested and emulator-tested entirely in the
    root ESM project (as above), using the existing `@shared`/`@services` path aliases, vitest,
    and the Firestore emulator exactly as A2–A4 already do. Nothing about this step's actual
    logic lives in `functions/` at all.
  - `functions/scripts/bundle.mjs` uses esbuild's JS API to bundle
    `services/ingest/sync/index.ts` into one self-contained CommonJS file,
    `functions/lib/generated/syncBundle.js` (gitignored, like the rest of `functions/lib/`).
    `firebase-admin`, `firebase-functions`, and every `@google-cloud/*` package are marked
    `external` (kept as bare `require(...)`, not inlined) so the bundle resolves them from
    `functions/node_modules` at runtime — this is what avoids two separate copies of
    `firebase-admin` (root's ^14.3.0 vs. functions' original ^13.0.0) ending up in the same
    process with two separate `getApps()` registries; `functions/package.json`'s
    `firebase-admin` was bumped to ^14.3.0 to match root's, and `@google-cloud/tasks`,
    `@google-cloud/storage`, `@google-cloud/secret-manager`, and `esbuild` were added as real
    dependencies there (mirroring what root already has, so the externals actually resolve).
    Pure-JS dependencies (zod) are bundled normally, not marked external.
  - `functions/src/generated/syncBundle.d.ts` is a **hand-written** ambient declaration
    (checked into git) of the bundle's exported surface — currently just
    `handleSyncTaskDispatch`. Because it sits at the exact path TypeScript's classic module
    resolution looks for when `functions/src/index.ts` writes
    `import { handleSyncTaskDispatch } from "./generated/syncBundle"`, `npm run typecheck`
    (which runs `tsc --noEmit -p functions/tsconfig.json`, unchanged from A1) passes whether or
    not the bundle has actually been built — the real `.js` is generated only by
    `npm --prefix functions run build` (now `node scripts/bundle.mjs && tsc`, bundle first since
    tsc doesn't clean `outDir` and would otherwise leave a stale/missing bundle next to its own
    fresh output).
  - `functions/src/index.ts` is now genuinely thin: one `onRequest` handler
    (`syncTaskDispatch`) that parses the request body and calls `handleSyncTaskDispatch`. B2–B8
    should not need to touch this file — they register real task handlers into
    `registry.ts`'s default registry, which this already dispatches through.
  - **Tradeoff, stated plainly (asked for explicitly):** this keeps the root project idiomatic
    ESM and fully testable with the tooling A2–A4 already established, and keeps `functions/`'s
    own deploy mechanics (`firebase.json`'s `predeploy: npm run build`) completely unchanged
    from A1 — no monorepo/workspace tooling, no repo-wide module-system migration, no rootDir
    surgery. The cost is the hand-maintained `.d.ts` mirror: nothing enforces it stays in sync
    with `services/ingest/sync/index.ts`'s real exports except the comment saying so and
    whoever edits one remembering the other exists. A real mismatch would only surface by
    actually building and running the bundle, not from `tsc` alone — mitigated by keeping the
    declared surface minimal (one function today) and by the verification below, which builds
    and *executes* the real bundle rather than stopping at "it typechecks".
  - **This was verified for real, not just written.** `npm --prefix functions run build`
    actually ran esbuild + tsc and produced `functions/lib/index.js` +
    `functions/lib/generated/syncBundle.js` (762.9kb, sourcemapped). `require()`-ing
    `functions/lib/index.js` in a plain Node process confirmed it loads cleanly with no crash
    and exports exactly `syncTaskDispatch`; `require()`-ing the bundle directly confirmed its
    exports match the hand-written `.d.ts` exactly. Then, against a **real Firestore emulator**
    (`firebase emulators:exec --only firestore "node <script requiring the built bundle>"`),
    the bundled `handleSyncTaskDispatch(...)` was actually called with `{taskType: SYNC_NOOP,
    ...}` and returned `{status: 200, body: {status: "SUCCEEDED", ...}}` — i.e. the compiled,
    bundled, externals-resolved-from-`functions/node_modules` artifact really can reach a real
    Firestore and run a task, not merely typecheck. `functions/lib/` was deleted afterward
    (gitignored build output; nothing to commit).

- **The task-wrapper API B2–B8 plug into.** Register a handler:
  ```ts
  registry.register({
    taskType: "META_SYNC_INSIGHTS",       // add to SYNC_TASK_TYPES in taskTypes.ts if new
    runSource: "meta",                     // "meta" | "shopify" | "internal"
    syncStateTarget: { source: "meta", resource: "insights" }, // or null for no watermark
    handler: async (ctx) => {
      const meta = await ctx.getMetaClient();   // constructed at most once per run, memoized
      // ... fetch, normalize, upsertWithVersionGuard({ ..., onRejected: ctx.recordVersionGuardRejection }) ...
      await ctx.archiver.archive({ source: "meta", day, resource: "insights", runId: ctx.runId, payload: rawBody });
      return { newWatermarkDate: latestDay, newRowCount: rows.length };
    },
  });
  ```
  `runSyncTask({ syncStore, registry, taskType, payload, archiver, taskId?, accountId?, ... })`
  is the entry point (also reachable via `handleTaskRequest`/`handleSyncTaskDispatch` for the
  HTTP path). It handles idempotency (a `taskId` already `SUCCEEDED` short-circuits without
  re-running the handler or touching `syncState` again — `taskId` **is** the `syncRuns`
  document id, a deliberate B1 ID-scheme decision recorded in
  `shared/firestore/collections.ts`), retry classification (`ApiError.retryable` where thrown,
  else defaults retryable — mirrors `services/ingest/http/retry.ts`), and watermark-on-success-
  only. `computeReconciliationWindow({ watermark, today, reconciliationDays, mode,
  deepReconciliationDays? })` (throws on a null watermark — run backfill first) is what B3/B5
  call to turn `syncState.lastDataDate` into the date range to actually fetch.

- **The A4 orchestrator note (per-client-instance BUC throttle) is directly implemented, not
  just avoided.** `ctx.getMetaClient()`/`ctx.getShopifyClient()` are memoized async factories
  built once per `runSyncTask` call (`memoizeAsync` in `taskWrapper.ts`) — the underlying
  `createMetaClient()`/`createShopifyClient()` (A4) is invoked at most once per task run no
  matter how many times or where in the handler `ctx.getMetaClient()` is called, and never
  constructed at all if the handler never asks for it. Covered by
  `taskWrapper.test.ts`'s "Meta/Shopify client construction" suite (asserts a call counter of
  exactly 1, and of 0 when unused).

- **The A2 orchestrator note (version-guard rejection logging) is wired, not just planned.**
  `ctx.recordVersionGuardRejection` has exactly `upsertWithVersionGuard`'s `onRejected` shape —
  pass it straight through:
  `upsertWithVersionGuard({ ..., onRejected: ctx.recordVersionGuardRejection })`. Every
  rejection during a run lands in that run's `syncRuns.versionGuardRejections`
  (A2's `versionGuardRejectionLogEntrySchema`, with `loggedAt` stamped by the wrapper),
  regardless of whether the run overall succeeds or fails — covered by
  `taskWrapper.test.ts`'s version-guard-rejection suite (both branches).

- **`syncState`/`syncRuns` schema needed zero changes** (A2's orchestrator note: any new field
  on an existing collection must be optional/defaulted). `syncRunSchema.source` already allowed
  `"internal"` and `syncStateSchema` already modeled exactly `"meta" | "shopify"` — which maps
  cleanly onto "not every task type has a watermark" (`syncStateTarget: null` in a
  registration) without touching either schema.

- **Ambiguities resolved:**
  1. **What should `computeReconciliationWindow` do with no watermark at all** (`syncState`
     never successfully synced)? Resolved to throw, matching A3's `loadReportingCanon`
     fail-loudly precedent, rather than silently returning a plausible-looking-but-wrong range
     — reconciliation re-fetches history, it doesn't create it; a caller with no watermark
     needs the (separate, one-time) backfill flow B3 owns instead.
  2. **Cloud Tasks retry semantics have no native "terminal, don't retry" HTTP status** — Cloud
     Tasks treats any non-2xx as "retry", full stop, with no 4xx/5xx distinction of its own.
     Resolved: a retryable failure returns 500 (Cloud Tasks retries per the queue's own
     backoff/max-attempts config); a terminal failure (including an unknown task type, or a
     malformed request body) returns 200 anyway, with the real outcome fully visible in
     `syncRuns` and the response body — observability comes from `syncRuns`, not from the HTTP
     status of a task nobody will look at again. Documented in `httpHandler.ts`'s module
     comment.
  3. **Two independent idempotency layers, deliberately not collapsed into one.** Cloud Tasks'
     own task *name* (not just a body field) gives queue-level dedupe of a duplicate *enqueue*
     within its own retention window; `runSyncTask`'s `taskId`-keyed `syncRuns` lookup gives
     idempotency at the *execution* layer regardless of how a duplicate dispatch arrives (Cloud
     Tasks' at-least-once contract holds even for a named task). `taskQueue.ts`'s module
     comment spells out why both exist.
  4. **Not exercised live, by the safety constraints of this step:** `CloudTasksQueueClient`
     (real `@google-cloud/tasks` usage) and `GcsRawArchiveStore` against the real bucket
     (`gs://sng-meta-ads-optimizer-archive`, per SETUP.md — never connected to). Both are typed
     against a narrow structural interface a real client satisfies automatically
     (`CloudTasksClientLike`, `StorageBucketLike` — same seam pattern as A2's
     `VersionGuardFirestoreLike` and A4's `SecretManagerClientLike`) and covered by unit tests
     against hand-rolled fakes implementing those interfaces, per this step's brief.

- **What real cloud provisioning is still needed before this runs for real** (none of it was
  done here — see this step's safety constraints):
  1. A Cloud Tasks queue, e.g.:
     `gcloud tasks queues create sync-tasks --location=asia-south1 --project=sng-meta-ads-optimizer`
  2. Deploy `functions/` (which creates the actual HTTPS function
     `syncTaskDispatch` points enqueued tasks at):
     `firebase deploy --only functions --project sng-meta-ads-optimizer`
  3. Grant the `sync-functions` service account (already created in A0) permission to enqueue
     Cloud Tasks and invoke the deployed function:
     `gcloud projects add-iam-policy-binding sng-meta-ads-optimizer --member="serviceAccount:sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com" --role="roles/cloudtasks.enqueuer"`,
     plus `roles/run.invoker` (Cloud Functions Gen 2 runs on Cloud Run) scoped to the deployed
     function.
  4. Only then does `createDefaultTaskQueueClient({ location: "asia-south1", queue:
     "sync-tasks", targetUrl: "<deployed function URL>", serviceAccountEmail:
     "sync-functions@sng-meta-ads-optimizer.iam.gserviceaccount.com" })` (`taskQueue.ts`) have
     anything real to point at. B2–B8 do not need any of this to land — `runSyncTask`/
     `handleTaskRequest` are fully exercisable (as this step's own tests do) without a queue at
     all, by calling them directly or through `createInMemoryTaskQueueClient`.
  5. The raw archive bucket already exists (A0); `createDefaultRawArchiveStore()` (`archiver.ts`)
     needs no further provisioning, only the `sync-functions` service account's existing
     `roles/storage.objectAdmin` grant on it (already done in A0) to actually be used from a
     deployed function.

---

### B2 — Meta entity sync and config snapshots

**Status:** Done — `npm run check` passes clean (typecheck across both projects, lint, format,
267/267 unit tests — up from B1's 230, this step's own 37 new: 13 budget-ownership, 15
normalization, 8 fetch/pagination, 1 combined-fetch). `npm run test:integration` passes
116/116 against a real Firestore emulator (110 from A2+A3+B1, plus this step's 6 new emulator
tests: 2 for `metaSyncEntitiesHandler`, 4 for `metaSnapshotConfigHandler`). Live, read-only
Meta API calls were made against the real ad account during planning and verification (no
write/mutating call of any kind); see Notes for what the real account structure turned out to
be — materially bigger than §7.1's "under 100 ads" assumption. No live/production Firestore
was touched; no cloud resource was created, modified or deployed.
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

**Notes from implementation:**

- **Layout as built.** `services/ingest/meta/entities/{budgetOwnership,normalize,fetch,fetchAll,
  entitySync,configSnapshot,index}.ts`, each with a co-located `*.test.ts`; `entitySync.ts` and
  `configSnapshot.ts` additionally have `*.emulator.test.ts`, and both share
  `testFixtures.ts` (not itself a test file) for a small synthetic-but-realistic account
  fixture. `services/ingest/sync/registry.ts`'s `createDefaultRegistry()` now also registers
  `metaSyncEntitiesRegistration` and `metaSnapshotConfigRegistration` — this is B1's own
  documented extension point ("B2–B8 registering their real task handlers means extending
  `createDefaultRegistry()`"), so **`functions/src/index.ts` was not touched**, exactly as
  B1 intended. `registry.test.ts`'s "registers exactly SYNC_NOOP" assertion was updated to
  expect all three task types now registered there.

- **The real account is dramatically bigger than §7.1's "under 100 ads" / "steady-state
  volume ... is small" assumption.** Confirmed live, read-only, by paging every campaign/ad
  set/ad edge to exhaustion: **410 campaigns, 534 ad sets, 1,139 ads (all-time, all
  statuses)** — not a handful of active campaigns but years of accumulated history (oldest
  seen: 2023). An `effective_status=["ACTIVE"]`-filtered query alone hit the 200-row page cap
  for campaigns, ad sets AND ads, meaning the *active* footprint is also large, not just the
  historical tail (exact active-only totals weren't fully paged — not needed for this step,
  but worth knowing before C2/C3 assume "a few dozen active ads" for statistical power). This
  materially affected two implementation decisions, both noted below: creative-fetch page
  size, and using Firestore's `BulkWriter` instead of one-write-at-a-time. **Whoever plans B3
  (insights) and C2/C3 (features/statistics) should re-read §2.1's account-size assumptions
  against this before relying on them** — B3 in particular will be paging far more than a
  trivial amount of daily insight rows.

- **Budget ownership (§4.1/§7.1) — validated against real data, not just designed against the
  spec.** `services/ingest/meta/entities/budgetOwnership.ts` implements the rule: a campaign
  with its own `daily_budget`/`lifetime_budget` owns it (CBO/Advantage+ campaign budget); a
  campaign with neither defers to its ad sets — if exactly the child ad sets carry a budget,
  ad-set level owns it; if there is a *conflict* (both levels report one) or *neither* does
  (no ad sets at all, or ad sets that also report none), the result is
  `{ownerLevel:"UNKNOWN", dailyBudgetMinorUnits:null, lifetimeBudgetMinorUnits:null,
  currency}` — `shared/schema/common.ts`'s `budgetOwnership` zod schema already had this
  exact `UNKNOWN` branch from A2, unused until now. **Live result on the real account: 369
  campaigns own budget outright, 37 have a single ad set that owns it, 4 are genuinely
  ambiguous (`UNKNOWN`)** — old PAUSED campaigns (e.g. `"Sales"`, an "Advantage+ shopping
  campaign 06/24/2023") whose ad sets are permanently gone (Meta's API refuses to even query
  "deleted objects" for them) and which report no budget of their own. Zero conflicts (both
  levels reporting a budget) were observed live, but the code still handles that case as
  `UNKNOWN` rather than assuming it can't happen. **This means D1's "budget decisions resolve
  at the budget owner" (§4.1) will, for a small number of old/paused campaigns, need to
  handle `ownerLevel: "UNKNOWN"` explicitly** — those 4 have no defined decision unit for a
  budget recommendation, and D1 should treat that as "cannot make a budget-level
  recommendation here", not silently default to campaign or ad-set.

- **Meta returns `daily_budget`/`lifetime_budget` already in minor units, not a decimal
  string** — confirmed live (a real campaign's `daily_budget: "80000"` is ₹800.00/day on this
  INR account, not ₹80,000.00). `budgetOwnership.ts` parses it as a plain integer, deliberately
  **not** through `shared/canon/money.ts`'s `parseDecimalToMinorUnits` — that helper is for
  genuinely decimal money strings (e.g. B3's insights spend), a different representation.
  Using it here would have silently 100x'd every budget. Flagging this explicitly since it's
  exactly the kind of assumption that looks reasonable and is wrong.

- **A3 dependency, and what it is NOT used for.** `entitySync.ts`/`configSnapshot.ts` both
  call `loadReportingCanon()` for exactly one thing: `canon.reportingTimezone`, to compute
  "today" (`toReportingDay(new Date(), canon.reportingTimezone)`) as the §23 archive path's
  `day` segment and as `accountId` source (`canon.accountId`) — using the UTC calendar date
  instead would occasionally misfile an archive payload by a day near IST midnight. It is
  **not** used for currency (the Meta ad account's own `currency` field — fetched live, once
  per run, via `fetchAccountCurrency`, `GET /{accountId}?fields=currency` — is the correct
  source of truth for what currency *its* budget numbers are in; it happens to equal canon's
  `reportingCurrency`, both `"INR"`, but isn't assumed to). **Consequence: this step's tasks
  cannot run against a real (non-emulator) Firestore until an operator creates
  `settings/{accountId}`** — per A3's own precedent note, nobody has written that document
  yet. This is expected sequencing per §5, not a bug; flagging it again here since B2 is the
  first step to actually make that dependency load-bearing in a real task handler.

- **Ad-set `attribution` field deliberately left `null`.** `shared/schema/meta.ts`'s
  `metaAdsetSchema.attribution` (added by A2) expects an `attributionProvenance` — both an
  `attributionWindow` *and* a `purchaseActionType`. Meta's per-ad-set `attribution_spec`
  (confirmed live: `[{event_type:"CLICK_THROUGH",window_days:7},
  {event_type:"VIEW_THROUGH",window_days:1}]` on every ad set sampled, matching the account's
  configured `"7d_click_1d_view"`) supplies only the window half — there is no per-ad-set
  purchase-action-type in Meta's model at all. Rather than silently pairing a real per-ad-set
  window with a borrowed account-wide `purchaseActionType` (which would look like a genuine
  per-ad-set setting but partly isn't), this field is left `null` in B2. **B3 is where
  `attributionProvenance` is actually load-bearing** (`metaInsightsDailySchema.attribution` is
  non-nullable, populated from the insights query's own explicit window/action-type
  parameters) — this is a deliberate scope boundary, not an oversight.

- **`META_SYNC_ENTITIES` and `META_SNAPSHOT_CONFIG` each make their own independent live Meta
  fetch** (both call the shared `fetchAllMetaEntities` helper in `fetchAll.ts`), rather than
  snapshot reading what entity-sync just wrote. This costs one extra full account read per
  §25's "config sync + snapshot" cycle, but keeps the two Cloud Tasks task types genuinely
  independently retriable per §10.2 — a retried/redelivered `META_SNAPSHOT_CONFIG` never
  depends on `META_SYNC_ENTITIES` having run first, or at all, in the same cycle. At this
  account's real read volume (410+534+1139+~800 creatives, paged) this is a deliberate,
  documented trade, not an oversight — worth revisiting only if Meta's BUC usage is ever
  observed running hot from this specific duplication.

- **Creative fetch uses a smaller page size (25) than the other three edges (100–200) —
  found live, not guessed.** `GET /{accountId}/adcreatives` with `object_story_spec`/
  `asset_feed_spec` requested returns an HTTP 500 ("Please reduce the amount of data you're
  asking for") at `limit=100` on this account; it succeeds at `limit=25`. Documented in
  `fetch.ts`'s module comment so nobody "optimizes" this back up to match the other edges.

- **Composite creative detection (§7.3), validated against real examples.** `asset_feed_spec`
  presence is the COMPOSITE signal (57/160 real creatives sampled carried it, each with
  `optimization_type:"DEGREES_OF_FREEDOM"` and multiple body-text variants). Member asset
  hashes are collected from `asset_feed_spec.images[].hash`/`.videos[].video_id` **and** from
  `object_story_spec.link_data.child_attachments[].image_hash`/`.video_id` — the latter
  because a real composite creative on this account was carousel-shaped (Advantage+ catalog
  ad with multiple `child_attachments`, each its own `image_hash`) rather than the
  `asset_feed_spec.images[]` shape alone. `deliveredMixObservable: false` is set for every
  COMPOSITE creative per §7.3, unconditionally — this account's dynamic creatives all use
  Meta's own optimization to pick the delivered combination, so there's no case where a
  composite's mix is actually observable to mark otherwise.

- **Ad `destinationUrl`, and why it's derived from the creative fetch rather than the ad
  fetch.** `GET /{accountId}/ads` with `creative{link_url,object_story_spec}` sub-fields
  requested hits the same "reduce the amount of data" error at this account's ad volume
  (1,139+ ads). Instead, `normalizeAd` looks up `destinationUrl` from a
  `creativeId -> linkUrl` map built from the same run's (separately, lightly-paged) creative
  fetch — one ad-set of Meta calls instead of a much heavier per-ad one. This is B2's capture
  only; **B7's UTM audit is still the step that validates the URL actually yields a
  resolvable ad ID** (§6.1) — B2 makes no claim about that.

- **`metaEntitySnapshots`' three fields with no honest per-entity-type value are left `null`
  rather than fabricated.** Meta has no campaign-level `targeting` (targeting lives on the ad
  set) and no campaign- or ad-set-level `creativeAssignment` (creatives attach only to ads) —
  so `CAMPAIGN` snapshots get `targeting:null, creativeAssignment:null`, `ADSET` snapshots get
  `creativeAssignment:null` (an ad set can contain many ads, each with its own creative; no
  aggregate is invented), and `AD` snapshots get `budget:null, targeting:null,
  bidStrategy:null` (ads never own budget or carry independent targeting/bid strategy in
  Meta's model — `shared/schema/meta.ts`'s `metaAdSchema` already has no budget field at all,
  confirming this reading). Only `AD.creativeAssignment` (`[]` or `[creativeId]`) and
  `AD.status`/`CAMPAIGN.*`/`ADSET.*` (as applicable per the above) are ever populated.

- **Writes use Firestore's `BulkWriter`, not the A2 repository's one-write-at-a-time
  `.set()`.** Chosen once the real account scale above was known (~2,600+ documents across
  campaigns+ad sets+ads+creatives per full sync) — still schema-validated on the way in via
  each collection's existing typed, converter-wrapped `collectionRef` (A2's `repository.ts`),
  so `BulkWriter` is purely a batching mechanism here, not a validation bypass. Every write
  goes to a document keyed directly by Meta's own ID (`metaCampaigns/{campaignId}`, etc.) —
  wholesale-replace on every run, deliberately **not** version-guarded, matching
  `shared/schema/meta.ts`'s existing module comment ("Meta is the single source of truth for
  current config state ... not version-guarded like Shopify/insights"). `metaEntitySnapshots`
  writes go through the same `collectionRef`+`BulkWriter` pattern, keyed via A2's
  `metaEntitySnapshotKey(entityType, entityId, syncRunId)` — never hand-built.

- **`META_SYNC_ENTITIES`/`META_SNAPSHOT_CONFIG` register a `syncStateTarget`
  (`{source:"meta", resource:"entities"}` / `{source:"meta", resource:"config_snapshot"}`) but
  their handlers never return `newWatermarkDate`.** Unlike insights/orders, a full entity sync
  has no natural "furthest date of data collected" — every run re-fetches *current* state, not
  an incremental window — so `syncState.lastDataDate` stays permanently `null` for both
  resources while `lastSuccessfulSyncAt`/`status`/`lastRunId` still update correctly on every
  success (a real, useful health signal per §9.6). This is a deliberate reading of B1's
  `TaskHandlerResult.newWatermarkDate` being optional, not a gap.

- **Meta API version note (not this step's to fix, flagging for A0/A4's owner).** `scripts/
  config.ts` pins `META_API_VERSION = "v21.0"`. Every request in this step still succeeds
  against that version, but Meta's own `paging.next` URLs in the responses come back pointing
  at `v26.0` — i.e. Meta is silently serving v21.0 through whatever the current minimum
  supported version now is. Not blocking, but v21.0 is likely at or past deprecation; whoever
  next touches `scripts/config.ts` should confirm and bump it.

- **Ambiguity explicitly surfaced and left unresolved (not this step's call): a stray file at
  the repo root.** `Export_2026-08-30_113502.xlsx` (untracked, not gitignored) appeared in the
  repository root during this session — almost certainly the Matrixify Shopify order-history
  export SETUP.md §6/B5 describe, which its own instructions say belongs in Cloud Storage,
  "not the repo — it contains customer PII". This step did not create it and did not touch,
  move, or delete it (out of scope, and deleting someone else's in-progress file without
  being asked is not this step's call) — flagging it so whoever owns B5/SETUP.md's PII
  handling notices before it's accidentally committed.

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
- **A name-matching fallback** for orders whose `utm_content`/`utm_campaign` is an ad/campaign **name**
  rather than an ID (user decision — see Open Question #1, which measured names as the dominant case).
  Match against B2's entity names. ⚠️ Ad names are neither unique nor stable over time, so a name match can
  attribute revenue to the **wrong** ad: store the resolution method (`AD_ID` | `NAME_MATCH` | `UNRESOLVED`)
  and a lower confidence on every name-resolved order, and never silently pool them with ID-resolved ones.
  Normalize the inconsistent `utm_source` spellings (`meta`, `roi_meta`, `facebook`, `RM_META`) when
  deciding what counts as Meta traffic.

**⚠️ An untagged order is NOT evidence that no ad drove it.** 96.7% of this account's orders carry no UTM at
all (Open Question #1), and many carry only an opaque `fbclid`. Ads running at the time drive order volume
whether or not the link was tagged, so a missing tag is **missing measurement, not absent influence**. Three
consequences, all binding on B7 and on everything downstream:

1. **Never write per-ad Shopify revenue of zero for an unresolved order.** The existing "excluded rather than
   reported as zero" rule is load-bearing precisely because of this — a zero would read as "this ad sells
   nothing" when it means "we could not see the link".
2. **Meta-attributed conversions already capture untagged ad-driven orders**, because Meta attributes via its
   own pixel/CAPI rather than the URL. That, not the UTM join, is the per-ad decision signal while coverage is
   this low. The UTM join is an independent cross-check on it, and §6.2 still forbids merging the two.
3. **Emit an account-level blended efficiency metric that needs no attribution at all** — total Shopify
   revenue ÷ total Meta spend per reporting window (commonly MER). At ~0% attribution coverage this is the
   only honest account-level read on whether the ad spend is working, and it is immune to the tagging problem
   entirely. C2 consumes it; D1 should cite it whenever `attributionCoverageRatio` is low.

**Out of scope.** Reconciling the disagreement between Meta-attributed and Shopify-attributed figures —
§6.2 says they disagree structurally and must never be merged. The job here is to measure the gap, not close
it. Blended MER is not a reconciliation of the two: it deliberately uses neither attribution, dividing one
account total by another.

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
- **Blended account efficiency (MER)** per window — total Shopify revenue ÷ total Meta spend, using no
  attribution at all (see B7). With attribution coverage near zero this is the account-level truth; carry it
  alongside the attributed metrics, clearly labelled as blended, never merged with either attributed view.
- **Calendar/seasonality features from C5** attached to every window: the seasonal label(s) the window spans,
  and a `windowSpansSeasonalBoundary` flag. C3 and D1 need to know when a comparison straddles a regime
  change; see C5 for why this is not optional at this account.

**Out of scope.** Intervals and shrinkage — C3 layers those on. Learning-phase features — C4. Deriving the
calendar itself — C5.

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
until minimum-N is reachable. Seasonality — that is C5, which you consume rather than build. **Do not
de-seasonalise any stored value**; carry C5's context beside the number instead, so the verdict stays
auditable.

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

### C5 — Calendar and seasonality context

**Status:** Not started
**Depends on:** C1
**Design refs:** §12, §15.3, §21.1 (not specified in the design — added to the plan after A0–B2, see below)
**Size:** M

> **Added to the plan by the user, not carried over from the design document.** The design has no seasonality
> concept at all. It needs one: this is an Indian jewellery store (INR, `sparkleandglow.co.in`) whose order
> volume is strongly festive-driven — Diwali, Navratri, Dhanteras, Akshaya Tritiya and the wedding season
> move demand far more than any budget edit does. Evidence from the account already shows it: a live ad set
> is literally named `Navratri sale 15% OFF| AD`.

**Goal.** Make seasonality an explicit, inspectable signal, so that a demand swing driven by the calendar is
never silently attributed to an ad change.

**Why this is not cosmetic.** Every comparison in this system is a window against a baseline — C3's shrunk
baseline, D1's evidence, E2's outcome evaluation. **If a 28-day window lands on Diwali and its baseline does
not, the festive lift is credited to whatever change happened to precede it.** That is a false positive the
rest of the design has no defence against: §15.3's shrinkage corrects for small samples, not for a demand
regime change. Without this step, E2 will systematically record seasonally-timed recommendations as
successes and off-season ones as failures, and E3's calibration will then be measuring the calendar.

**Deliverables**
- A `calendar/` collection or settings-backed table mapping reporting days to **seasonal labels** — named
  festive windows, wedding season, and an off-season default. Store it as **data, not code**, so the dates
  (which move every year on the lunar calendar) can be corrected without a deploy.
- `seasonalityContextFor(window)`: the labels a window spans, and `spansSeasonalBoundary: true` when a window
  and its comparison baseline sit in different regimes.
- Day-of-week and month-of-year features — weekend/weekday effects are real and much cheaper to establish
  than festive ones.
- A **demand index per seasonal label**, derived from the account's own order history (B5), expressed
  relative to the trailing off-season baseline. Keep it descriptive: this is a stated context number, not a
  forecast, and not a correction applied silently to any metric.
- Surface the context in the D2 packet **as text**, the way §15.2 requires intervals to appear in text — the
  model must reason over "this window covers Diwali; its baseline does not", not be expected to infer it.

**Out of scope.** Forecasting demand. De-seasonalising or otherwise adjusting stored metrics — **store the
context beside the metric, never mutate the metric**; a silently adjusted number is unauditable and D1/E2
would have no way to show its work. Automatic guardrails from seasonality — D5 may consume this later, but
this step only produces the signal.

**Done when.** A window covering a festive period is labelled as such; a window/baseline pair straddling a
festive boundary sets `spansSeasonalBoundary`; the demand index for a festive label is measurably above the
off-season baseline on this account's own data.

**Notes for the planning agent.** ⚠️ **Check how much history actually exists before promising a demand
index.** B5's seed covers 2025-01-15 → 2025-12-13 with a known gap from 2025-12-13 to ~2026-07-01, so there
is roughly one incomplete year — enough for one observation of each festive window and **not** enough for a
year-over-year comparison. Say so plainly rather than computing a confident-looking index from a single
occurrence; a label with `n=1` and wide uncertainty is the honest output, and C3's whole premise is that
uncertainty travels with the number. If the later Matrixify exports fill the gap, this becomes materially
better — design for recompute.

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

**⚠️ Seasonality is a first-class confound here (C5).** An accepted recommendation whose evaluation window
lands on a festive period will look successful whatever it did, and an off-season one will look like a
failure. Record C5's seasonal context on every outcome, and **flag — do not silently score — an outcome
whose evaluation window and baseline sit in different seasonal regimes.** E3's calibration is only
meaningful if it is not secretly measuring the calendar.

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
| 1 | ~~Do the live UTM tags carry `{{ad.id}}` or an ad **name**?~~ | B7 | **RESOLVED — see below. Answer: overwhelmingly names, and mostly no tag at all.** |

**Resolved (Open Question #1), measured — not sampled — from the Matrixify seed export during B2/B5
orchestration.** Across all 10,001 orders in the export (2025-01-15 → 2025-12-13):

| Signal | Orders | Share |
|---|---|---|
| any `Browser: Landing Page` | 335 | 3.3% |
| any `utm_source` | 56 | 0.6% |
| landing page carries only `fbclid` | 97 | 1.0% |
| **`utm_content` is a numeric Meta ad ID** | **2** | **0.02%** |
| `utm_content` is a human-readable name | 48 | 0.5% |

The tags that exist are names (`RM_Instagram`, `New Sales Ad Set`, `RM_CBO_Remarketing_Campaign`,
`Navratri sale 15% OFF| AD`), not `{{ad.id}}`. `Browser: Ad URL` is empty on every row. Most Meta-driven
orders carry only `fbclid`, which is opaque and **cannot** be resolved to an ad without the Conversions API.
`utm_source` is also inconsistently spelled across `meta` / `roi_meta` / `facebook` / `RM_META`.

**Consequences, decided by the user — B7 must implement all three:**
1. **A UTM→ad-ID join alone would resolve 2 orders in 10,001.** B7 keys on `{{ad.id}}` for future orders and
   must not present historical Shopify-attributed ROAS as if it were meaningful.
2. **Build the name-matching fallback** (user's explicit decision) for the ~48 name-tagged orders, matching
   `utm_content`/`utm_campaign` against Meta entity names from B2. ⚠️ **Ad names are neither unique nor
   stable over time**, so a name match can attribute revenue to the wrong ad — every name-resolved order must
   be stored with its resolution method recorded and a lower confidence than an ID match, never silently
   merged with ID-resolved ones. Normalize the `utm_source` spellings when deciding what is Meta traffic.
3. Unresolvable orders are **excluded** from Shopify-attributed metrics, never reported as zero revenue
   (already the B7 spec). Expect `attributionCoverageRatio` near zero on historical data; C2/C3/D1 must lean
   on Meta-attributed figures for this period, and §6.2 forbids merging the two regardless.

**Still outstanding for the user (not blocking any step):** re-tag the live Meta account with
`utm_content={{ad.id}}` / `utm_campaign={{campaign.id}}` at the account-level URL-parameter setting.
Until that happens, coverage stays near zero for newly arriving orders too.

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
