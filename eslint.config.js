import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Must come last: switches off every rule that would fight the formatter.
  prettier,
  {
    files: ["**/*.ts"],
    rules: {
      // A leading underscore marks an identifier that is unused on purpose,
      // such as a callback parameter kept for its position in the signature.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // This package exchanges untyped JSON with tmux and the pi session
      // files. Warn, not error: reported, but not gating.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
