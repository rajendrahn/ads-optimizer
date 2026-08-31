// Bundles the root ESM project's real ingestion logic into self-contained CommonJS files this
// package can `require()` — see functions/src/generated/syncBundle.d.ts for why this exists
// instead of functions/ importing /shared or /services directly (B1's module-system decision).
// B6 added a second entry point (services/ingest/shopify/webhooks/index.ts ->
// shopifyWebhookBundle.js) alongside B1's original (services/ingest/sync/index.ts ->
// syncBundle.js) — same reasoning, same pattern, its own hand-written
// functions/src/generated/shopifyWebhookBundle.d.ts mirror.
//
// Runs BEFORE `tsc` in `npm run build` (functions/package.json) so the .js files it writes are
// already sitting in lib/generated/ by the time tsc emits lib/index.js next to them; tsc does
// not clean outDir, so it leaves these files alone.
//
// `external` marks every package with native bindings (grpc via the various @google-cloud/*
// clients, firebase-admin, firebase-functions) so each bundle keeps a bare `require("...")` for
// them instead of inlining — Node resolves those at runtime from functions/node_modules (this
// package's own dependencies, kept in package.json), which avoids bundling two separate
// copies of firebase-admin (this package's + the root project's) into the same process with
// two separate `getApps()` registries. Pure-JS dependencies (zod) are left to bundle normally.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const functionsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(functionsDir);

const external = [
  "firebase-admin",
  "firebase-admin/*",
  "firebase-functions",
  "firebase-functions/*",
  "@google-cloud/tasks",
  "@google-cloud/storage",
  "@google-cloud/secret-manager",
  "@google-cloud/firestore",
];

const entries = [
  { entry: "services/ingest/sync/index.ts", outfile: "lib/generated/syncBundle.js" },
  {
    entry: "services/ingest/shopify/webhooks/index.ts",
    outfile: "lib/generated/shopifyWebhookBundle.js",
  },
];

for (const { entry, outfile } of entries) {
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(functionsDir, outfile),
    tsconfig: path.join(repoRoot, "tsconfig.json"),
    sourcemap: true,
    logLevel: "info",
    external,
  });
}
