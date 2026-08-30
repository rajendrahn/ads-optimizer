# Meta Ads GenAI Recommendation System

## Requirements and System Design — Revision 2

**Target platform:** Firebase / Google Cloud
**Primary recommendation reasoner:** Claude Fable 5 via the first-party Claude API
**Primary data sources:** Meta Ads + Shopify
**Architecture style:** Incremental ingestion, full recompute, evidence-first, uncertainty-aware

> **Revision note.** This supersedes the original requirements document, which has been removed — §31 is the
> full change log against it. The
> architecture is unchanged in spirit; the corrections are concentrated in four places: the decision
> altitude (§4), the measurement contracts that were previously assumed (§6, §7), the statistical layer
> (§15), and the removal of incremental-recompute machinery that this account is too small to need (§13).
> Sections marked **[CHANGED]** or **[NEW]** differ materially from revision 1. A change log is in §31.

---

## 1. Objective

Build a Firebase-based marketing intelligence and recommendation system that continuously combines Meta Ads
data, Shopify commerce data, creative intelligence, historical account changes, and statistical analysis to
answer questions such as:

- Should I increase the budget of this ad set?
- Which ad sets should I scale today?
- Which ads should I pause?
- Why did ROAS fall this week?
- Which creatives are fatigued?
- Which creative concepts should we make next?
- Which product categories are receiving too much or too little spend?
- Which campaigns are bringing new customers versus repeat customers?
- What happened after a previous budget increase?
- Which ads have strong CTR but weak purchase conversion?
- Which ads are bringing poor-quality or high-refund orders?
- Have we tested similar creatives before?
- Where should an additional daily budget be allocated?

The system must not re-download and re-process all historical data every time it runs. The first run
performs a historical backfill; subsequent runs fetch only new or potentially changed data.

**What changed:** the questions are now phrased at the level the data can actually support. See §4.

---

## 2. Account Profile and Operating Assumptions **[NEW]**

Every sizing decision in this document follows from these facts. If any of them changes by an order of
magnitude, revisit §13 (full recompute), §15 (statistical thresholds) and §22 (BigQuery).

| Dimension | Value |
|---|---|
| Brands / ad accounts | 1 / 1 |
| Active ads | < 100 |
| Orders per month, all sources | < 1,000 |
| Estimated Meta-attributed orders | ~600–700 / month |
| Shopify plan | Standard (not Plus) |
| Existing UTM tagging | In place — **must be audited for stable IDs, see §6.1** |
| Model platform | First-party Claude API (Vertex not required) |

### 2.1 The volume constraint

This is the single most important fact about the system:

```text
~650 Meta-attributed orders / month
÷ 20–40 ads actually spending
= roughly 4–8 purchases per ad per week
```

At that volume, an individual ad's ROAS is dominated by which orders happened to fall inside the window.
Two ads at 4.1 and 3.2 are routinely indistinguishable. Aggregated upward:

| Level | Approx. purchases / week | Inference viable? |
|---|---:|---|
| Ad | 4–8 | No — noise dominates |
| Ad set (5–8 active) | 20–35 | Marginal, workable on 28d |
| Creative family | Varies — pools across ads | Often better than ad level |
| Account | 150–175 | Yes |

Everything in §4 and §15 follows from this table.

---

## 3. Core Design Principles **[CHANGED]**

1. **Incremental ingestion, full recompute**
   Fetching is incremental — watermarks, reconciliation windows, webhooks. *Deriving* is not: at this
   scale, recomputing every feature on every sync is cheaper than the machinery required to avoid it.

2. **Evidence before GenAI**
   Deterministic code calculates metrics, trends, statistical confidence, change events, and candidate
   actions. The model does not compute base metrics from event rows.

3. **Evidence carries its own uncertainty** **[NEW]**
   A metric without an interval is not evidence at this volume — it is a number that invites false
   precision. Every performance figure entering a decision packet carries a sample size and an interval,
   or an explicit "not distinguishable" verdict.

4. **Decide at the altitude the data supports** **[NEW]**
   The ad set is the default decision unit; the ad is the default diagnostic unit. See §4.

5. **GenAI is the recommendation reasoner**
   Claude interprets structured evidence, may request more via tools, may inspect actual creative, and
   produces the final recommendation and explanation.

6. **Creative is first-class data**
   The system analyses the actual image/video creative, not only performance metrics or ad IDs.

7. **Creative identity is separate from ad identity**
   The same creative may run in multiple ads. Identity (cheap, hash-based) is separated from analysis
   (expensive, model-based) — see §11.

8. **Use business outcomes, not only Meta-reported ROAS**
   Shopify revenue, product mix, refunds, discounts, customer type, contribution margin. Meta-attributed
   and Shopify-attributed figures are **never merged into one number** — see §6.

9. **Change-aware analysis**
   Recent budget, targeting, status, and creative changes are considered before diagnosing performance
   shifts. Change history is derived from our own config snapshots, not Meta's activity feed (§9.2).

10. **Recommendations are structured data**
    Machine-readable action, confidence, reasons, risks, evidence version, outcome tracking.

11. **Human approval before writes; guardrails enforced in code**
    Initial versions are read-only. Guardrails are validated server-side *after* the model returns, never
    delegated to the model's own restraint (§20.2).

12. **Every accepted recommendation becomes learning data**
    Store what was recommended, whether it was accepted, what changed, and what happened afterward —
    measured against a shrunk baseline (§15.3).

---

## 4. Decision Altitude **[NEW]**

Revision 1 was built around the ad as the decision unit. At this account's volume that question usually has
no statistically answerable form (§2.1). The correction:

### 4.1 Rules

- **Budget decisions resolve at the budget owner.** The system already determines whether budget is owned
  at campaign or ad-set level; that owner is the decision unit. This is also where Meta's own optimisation
  operates, so it is the level at which a budget change has a defined meaning.
