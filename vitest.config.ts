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
    include: ["test/**/*.test.ts", "services/**/*.test.ts", "shared/**/*.test.ts"],
    exclude: ["node_modules/**", "functions/**"],
  },
});
