// D6 — component tests for the React app (web/src). Separate config, separate environment
// (jsdom) from the root vitest.config.ts, which covers plain Node/ESM code (services/shared/
// web/server) and has no DOM. Run via `npm run test:web`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
    setupFiles: ["web/src/testSetup.ts"],
  },
});
