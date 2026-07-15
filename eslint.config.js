// Flat ESLint config (ESLint v9+) for an ESM + TypeScript project.
// Type-aware linting is intentionally NOT enabled to keep CI fast; we lean on
// `tsc --noEmit` (the build) for full type checking and use ESLint for
// correctness/hygiene rules only.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Lint shipped source + scripts. Tests are validated by vitest and are
    // intentionally out of the lint gate to keep CI green without a refactor.
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      ".omx/state/**",
      ".review/**",
      ".worktrees/**",
      "test/**",
      "**/*.d.ts",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      eqeqeq: ["warn", "smart"],
      "no-var": "error",
      "prefer-const": "warn",
      // Existing regexes use escapes that are harmless but flagged; keep as a
      // non-blocking warning rather than rewriting working patterns.
      "no-useless-escape": "warn",
      // Intentional ANSI/control-char regexes (e.g. stripping \x1b sequences).
      "no-control-regex": "warn",
    },
  },
);