- **Ad-level questions are answered by escalation, not refusal.** When a user asks about a specific ad and
  that ad lacks volume, the evidence engine answers at its ad set and states plainly why:
  *"Ad XYZ has 6 purchases in 28 days — not enough to evaluate alone. Answering at ad set AS-17, which
  contains it (31 purchases)."* Returning `INSUFFICIENT_DATA` and nothing else is a failure of the product,
  not a display of rigour.
- **Ads are still ranked and diagnosed** — for pausing clear losers, spotting CTR/CVR mismatches, and
  creative diagnosis. Those are comparative and directional, not absolute-threshold, judgements.
- **Creative families pool across ads.** Where the same creative runs in several ads, family-level
  aggregation is often the highest-volume unit available below the ad set, and is the honest way to raise n.

### 4.2 Window set **[CHANGED]**

| Window | Role |
|---|---|
| ~~1 day~~ | **Removed from the decision path.** Noise with a number attached. |
| ~~3 day~~ | **Removed from the decision path.** Retained for display only, never for gating. |
| 7 day | Secondary. Trend direction only, never a threshold test. |
| 14 day | Secondary decision window. |
| 28 day | **Primary decision window.** |
| 56 day | Optional context for creative-family fatigue and seasonality. |

---

## 5. Reporting Canon **[NEW]**

Three global settings that must be fixed before any data is stored, because they cannot be retrofitted
without a rebuild.

```json
{
  "reportingTimezone": "Asia/Kolkata",
  "reportingCurrency": "INR",
  "attributionWindow": "7d_click_1d_view",
  "purchaseActionType": "offsite_conversion.fb_pixel_purchase"
}
```

### 5.1 Timezone

Meta reports daily insights in the **ad account's** timezone. Shopify timestamps orders in the **shop's**
timezone. Joining them into one "day" without normalisation silently moves revenue across day boundaries.

- Declare one reporting timezone. Convert both sources into it at normalisation time.
- Stamp every daily record with the timezone it was computed in.
- Display it in the UI freshness line, so a mismatch is visible rather than assumed away.

### 5.2 Currency

Single brand, non-Plus store — likely single-currency, so this is low risk. Still:

- Store an explicit currency code on every money field.
- If any order settles in a presentment currency other than the reporting currency, store the FX rate used
  on that record. Never convert without recording the rate.

### 5.3 Attribution window and action type

Meta returns different purchase counts depending on `action_attribution_windows` and on which action type
is read — `omni_purchase`, `offsite_conversion.fb_pixel_purchase`, and `purchase` are three different
numbers for the same week.

- Pin one window and one action type in settings.
- **Store both on every insight document.** They are part of the measurement, not configuration.
- When either changes, emit a first-class change event, and invalidate trend features that span the
  boundary rather than comparing across it.

---

## 6. Attribution Contract **[NEW]**

This section replaces the single word "attributed" that appeared throughout revision 1. It is the join on
which every business metric depends.

### 6.1 The join

Shopify orders are attributed to Meta ads by parsing UTM parameters from the order's `landing_site`.

```text
Ad destination URL
  ?utm_source=meta
  &utm_medium=paid
  &utm_campaign={{campaign.id}}
  &utm_content={{ad.id}}
      ↓
Shopify order.landing_site (query string preserved)
      ↓
Parse → adId → join to metaAds
```

**Audit required before backfill.** Tags must carry Meta's dynamic **ID** macros, not names. A tag built on
`{{ad.name}}` breaks the moment anyone renames an ad, and breaks *retroactively* for history already
stored. If current tags use names, re-tag before the historical import.

**Store the raw tag string** alongside the resolved ad ID on every order, so a future mapping correction can
be replayed from the archive without re-fetching.

### 6.2 What this join is, and is not

The store is not on Shopify Plus, so `customerJourneySummary` is unavailable — there is no multi-touch
journey data at any price. The join is therefore **first-touch, single-session**: it captures the landing
page of the session in which the order was placed.

Meta's own reported conversions use a modelled, multi-touch, cross-device window. **These two numbers will
disagree, permanently and structurally, and neither is wrong.**

### 6.3 Consequences

- **Never merge them.** `metaRoas` and `shopifyRoas` are carried side by side, always labelled, never
  averaged into "ROAS".
- **Add `attributionCoverageRatio`** — Shopify-attributed purchases ÷ Meta-reported purchases — as a
  first-class account and entity feature. Its *level* is not meaningful; its *drift* is. A sudden fall is
  the actual signal behind the `INVESTIGATE_TRACKING` recommendation type, which in revision 1 had no
  feature backing it.
- **Untagged-ad auditor.** A scheduled job parses the destination URL of every live ad. Any ad whose URL
  does not yield a resolvable ad ID is excluded from Shopify-attributed metrics and surfaced in the UI —
  never silently reported as zero revenue.

---

## 7. Main Data Domains

### 7.1 Meta Ads

Ingest and normalise: campaigns, ad sets, ads, creatives, daily insights, status at every level, budget
ownership and values, targeting, optimisation goal, bid strategy, placements, attribution settings, creative
asset metadata.

**Ingestion mechanics** **[CHANGED]** — revision 1 said only "respect API limits":

- **Historical insights backfill runs as asynchronous report jobs**: submit the request, poll
  `report_run_id`, then page the results. A synchronous insights call over a long range with breakdowns
  will fail.
- **Throttling is per business use case**, reported in the `X-Business-Use-Case-Usage` response header as
  a percentage of budget consumed. The sync controller reads that header and backs off *before* the account
  is throttled.
- A distinct `META_POLL_ASYNC_REPORT` task type keeps the backfill inside the Cloud Tasks retry model
  rather than fighting it.

Steady-state volume at under 100 ads is small; this matters mainly for the one-time backfill.

