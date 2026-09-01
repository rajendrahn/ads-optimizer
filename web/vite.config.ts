// D6 — the React app's build/dev config. Root is this `web/` directory (index.html lives here);
// `npm run dev:web` (root package.json) runs `vite --config web/vite.config.ts` from the repo
// root, and Vite resolves paths relative to THIS file's own directory, not the invoking cwd.
//
// The dev proxy is what lets the browser call same-origin `/api/...` during local development —
// the actual API process (`npm run dev:api`, web/server/server.ts) listens on a different port
// (8081 by default). This also means the browser never needs CORS headers in dev; server.ts's own
// CORS handling is a fallback for direct-to-Cloud-Run access once deployed behind a different
// origin than Firebase Hosting's rewrite (see server.ts's module comment).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.WEB_API_PROXY_TARGET ?? "http://localhost:8081",
        changeOrigin: true,
      },
    },
  },
});
