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
      "web/**",
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