### 7.2 Shopify **[CHANGED]**

Build on the **GraphQL Admin API** — REST is legacy. Historical order backfill runs from a **Matrixify CSV
export**, not Bulk Operations and not the `read_all_orders` scope: Shopify gates API access to orders older
than 60 days behind an approval process, but a merchant-run Matrixify export of the store is not subject to
that restriction — confirmed on this account, where an export returned the full ~22.6K order history. The
API is used for everything after that one-time seed — incremental sync via `updated_at` watermark and
webhooks — which never needs to look further back than the rolling 60-day window `read_orders` already
grants.

Ingest and normalise: orders, line items, product/variant/SKU, product tags, discounts, order value,
refunds, cancellations, customer ID, new-versus-repeat, country/region, and `landing_site` /
`referring_site` for the attribution join (§6). New-versus-repeat is derived from each customer's order
sequence across the imported and synced data (first order chronologically = new), not read from any
single-order or point-in-time field.

**Funnel events** **[CHANGED].** Revision 1 listed product view, add-to-cart, checkout started and payment
info submitted as Shopify data. None of these exist in the Admin API — they require building and deploying
a Web Pixel extension with consent handling, which is a project in its own right.

**For v1, compute funnel rates from Meta's own reported actions** — `landing_page_view`, `add_to_cart`,
`initiate_checkout` — which arrive free with the insights already being fetched. Shopify supplies orders,
refunds, product mix and customer type only. Defer the web pixel until funnel diagnosis genuinely needs
first-party events.

### 7.3 Creative Data

For every unique creative asset store: Meta creative ID, asset hash, source reference, Cloud Storage path,
thumbnail, copy/headline/description, OCR text, video transcript, structured creative tags, embedding,
perceptual hash, creative family ID, analysis timestamp, analysis model/version.

**Composite creatives** **[NEW].** A dynamic or Advantage+ creative is a *set* of combinations whose
delivered mix is largely unobservable. It has no single asset hash and cannot join a creative family
cleanly. Model it explicitly:

```json
{
  "creativeType": "COMPOSITE",
  "memberAssetHashes": ["a1b2…", "c3d4…"],
  "deliveredMixObservable": false,
  "eligibleForFamilyFatigueScore": false
}
```

Exclude composites from family-level fatigue scoring rather than computing a score that cannot be defended.

Example structured creative attributes:

```json
{
  "productType": "temple_bridal_set",
  "presentation": "model_wearing",
  "persona": "south_indian_bride",
  "messagingAngle": "traditional_luxury",
  "hook": "product_showcase",
  "setting": "bridal_indoor",
  "humanPresent": true,
  "textOverlay": false,
  "offerPresent": false,
  "productProminence": 0.43,
  "creativeStyle": "polished_editorial"
}
```

---

## 8. Firestore Collections

Flat, top-level, single-account. Do **not** namespace speculatively — one brand, one ad account.

```text
metaCampaigns/          metaAdsets/           metaAds/
metaCreatives/          metaInsightsDaily/    metaEntitySnapshots/
metaChangeEvents/

shopifyOrders/          shopifyOrderLines/    shopifyRefunds/

creativeAssets/         creativeFamilies/

adFeatures/             adsetFeatures/        accountFeatures/

decisionPackets/        recommendations/      recommendationOutcomes/

syncState/              syncRuns/             backtestRuns/

aiConversations/        accountMemory/        settings/
```

`metaEntitySnapshots` and `metaChangeEvents` are new — see §9.2. `metaActivities` is demoted to optional
enrichment. `interventions` is folded into `recommendations`.

---

## 9. Synchronization

### 9.1 First run

Historical Meta entity import; historical daily insights via async report jobs; creative asset discovery
and hash-based identity; historical Shopify order, line, refund and customer import from a Matrixify CSV
export; initial config snapshot; historical feature computation; creative family construction from hashes.

Tracked explicitly as a backfill in `syncRuns`.

### 9.2 Change history from our own snapshots **[CHANGED]**

Revision 1 sourced change-aware features from Meta's account activity feed. That feed has limited
retention, inconsistent coverage of what actually changed, and no completeness guarantee — and the
change-aware features are among the most valuable things the system computes.

**On every config sync, snapshot** budget, status, targeting, bid strategy and creative assignment for every
entity into `metaEntitySnapshots`. Derive change events by diffing consecutive snapshots into
`metaChangeEvents`. At under 100 ads a full snapshot is a trivially small document set.

Meta's activity feed is used only for actor attribution — *who* made the change — and never as the record
that a change occurred.

### 9.3 Subsequent runs

```json
{
  "source": "meta",
  "resource": "insights",
  "accountId": "act_123",
  "lastSuccessfulSyncAt": "2026-08-29T01:30:00Z",
  "lastDataDate": "2026-08-28",
  "reconciliationDays": 14,
  "attributionWindow": "7d_click_1d_view",
  "status": "healthy",
  "lastRunId": "sync_abc123"
}
```

`status` distinguishes `healthy`, `no_new_data`, and `unauthorized` — see §9.6.

### 9.4 Reconciliation windows

Previously reported conversion totals change as attribution matures, so strict append-only sync is
insufficient.

- New Meta dates are fetched incrementally.
- A rolling 14-day window is re-fetched and upserted (configurable).
- A deeper reconciliation runs weekly over 60 days.
- Full historical backfill is not repeated unless explicitly requested or required by a schema migration.

### 9.5 Idempotency and write ordering **[CHANGED]**

Deterministic keys:

```text
metaInsightsDaily/{adId}_{date}
shopifyOrders/{shopifyOrderId}
creativeAssets/{assetHash}
```

Revision 1 said upserts should "replace the latest representation". That is unsafe for Shopify, whose
webhooks are **at-least-once and unordered** — a refund webhook can arrive before the order update it
follows, and blind replacement lets a stale payload overwrite fresher data with a write that succeeds.

