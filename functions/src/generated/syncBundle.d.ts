// Hand-written ambient declaration for the esbuild-bundled artifact produced by
// functions/scripts/bundle.mjs from services/ingest/sync/index.ts (the root ESM project).
//
// IMPLEMENTATION_PLAN.md B1's module-system decision, in one place: `functions/` stays plain
// CommonJS with its original `rootDir: "src"` (A1's scaffold, untouched) and can therefore
// never `import` a file outside `src/` — `/shared` and `/services` live outside it, and are
// ESM anyway. Rather than restructure `functions/`'s tsconfig to reach across that boundary
// (fragile: it would tie functions/'s build to the whole repo's module graph, dependency
// versions, and rootDir rules) or force the ENTIRE repo onto one module system, B1 treats
// `functions/` as a thin deploy shim: the real logic is built, tested and typechecked entirely
// in the root ESM project (services/ingest/sync/**, using the existing @shared/@services path
// aliases, vitest, and the Firestore emulator exactly as A2–A4 already do), then bundled by
// esbuild — which transpiles TS without needing tsc's project settings at all — into one
// self-contained CommonJS file this package requires like any other dependency.
//
// This file is what makes that safe under `tsc`: `functions/src/index.ts` imports from
// "./generated/syncBundle" (no extension), and TypeScript's classic module resolution finds
// THIS .d.ts sitting right next to where the real syncBundle.js will be — so `npm run
// typecheck` (which runs `tsc --noEmit -p functions/tsconfig.json`) passes whether or not the
// bundle has actually been built yet. The real .js is generated only by `npm run build` (see
// functions/package.json), lands at functions/lib/generated/syncBundle.js (gitignored, like
// the rest of functions/lib/), and is what Node actually loads at runtime.
//
// Trade-off, stated plainly: this .d.ts is a manually-maintained mirror of
// services/ingest/sync/index.ts's public surface. Nothing enforces the two stay in sync except
// this comment and whoever edits one remembering the other exists — a real type-level
// mismatch would only surface by actually building the bundle and running functions code
// against it, not from `tsc` alone. Keep this declaration to the smallest surface
// functions/src/index.ts actually needs (currently: one dispatch function) to minimize that
// risk.

// Deliberately NOT wrapped in `declare module "./generated/syncBundle" { ... }` — this file
// IS that module: TypeScript's classic (Node10) resolution, resolving the specifier
// "./generated/syncBundle" from functions/src/index.ts, finds this .d.ts directly by path
// (the same way it would find a sibling .ts file), so plain top-level ambient declarations are
// enough. A `declare module` wrapper here would additionally have to be resolved relative to
// THIS file's own directory, which is a different (and wrong) path.

export interface TaskDispatchRequestBody {
  taskType: string;
  payload: unknown;
  taskId?: string;
}

export interface TaskDispatchResponseBody {
  runId: string;
  status: string;
  error?: string;
  summary?: Record<string, unknown>;
}

export interface TaskDispatchResponse {
  status: number;
  body: TaskDispatchResponseBody;
}

/** The real Cloud Tasks dispatch entry point — see services/ingest/sync/runtime.ts. */
export declare function handleSyncTaskDispatch(
  request: TaskDispatchRequestBody,
): Promise<TaskDispatchResponse>;
