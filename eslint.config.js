// @ts-check
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "functions/lib/**",
      "functions/node_modules/**",
      // D6: web/server is plain root-project TS (Node/ESM, same as services/shared) and is
      // linted by this config like everything else. web/src is the browser React app — it
      // needs browser globals + react-hooks/react-refresh rules this config doesn't carry, so
      // it has its own web/eslint.config.js instead (run via `npm run lint:web`).
      "web/src/**",
      "web/dist/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    rules: {
      // Allow an intentionally-unused arg/var to be named with a leading underscore
      // instead of erroring — common for callback signatures later steps won't fully use.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  eslintConfigPrettier,
);