**Guard every upsert with a monotonic version compare** on the source's own `updated_at`, rejecting writes
that would move a record backwards, and log the rejection in `syncRuns` so ordering problems stay
observable.

### 9.6 Credential lifecycle **[NEW]**

Secret Manager handles storage, not expiry. Meta long-lived user tokens last roughly 60 days; a silently
expired token becomes a sync that "succeeds" with zero new rows.

- Token refresh runs as a scheduled job.
- `syncState.status` distinguishes `no_new_data` from `unauthorized`, and the latter surfaces in the UI.

---

## 10. Processing Model **[CHANGED]**

### 10.1 Full recompute replaces affected-entity propagation

Revision 1 specified affected-entity propagation and a staleness-and-versioning scheme to avoid
recalculating the account on every change. **At under 100 ads with four windows, a full feature recompute
is a few thousand small reads and writes — well under a second of work.** The machinery required to avoid
it is more code, more state and more failure modes than the thing it optimises.

```text
Sync completes
    ↓
Recompute ALL entity features
    ↓
Bump accountDataVersion (one write per sync run)
    ↓
Mark all decision packets stale
```

One monotonic `accountDataVersion`, bumped once per sync run, gives cache validation, reproducibility and
auditability — everything the versioning scheme was for. There is no write contention at one bump per run.

Revision 1's affected-entity design is retained in an appendix as the scaling path, marked deferred.
Revisit it above roughly 1,000 active ads.

### 10.2 Cloud Tasks

A controller creates small retryable jobs rather than one `syncEverything()`:

```text
META_SYNC_ENTITIES          META_SYNC_INSIGHTS
META_POLL_ASYNC_REPORT      META_SNAPSHOT_CONFIG
SHOPIFY_SYNC_ORDERS         SHOPIFY_RECONCILE_ORDERS
AUDIT_AD_URL_TAGS           PROCESS_CREATIVE
RECOMPUTE_FEATURES          GENERATE_RECOMMENDATION
EVALUATE_RECOMMENDATION_OUTCOME
```

Each task is idempotent, has retry behaviour, respects API limits, records start/end/error status, and
updates its watermark only after successful completion.

---

## 11. Creative Identity and Analysis **[CHANGED]**

Revision 1 treated creative processing as one phase. It is two, with very different costs, and only the
cheap half is needed early.

### 11.1 Identity — cheap, ships in the data foundation

Group ads by Meta's own `image_hash` and `video_id`, plus a perceptual hash for near-duplicates. This costs
almost nothing, requires no model calls, and **directly serves §4** — pooling ads that share a creative is
one of the few honest ways to raise sample size at this volume.

### 11.2 Analysis — expensive, ships after the first decision type works

Download → Cloud Storage → OCR / transcript → structured creative analysis → embedding → similarity search
→ family refinement.

If an asset hash already exists: do not download it again, do not rerun vision analysis, do not recompute
the embedding unless the analysis model/version changed.

Bulk tagging runs through the **Message Batches API at half price** (§19.2).

### 11.3 Creative family metrics

Family age, total historical spend, active ads using the family, frequency/repetition signals, performance
trend, number of variations, fatigue/saturation score. Composites excluded from fatigue scoring (§7.3).

---

## 12. Derived Metrics

Computed for ad, ad set, campaign, creative family and account, over the window set in §4.2.

**Delivery** — spend, impressions, reach, frequency, CPM.
**Traffic** — clicks, CTR, CPC, landing page views.
**Funnel** — add to cart, checkout started, purchases, and the rates between them (from Meta actions, §7.2).
**Business** — Meta purchase value, Meta ROAS, Shopify-attributed purchases and revenue, Shopify net
revenue, `attributionCoverageRatio`, CPA, AOV, new-customer percentage and CPA, refund rate, estimated
contribution margin.
**Trend** — change versus previous equivalent window for ROAS, CPA, CTR, CVR, CPM, frequency; spend
velocity; purchase volume trend.

Every business metric carries `sampleSize` and an interval (§15).

---

## 13. Change-Aware and Delivery-State Features

```text
hoursSinceLastBudgetChange        lastBudgetChangePercent
hoursSinceLastAudienceChange      budgetChangesLast7Days
hoursSinceLastCreativeChange      creativeChangesLast7Days
hoursSinceLastStatusChange        targetingChangesLast14Days
```

### 13.1 Learning phase **[NEW — promoted from a footnote]**

Meta's learning phase exits at roughly 50 conversions per week per ad set. At an estimated 20–35 purchases
per ad set per week (§2.1), **several ad sets will sit below that threshold indefinitely**, and any material
budget edit restarts the clock. Learning-phase delivery is deliberately exploratory and unstable, which
means a large share of week-to-week ROAS movement has a mechanical cause unrelated to creative, audience or
price.

```text
inLearningPhase                   conversionsToExitLearning
learningResetAt                   learningResetCause
```

These sit **high in the decision packet**, because "it re-entered learning three days ago" is frequently the
correct answer to "why did ROAS move?". They also give the maximum-change guardrail (§20.2) a real mechanism
rather than a folk heuristic, and support a standing account-level recommendation toward **fewer, larger ad
sets**.

---

## 14. Decision Evidence Engine

Deterministic evidence is generated before the model is invoked. For a budget decision:

current budget owner and value · account targets · multi-window performance with intervals · Shopify
business performance · attribution coverage · funnel health · delivery stability · learning-phase state ·
creative fatigue · recent changes · statistical verdict · candidate safe action range.

