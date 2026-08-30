# Meta Ads GenAI Recommendation System

See `meta_ads_genai_recommendation_system_design_v2.md` for the system design and
`IMPLEMENTATION_PLAN.md` for how the build is sequenced. `SETUP.md` covers cloud
provisioning (GCP project, Meta app, Shopify app, Anthropic key).

## Repository layout

```
/functions        Cloud Functions — scheduled sync entrypoints (self-contained npm package)
/services
  /ingest         Meta + Shopify clients, sync tasks
  /analytics      normalization, features, statistics
  /evidence       decision evidence engines, packet builder
  /reasoner       Claude integration, tools, guardrails
/shared
  /schema         Firestore document types, zod validators
  /canon          reporting canon: timezone, currency, attribution
/web              React app
/scripts          one-off operational scripts (e.g. credential verification, the UTM audit)
/test             cross-cutting tests
```

Everything except `/functions` is one TypeScript project (`tsconfig.json`), run directly via
`tsx`/Vitest — no build step. `/functions` is a separate npm package because Cloud Functions
deploys require it to be self-contained; it has its own `package.json`, `tsconfig.json` and
build step (`npm run build` inside `functions/`).

## Prerequisites

- Node.js 20+ (developed against Node 24; Cloud Functions itself targets the Node 22 runtime —
  see `functions/package.json`'s `engines.node`).
- A JVM (Java 11+) on `PATH` — the Firestore and Functions emulators are Java-based and will
  fail to start without one. Not needed to run `npm run check`, only `npm run emulators`.
- The [Firebase CLI](https://firebase.google.com/docs/cli). It's installed locally as a dev
  dependency (`npx firebase ...`), so a global install isn't required, but `firebase login` /
  gcloud auth is still needed for anything that touches the real project.

## Local setup

```bash
npm install
npm --prefix functions install   # functions/ has its own node_modules — see layout note above
```

## Common commands

| Command                           | What it does                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run check`                   | typecheck + lint + format check + tests — the one command CI/you should run before considering a step done |
| `npm run typecheck`               | `tsc --noEmit` for both the root project and `functions/`                                                  |
| `npm run lint`                    | ESLint (flat config, `typescript-eslint` strict + stylistic)                                               |
| `npm run format` / `format:check` | Prettier write / check                                                                                     |
| `npm test`                        | Vitest, single run                                                                                         |
| `npm run emulators`               | Firebase emulator suite: Firestore, Auth, Functions (see Prerequisites — needs Java)                       |
| `npm run verify-credentials`      | A0 deliverable — proves live Meta/Shopify/Anthropic credentials work                                       |

## Running the emulators

```bash
npm run emulators
```

Starts Firestore (`:8080`), Auth (`:9099`) and Functions (`:5001`), with the Emulator UI at
`http://127.0.0.1:4000`. Project ID and region come from `.firebaserc` / `scripts/config.ts`
(`sng-meta-ads-optimizer`, Firestore region `asia-south1`, fixed permanently — see `SETUP.md`).

`firestore.rules` currently denies all client reads/writes (§17.1 of the design) as a
bootstrap; A2 replaces it with the full per-collection rule set and rules tests.
`functions/src/index.ts` is intentionally empty — the first real Cloud Functions entrypoints
land in B1.

## Path aliases

`@shared/*` → `shared/*`, `@services/*` → `services/*`, configured in `tsconfig.json` and
mirrored in `vitest.config.ts`. `tsx` resolves the same `tsconfig.json` paths natively, so
aliases work identically whether code runs under `tsx`, Vitest, or `tsc --noEmit`.
