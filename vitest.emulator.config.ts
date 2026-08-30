import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Emulator-backed integration tests only (*.emulator.test.ts). Run via `npm run
// test:integration`, which wraps this config in `firebase emulators:exec` so
// FIRESTORE_EMULATOR_HOST is set and torn down automatically. Requires a JVM on PATH — see
// README.md Prerequisites. Not part of `npm run check` / `npm run test`; those use
// vitest.config.ts, which explicitly excludes this file pattern.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@services": fileURLToPath(new URL("./services", import.meta.url)),
    },
  },
  test: {
    include: [
      "test/**/*.emulator.test.ts",
      "services/**/*.emulator.test.ts",
      "shared/**/*.emulator.test.ts",
    ],
    exclude: ["node_modules/**", "functions/**"],
    // Emulator integration tests share one Firestore instance; running them in parallel
    // worker processes makes cross-test document collisions likelier for no real speed win
    // at this test count.
    fileParallelism: false,
  },
});