```json
{
  "decisionUnit": { "type": "ADSET", "id": "AS_17" },
  "escalatedFrom": { "type": "AD", "id": "238591234", "reason": "SAMPLE_TOO_SMALL" },
  "eligibleToScale": true,
  "suggestedChangePercent": 15,
  "safeRangePercent": [10, 20],
  "confidence": 0.72,
  "evidence": {
    "roas28d": { "value": 3.91, "interval": [3.10, 4.82], "purchases": 128 },
    "roas28dShrunk": 3.74,
    "targetRoas": 3.0,
    "verdict": "ABOVE_TARGET",
    "cpa28d": { "value": 831, "interval": [702, 995] },
    "attributionCoverageRatio": 0.68,
    "ctrTrend": "STABLE",
    "cvrTrend": "UP",
    "frequency": 2.3,
    "inLearningPhase": false,
    "recentMajorChanges": false
  }
}
```

The deterministic output is evidence, not an instruction. The model may disagree, but must explain why using
evidence.

---

## 15. Statistical Requirements **[CHANGED — now mandatory, not deferred]**

Revision 1 framed these as capabilities to add "over time". At this account's volume they are the difference
between evidence and decorated noise, and principle 3 is false without them.

### 15.1 Minimum data thresholds

Below a configurable purchase floor over the primary window, the answer is `INSUFFICIENT_DATA` at that
altitude — and the engine escalates (§4.1) rather than stopping.

### 15.2 Intervals and verdicts

Every ROAS and CPA figure entering a packet carries an interval and an explicit three-state verdict:

```text
ABOVE_TARGET  ·  BELOW_TARGET  ·  NOT_DISTINGUISHABLE
```

The interval appears in the packet **text**, not only the JSON, so the model reasons over it rather than
past it.

### 15.3 Shrinkage and regression to the mean **[the correction that matters most]**

An entity is selected for scaling *because* its recent ROAS is high. Part of that height is real and part is
noise — and noise does not repeat. Measured ROAS therefore declines after scaling **on average even when the
decision was perfectly correct and had no effect at all**. Left uncorrected, outcome tracking records that
decline, account memory absorbs it, and confidence calibration learns that scaling does not work.

Three required corrections:

1. **Shrink observed ROAS toward the account mean**, weighted by purchase volume, before ranking or gating.
2. **Compare post-change performance against the shrunk baseline**, never the raw one.
3. **Label historical analogues as descriptive**, in the packet text — you only ever scaled what looked
   good, so "13 of 17 successful" describes past selection behaviour, not what scaling causes.

### 15.4 Historical analogues — deferred **[CHANGED]**

Revision 1's example showed 17 comparable scale events. At this account's rate of budget changes you will
accumulate perhaps ten to twenty per year *in total, across all shapes of change*. Below a minimum-N
threshold, **omit the section entirely** — "2 comparable events, 1 successful" is worse than silence,
because the model will use it. Keep storing them; they cost nothing and compound.

### 15.5 Later

Change-point detection, anomaly detection, saturation scores, marginal return estimates. Budget optimisation
should eventually reason about marginal return rather than historical average ROAS.

---

## 16. Architecture **[CHANGED]**

```text
                    ┌────────────────────┐
                    │      Web App       │
                    │ Firebase Hosting   │
                    │  + Firebase Auth   │
                    └─────────┬──────────┘
                              │ question
                              ▼
                    ┌────────────────────┐
                    │   API (Cloud Run)  │
                    │ writes PENDING doc │
                    │ enqueues the job   │───────┐
                    └─────────┬──────────┘       │
                              │                  ▼
                     onSnapshot subscription  Cloud Tasks
                              │                  │
                              ▼                  ▼
                    ┌────────────────────┐  ┌──────────────────┐
                    │     Firestore      │◀─│  Reasoner worker │
                    │ recommendations/   │  │   (Cloud Run)    │
                    └────────────────────┘  └────────┬─────────┘
                                                     │ tools
                                            ┌────────┴─────────┐
                                            │  Claude Fable 5  │
                                            └──────────────────┘
```

### 16.1 Why recommendation generation is a job, not a request

Revision 1 called the model synchronously from a Cloud Function. Two hard ceilings sit in that path:

- A request routed through a **Firebase Hosting rewrite times out at 60 seconds.**
- Fable 5 has thinking always on; a hard question at high effort with tool calls can run for minutes, and
  the browser gives up long before the model does.

**The pattern:** the API writes `recommendations/{id}` with status `PENDING`, enqueues the work on Cloud Run
via Cloud Tasks, and the client subscribes with `onSnapshot`. This is the idiomatic Firebase answer and
gives progress states for free. For streaming conversational follow-ups, use SSE from Cloud Run **directly**,
bypassing the Hosting rewrite.

### 16.2 Stack

| Capability | Technology |
|---|---|
| Frontend | React or Next.js |
| Hosting | Firebase Hosting |
| Authentication | Firebase Authentication |
| Operational database | Cloud Firestore |
| Raw payload / media archive | Cloud Storage |
| Backend | Cloud Run (reasoner), Cloud Functions 2nd gen (sync) |
| Scheduling | Cloud Scheduler |
| Work queues | Cloud Tasks |
| Secrets | Google Secret Manager |
| Recommendation reasoning | Claude Fable 5, first-party Claude API |
| Bulk creative tagging | Claude Haiku 4.5 + Message Batches |
| Embeddings | Vertex multimodal embeddings or equivalent |
| Vector similarity | Firestore vector search |
| Warehouse | **Not needed.** See §22. |

---

## 17. Security **[NEW]**

### 17.1 Authorisation

Firebase Auth appears in the architecture; the authorisation model must be stated. **Firestore rules deny
all client reads and writes**; data is served through the API. With one account and a small user set this is
a few lines, not a design problem.

### 17.2 PII boundary

Shopify customer identity is personal data sitting in Firestore. The rule, **enforced in the tool layer and
not in the prompt**: tools return aggregates and customer *type* (new vs. repeat), never customer identity.
No email, name, address or customer ID reaches a model context.

