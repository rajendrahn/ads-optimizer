// Bundles services/ingest/sync/index.ts (the root ESM project's real B1 logic) into one
// self-contained CommonJS file this package can `require()` — see
// functions/src/generated/syncBundle.d.ts for why this exists instead of functions/ importing
// /shared or /services directly.
//
// Runs BEFORE `tsc` in `npm run build` (functions/package.json) so the .js it writes is
// already sitting in lib/generated/ by the time tsc emits lib/index.js next to it; tsc does
// not clean outDir, so it leaves this file alone.
//
// `external` marks every package with native bindings (grpc via the various @google-cloud/*
// clients, firebase-admin, firebase-functions) so the bundle keeps a bare `require("...")` for
// them instead of inlining — Node resolves those at runtime from functions/node_modules (this
// package's own dependencies, kept in package.json), which avoids bundling two separate
// copies of firebase-admin (this package's + the root project's) into the same process with
// two separate `getApps()` registries. Pure-JS dependencies (zod) are left to bundle normally.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const functionsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(functionsDir);

await build({
  entryPoints: [path.join(repoRoot, "services/ingest/sync/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(functionsDir, "lib/generated/syncBundle.js"),
  tsconfig: path.join(repoRoot, "tsconfig.json"),
  sourcemap: true,
  logLevel: "info",
  external: [
    "firebase-admin",
    "firebase-admin/*",
    "firebase-functions",
    "firebase-functions/*",
    "@google-cloud/tasks",
    "@google-cloud/storage",
    "@google-cloud/secret-manager",
    "@google-cloud/firestore",
  ],
});
