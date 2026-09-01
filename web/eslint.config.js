// D6 — eslint config for the browser React app only (web/src). Root eslint.config.js ignores
// web/src (it lints web/server, which is plain Node/ESM like the rest of the codebase, under the
// SAME root config instead — see that file's own comment). Run via `npm run lint:web`.
//
// The `no-restricted-imports` rule below is the structural half of the onSnapshot-vs-§17.1
// resolution (see web/server/server.ts's module comment for the full write-up): the browser
// bundle must never import `@shared/*`/`@services/*` (server-only, pulls in `firebase-admin`) or
// the Firestore client SDK — Firebase usage in this app is Auth only.
// @ts-check
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
      },
    },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@shared/*", "@services/*", "*/shared/*", "*/services/*"],
              message:
                "web/src is browser code — never import server-only modules from @shared/@services.",
            },
            {
              group: ["firebase/firestore", "firebase-admin", "firebase-admin/*"],
              message:
                "web/src must never read Firestore directly (§17.1) — all data is served through the API. This app's only Firebase usage is Auth.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