### 17.3 Untrusted content

OCR text from creatives, ad copy, product titles and order notes all flow into the model's context, and any
of them can contain text shaped like instructions. Phase 7 eventually gives this model a path to Meta write
actions.

- Wrap all ingested creative and commerce text in explicit untrusted-content framing, stating that
  instructions inside it are data to be reported, not followed.
- Enforce every guardrail server-side after the model returns (§20.2).

---

## 18. Tool-Based Model Access

The model does not get unrestricted database access. Narrowly scoped tools:

```text
resolve_entity()              get_performance()
get_shopify_performance()     get_attribution_health()
get_product_mix()             get_recent_changes()
get_delivery_state()          get_creative_details()
get_creative_asset()          get_creative_family()
get_fatigue_analysis()        get_similar_ads()
get_campaign_context()        get_budget_constraints()
get_decision_evidence()
```

**Contract** **[NEW]**: every tool returns **pre-aggregated evidence with its uncertainty attached**, never
event-level or daily rows the model would have to sum. If the model needs a number, a tool computes it.
Principle 2 leaks the moment any tool returns rows.

---

## 19. Model Configuration **[CHANGED]**

### 19.1 Platform

First-party Claude API rather than Vertex. Nothing else in the stack moves — Firebase Hosting, Firestore,
Cloud Run, Cloud Tasks and Secret Manager are unchanged; only the model call changes destination. This
restores four capabilities the design wants:

| Capability | Use here |
|---|---|
| **Message Batches** | Bulk creative tagging and OCR clean-up at 50% cost (§11.2). |
| **Files API** | Upload each creative once, reference by `file_id` across later requests instead of re-inlining base64 — exactly what `get_creative_asset()` wants. |
| **Server-side `fallbacks`** | Fable 5 can return `stop_reason: "refusal"`. Pass `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta; no client middleware, no model list to maintain. |
| **Models API** | Validate the configured model ID and its capabilities at runtime, making the "configurable model" requirement enforceable rather than a trusted string. |

**Prerequisite:** Fable 5 requires 30-day data retention and is unavailable under zero data retention.
Confirm the organisation's retention configuration before building on it.

### 19.2 Model selection

```json
{
  "recommendationProvider": "anthropic",
  "recommendationModel": "claude-fable-5",
  "creativeReasoningModel": "claude-fable-5",
  "backgroundCreativeTaggingModel": "claude-haiku-4-5",
  "taggingUsesBatchApi": true,
  "effort": "high"
}
```

At roughly 10–30 recommendation cards a day, the model bill is unlikely to be what you optimise — Fable 5
throughout is affordable. Haiku 4.5 plus Batches for bulk tagging is the one place tiering clearly pays.

### 19.3 API behaviour to design around

- **Thinking is always on.** Omit the `thinking` parameter; `{type: "disabled"}` and `budget_tokens` both
  return 400. Control depth with `output_config.effort`.
- **No sampling parameters.** `temperature`, `top_p`, `top_k` are removed — a 400. Determinism comes from
  structured outputs, not `temperature: 0`.
- **No assistant prefill.** Shape responses with `output_config.format`.
- **Always check `stop_reason` before reading content.**
- **Prompt caching:** order the prefix *tools → system → account context → packet*, volatile content last.
  Verify with `usage.cache_read_input_tokens`; if it stays zero, something in the prefix is changing between
  calls.

### 19.4 Provenance

Every recommendation stores: model, provider, prompt version, decision-engine version, feature version,
data version, generated timestamp, data-fresh-through timestamp.

---

## 20. Recommendations

### 20.1 Structured output

```json
{
  "recommendation": "INCREASE_BUDGET",
  "decisionUnit": { "type": "ADSET", "id": "AS_17" },
  "currentBudget": 10000,
  "recommendedBudget": 11500,
  "changePercent": 15,
  "confidence": 0.72,
  "summary": "Increase the budget by 15%. Performance over 28 days is above target with adequate volume, and the ad set is out of the learning phase.",
  "primaryReasons": [
    "28-day ROAS 3.91 (interval 3.10–4.82) against a 3.0 target, on 128 purchases",
    "shrunk ROAS 3.74 still above target",
    "conversion rate improving",
    "out of learning phase for 19 days",
    "creative fatigue low"
  ],
  "risks": [
    "Attribution coverage is 0.68 — Shopify sees roughly two-thirds of Meta-reported purchases",
    "A 15% increase may re-enter the learning phase at current conversion volume"
  ],
  "doNotDo": ["Do not increase by 30% or more in one step"],
  "recheckConditions": {
    "minimumAdditionalSpend": 15000,
    "minimumAdditionalPurchases": 15
  }
}
```

Allowed types: `INCREASE_BUDGET`, `REDUCE_BUDGET`, `HOLD`, `PAUSE`, `RESTART`,
`LAUNCH_NEW_CREATIVE_TEST`, `REFRESH_CREATIVE_FAMILY`, `INVESTIGATE_LANDING_PAGE`,
`INVESTIGATE_PRODUCT_OR_PRICE`, `INVESTIGATE_TRACKING`, `CONSOLIDATE_ADSETS`, `INSUFFICIENT_DATA`.

`CONSOLIDATE_ADSETS` is new — it follows directly from §13.1.

### 20.2 Guardrails enforced in code **[CHANGED]**

Guardrails are **validated server-side after the model returns**, not delegated to the model:

- No automatic Meta writes.
- Budget change above the configured maximum percentage → rejected.
- Minimum spend and purchase requirements not met → rejected, downgraded to `INSUFFICIENT_DATA`.
- Decision unit is not the actual budget owner → rejected.
- Confidence reduced after very recent major edits, and for composite creatives.
- Recommendations expire when their evidence version is superseded.
- Every user-approved action is audited.

A rejected recommendation is logged with its rejection reason — that log is itself a calibration signal.

---

## 21. Outcome Tracking and Learning **[CHANGED]**

### 21.1 Evaluate on evidence, not on the calendar

Revision 1 defined `recheckConditions` in spend and purchases — correct — and then evaluated outcomes on
`roas3d` and `cpa3d`. At this volume three days is perhaps two purchases.

**One rule: evaluate when the recheck conditions are met.** Never on a fixed number of days.

```json
{
  "recommendationId": "rec_123",
  "outcome": {
    "evaluatedAt": "2026-09-14T00:00:00Z",
    "triggeredBy": "RECHECK_CONDITIONS_MET",
    "additionalSpend": 15840,
    "additionalPurchases": 17,
    "roasAfter": 3.82,
    "baselineShrunk": 3.74,
    "classification": "NEUTRAL"
  }
}
```

Comparison is against the **shrunk** baseline (§15.3).

### 21.2 Backtest harness **[NEW]**

The success criteria in revision 1 were all capabilities — "can answer", "can track" — none about quality.
The learning loop needs many months of interventions before it says anything, and at this account's rate of
budget changes that may be a year.

The raw archive already makes replay possible: **generate the recommendation you would have made on a past
date using only data available then, and compare against what actually happened.** Score confidence with a
Brier score. Build this before trusting the loop, and before adding the second decision type.

### 21.3 Memory

**Account memory** — longer-term learned patterns, grounded in statistics rather than unverified model
summaries. **Entity memory** — history of a campaign, ad set, ad, creative family or product category.
**Conversation memory** — recent questions and prior recommendations, for conversational continuity only.

---

## 22. Data Volume and BigQuery **[CHANGED]**

Revision 1 treated BigQuery as "optional for the first release, add later". At this account's volume you can
treat it as **not needed**: under 100 ads × 365 days is roughly 36,000 insight documents a year, and under
12,000 orders. Firestore will hold years of this comfortably.

Revisit only if the account grows by an order of magnitude, or if multi-year ad × SKU × customer exploration
becomes a recurring need.

---

## 23. Raw Data Archive

```text
/raw/meta/YYYY/MM/DD/…
/raw/shopify/YYYY/MM/DD/…
```

For debugging, replay after feature-engine changes, reprocessing after schema changes, **the backtest
harness (§21.2)**, and reduced dependence on re-downloading history from external APIs.

---

## 24. Recommendation UI

Cards showing: recommended action · decision unit, with escalation stated if it occurred · current and
recommended value · confidence · primary reasons · risks · supporting evidence with sample sizes and
intervals · data freshness timestamp **and reporting timezone** · attribution coverage · creative preview ·
accept/reject · optional "Why?" follow-up.

Initial release is read-only or approval-only.

**Display rules:** never show a ROAS without its sample size. Never show Meta-attributed and
Shopify-attributed figures without labelling which is which.

---

## 25. Processing Schedule

| Process | Frequency |
|---|---:|
| Shopify webhooks | Real time |
| Shopify reconciliation | Hourly |
| Meta config sync + snapshot | Every 30–60 minutes |
| Meta insights refresh | Hourly |
| Full feature recompute | After every sync |
| Untagged-ad audit | Daily |
| New creative identity | Immediately after discovery |
| Creative analysis (batch) | Daily |
| Recent attribution reconciliation | Nightly |
| Deeper historical reconciliation | Weekly |
| Token refresh check | Daily |
| Recommendation outcome evaluation | When recheck conditions are met |

---

## 26. Example User Flow

```text
"Should I increase the budget of Ad XYZ?"
    ↓
