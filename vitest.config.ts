import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig.json's "paths" so runtime module resolution (Vitest/esbuild) matches
// what tsc type-checks. Keep these two in sync if the layout in IMPLEMENTATION_PLAN.md
// §0.2 changes.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@services": fileURLToPath(new URL("./services", import.meta.url)),
    },
  },
  test: {
    include: [
      "test/**/*.test.ts",
      "services/**/*.test.ts",
      "shared/**/*.test.ts",
      "web/server/**/*.test.ts",
    ],
    // Emulator-backed tests (name pattern *.emulator.test.ts) need a live Firestore emulator,
    // which needs a JVM on PATH. Keep them out of the default `npm run test` / `npm run check`
    // path so those stay usable on a machine without Java — see vitest.emulator.config.ts and
    // the `test:integration` script, which run only these files under `firebase emulators:exec`.
    // web/src (the React app) is excluded too — it has its own jsdom-environment config,
    // vitest.web.config.ts, run via `npm run test:web`.
    exclude: [
      "node_modules/**",
      "functions/**",
      "web/src/**",
      "web/dist/**",
      "**/*.emulator.test.ts",
    ],
  },
});