Resolve Ad XYZ → parent ad set → campaign
    ↓
Determine actual budget owner
    ↓
Check sample size at ad level
    ↓  (6 purchases / 28d — below floor)
Escalate to ad set AS-17, record escalation reason
    ↓
Build decision packet: performance with intervals · shrunk baseline ·
Shopify metrics · attribution coverage · changes · learning state ·
creative fatigue
    ↓
Write recommendations/{id} as PENDING, enqueue job
    ↓
Claude Fable 5 reasons over evidence, may call tools
    ↓
Structured recommendation → server-side guardrail validation
    ↓
Firestore write → client onSnapshot → card
    ↓
User accepts / rejects
    ↓
Outcome evaluated when recheck conditions are met
```

---

## 27. Initial Recommendation Categories

**Budget** (at the budget owner) — increase, reduce, hold.
**Ad status** — hold, pause, insufficient data.
**Account structure** — consolidate ad sets (§13.1).
**Creative** — fatigue likely, refresh family, launch differentiated concept, test new format/hook/offer.
**Funnel diagnosis** — creative, landing page, product/price, checkout, tracking discrepancy.

Audience changes are supported but are not a central optimisation category in the first release.

---

## 28. Implementation Order **[CHANGED]**

Six slices. One decision type runs end to end by Slice 3.

### Slice 0 — Decisions and one audit

1. Pin attribution window and purchase action type (§5.3)
2. Choose reporting timezone and currency (§5.1, §5.2)
3. Confirm the organisation's data-retention configuration supports Fable 5 (§19.1)
4. **Audit existing UTM tags for stable IDs rather than names (§6.1)** — the one item that could force a
   re-tagging pass before backfill

### Slice 1 — Data foundation

5. Firestore schema and security rules (§8, §17.1)
6. Meta entity and insights importer, async report jobs, BUC throttling (§7.1)
7. Config snapshotting and change-event derivation (§9.2)
8. Shopify GraphQL importer, Bulk Operations backfill, webhook version guards (§7.2, §9.5)
9. `syncState` / `syncRuns`, token refresh (§9.3, §9.6)
10. Raw payload archiving (§23)
11. Hash-based creative identity and families (§11.1)

### Slice 2 — Metrics that carry their own uncertainty

12. Daily normalised metrics in the reporting canon (§5)
13. Full feature recompute across the §4.2 window set (§10.1)
14. UTM attribution join, untagged-ad auditor, coverage ratio (§6)
15. Funnel rates from Meta actions (§7.2)
16. Purchase floors, intervals, verdicts, shrinkage (§15)
17. Learning-phase features (§13.1)

### Slice 3 — One decision, end to end, at ad-set altitude

18. Scaling evidence engine with escalation (§4.1, §14)
19. Decision packets
20. Job-and-snapshot recommendation pipeline (§16.1)
21. Tool interface (§18)
22. Recommendation schema and server-side guardrail validation (§20)
23. Recommendation card UI, accept/reject (§24)

**This is the first version worth using.**

### Slice 4 — Proof it works

24. Backtest harness over the raw archive (§21.2)
25. Outcome evaluation on recheck conditions (§21.1)
26. Confidence calibration scoring

### Slice 5 — Creative intelligence

27. Asset download and cache
28. OCR and transcript
29. Structured creative analysis via Batches (§11.2)
30. Embeddings and similarity search
31. Creative-family refinement, fatigue and saturation features
32. Creative inspection in the reasoner

### Slice 6 — Widen, then write

33. Pause/hold, funnel-diagnosis and creative-refresh evidence engines
34. Account-level learned patterns
35. Historical analogue engine, once minimum-N is reached (§15.4)
36. Meta write permissions, human approval workflow, execution, rollback metadata, audit trail

---

## 29. Success Criteria **[CHANGED]**

Capability criteria:

1. One historical backfill without requiring future full re-downloads.
2. Incremental synchronisation of Meta and Shopify data.
3. Recent attribution changes corrected through reconciliation windows.
4. Unchanged creative assets never reprocessed.
5. Meta performance linked to Shopify business outcomes, with both attributions labelled and never merged.
6. Recent changes explained as candidate causes of performance movement.
7. Entity questions answered at the altitude the data supports, with escalation stated.
8. Structured recommendations with action, confidence, reasons, risks — and sample sizes.
9. Acceptance and subsequent performance tracked against a shrunk baseline.

Quality criteria **[NEW]** — the ones that actually matter:

10. **The backtest harness runs**, and recommendations replayed against history beat a naive
    "scale whatever had the highest recent ROAS" baseline.
11. **Confidence is calibrated** — Brier score improving, and recommendations issued at 0.8 confidence
    succeed roughly 80% of the time.
12. **No recommendation is ever issued on a sample the system cannot defend**, measured by the rate of
    guardrail rejections trending toward zero as the evidence engine improves.

---

## 30. Final Architectural Principle

```text
Analytics Engine           →  what happened
Decision Evidence Engine   →  what the data supports, and how strongly
Claude Fable 5             →  what to do about it, and why
```

The Analytics Engine establishes what happened. The Decision Evidence Engine establishes what the data
supports **and how confidently** — at this account's volume, the second half of that sentence is the harder
and more valuable half. Claude Fable 5 interprets the evidence, weighs competing explanations, examines
creative context, and gives the final recommendation.

This separation keeps the system auditable, cost-efficient and trustworthy. The uncertainty layer is what
keeps it *honest*.

---

## 31. Change Log from Revision 1

### Corrections that prevent wrong output

| # | Change | Section |
|---|---|---|
| 1 | Decision altitude moved from ad to ad set, with escalation; 1d/3d windows removed from the decision path | §4 |
| 2 | Attribution window and purchase action type pinned and stored per record | §5.3 |
| 3 | Canonical reporting timezone and currency established | §5.1, §5.2 |
| 4 | Recommendation generation changed from a synchronous call to a job with `onSnapshot` — a Hosting rewrite times out at 60s | §16.1 |
| 5 | Shrinkage made mandatory; outcomes compared against shrunk baselines; analogues labelled descriptive | §15.3 |

### Gaps closed

| # | Change | Section |
|---|---|---|
| 6 | Attribution join fully specified: UTM contract, ID-not-name audit, first-touch limitation, coverage ratio, untagged-ad auditor | §6 |
| 7 | Change history derived from own config snapshots rather than Meta's activity feed | §9.2 |
| 8 | Funnel events sourced from Meta actions for v1; Shopify web pixel deferred; GraphQL Admin API adopted | §7.2 |
| 9 | Monotonic version guards on all upserts | §9.5 |
| 10 | Async report jobs and BUC-header throttling specified | §7.1 |
| 11 | Untrusted-content framing; guardrails enforced server-side after the model returns | §17.3, §20.2 |
| 12 | Firestore deny-all rules and a tool-layer PII boundary | §17 |
| 13 | Learning-phase features added and placed high in the packet; `CONSOLIDATE_ADSETS` added | §13.1, §20.1 |
| 14 | Outcome evaluation moved from fixed days to recheck conditions | §21.1 |
| 15 | Backtest harness added, before the learning loop is trusted | §21.2 |
| 16 | Composite/dynamic creatives given an explicit type and excluded from family fatigue | §7.3 |
| 17 | Tool contract fixed to aggregates-with-uncertainty only | §18 |
| 18 | Credential lifecycle and `unauthorized` sync state | §9.6 |

### Simplifications

| # | Change | Section |
|---|---|---|
| 19 | Affected-entity propagation and per-entity version vectors removed; full recompute per sync | §10.1 |
| 20 | Tenancy namespacing rejected — flat collections are correct for one account | §8 |
| 21 | BigQuery moved from "later" to "not needed" | §22 |
| 22 | Historical analogue engine deferred until minimum-N is reachable | §15.4 |
| 23 | Creative work split — cheap hash identity early, expensive analysis after the first decision type | §11 |
| 24 | Platform moved from Vertex to the first-party API, restoring Batches, Files API, server-side fallbacks and the Models API | §19.1 |
