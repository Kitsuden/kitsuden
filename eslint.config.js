/**
 * Kitsuden ESLint Configuration — Flat Config (ESLint v9)
 * Style and code-quality only; type-checking is handled by `tsc --noEmit`.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import svelte from "eslint-plugin-svelte";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // ── Ignored paths ──
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.svelte-kit/**",
      "**/drizzle/**",
      "**/*.config.*",
      "**/_legacy_*/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.d.ts",
      "**/*.d.ts.map",
      "**/.claude/**",
      "**/.git/**",
      "**/*.json",
      "**/*.md",
      "**/*.log",
      "**/*.sql",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.min.js",
      "**/*.min.css",
      "**/*.svelte",
      "**/*.svelte.ts",
      "**/*.svelte.js",
      "**/*.bin",
      "packages/testing/diag.ts",
      "packages/cli/test-vibecoder-app/**",
      "**/.venv*/**",
      "packages/admin/.venv-admin/**",
      "**/tmp_*.py",
      // Bundler output left loose in the tree (it is in .gitignore,
      // but ESLint's flat config does NOT read .gitignore). They are files of
      // a single line of up to 8 MB: when linting them, the results cache is
      // serialized and blows up with `RangeError: Invalid string length`, so
      // `pnpm lint` —and with it `pnpm qa`— never finished locally.
      "**/tmp_build_*/**",
      // `gamedata/` is in .gitignore: loose scrapers and cloned third-party
      // repositories (~860 JS/TS files). It is not product code and,
      // since the flat config does not read .gitignore, `pnpm lint` walked all of them
      // with `import/no-cycle` and took over 40 minutes.
      "gamedata/**",
      // tallao, copied by scripts/sync-tallao.mjs: generated, never edited by hand.
      "packages/admin/src/lib/tallao/**",
      // The built sites (`dist-*` of a starter that builds several). The
      // `**/dist/**` above does not cover them: ESLint went into the Astro
      // bundles and, if a build regenerated them at the same time, crashed with ENOENT.
      "**/dist-*/**",
      "**/.astro/**",
      "**/tserrors-*.txt",
      "**/build-diag*.txt",
      "**/kitsuden_progress.txt",
      "**/progress.txt",
      "**/tmp_labels.txt",
      "**/null",
      "**/api.err",
      "**/api.log",
      "**/*.test-results.*",
    ],
  },

  // ── Base: recommended JS + TS (no type-checking) ──
  {
    files: ["**/*.{js,mjs,cjs,ts,svelte}"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,

  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        Bun: true,
        $state: true,
        $derived: true,
        $effect: true,
        $effect_pre: true,
        $props: true,
        $bindable: true,
        $inspect: true,
        $host: true,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["./tsconfig.json", "./apps/*/tsconfig.json", "./packages/*/tsconfig.json"],
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",

      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import/no-unresolved": "off",
      "import/no-cycle": "warn",
      "unused-imports/no-unused-imports": "warn",

      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-debugger": "error",
      "prefer-const": "warn",
      "no-var": "error",
      "object-shorthand": "warn",
      // `x != null` is the idiom for "neither null nor undefined" and is used on
      // purpose throughout the repo. Flagging it pushes people to "fix" it to `!== null`,
      // which lets `undefined` through — i.e. the rule was generating bugs instead
      // of preventing them. With `null: "ignore"` the real `==` is still pursued,
      // the one that hid the failure of the dataset filters.
      eqeqeq: ["warn", "always", { null: "ignore" }],
      // The zero-width spaces found around the repo are NOT pasted junk:
      // they are inside JSDoc, and serve to write a `*` followed by `/`
      // inside the comment itself without closing it. It is the only way to
      // document a glob like `packages/core/*​/migrations` or to quote
      // `import(/* @vite-ignore *​/ ...)`. Removing them would break the comment;
      // so the check is skipped THERE and only there — in real code, an irregular
      // space is still an error.
      "no-irregular-whitespace": ["error", { skipComments: true }],
      "no-useless-escape": "off",
      "no-empty": "off",
      "no-case-declarations": "off",
      "import/export": "off",
      "no-async-promise-executor": "off",
      "no-duplicate-case": "off",
      "svelte/no-useless-children-snippet": "off",
    },
  },

  // ── Test files ──
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.js", "**/*.spec.js"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },

  // ── Scripts, CLI and test runners ──
  // `console` is the user interface here (not server logging), so
  // the rule does not apply: the CLI prints to stdout by design, the codegen scripts
  // report their progress and the homemade runners (pre-bun:test) show results.
  //
  // The seeds and the test harness are added for the same reason: they are invoked by
  // hand from a terminal and a person reads their output. Sending them through pino
  // would turn "✅ 12 users created" into a line of JSON.
  //
  // What does NOT belong here is code that runs PER REQUEST or PER JOB. There
  // `console.log` is a defect: the line comes out without `trace_id` or
  // `request_id`, so it cannot be correlated with anything and the structured
  // logging set up by `accessLogAndMetrics` stops being useful exactly when
  // it is needed. Those go to the logger.
  {
    files: [
      "**/scripts/**",
      "**/migrations/**",
      "packages/cli/**",
      "**/test-*.ts",
      "**/*.test.ts",
      "**/db/seed*.ts",
      "apps/api/src/tests/**",
    ],
    rules: {
      "no-console": "off",
    },
  },

  // ── Firewall between kons ──
  //
  // A kon does not choose the version of the pieces the engine controls: it
  // imports them from the engine. That way there is ONE version of Zod in the whole monorepo and
  // upgrading it is a change in one place (the Zod 4 migration touched 59 files).
  //
  //   · zod → `@kitsuden/engine/zod` (pure) or `@kitsuden/engine`.
  //   · bullmq → the queue is Postgres-based (the engine's `queue`); BullMQ was removed.
  //
  // `drizzle-orm` and `hono` are NOT forbidden on purpose: they are part of the contract
  // of a kon (88 and 83 files use them: pgTable, eq, sql, Hono) and it is enough to
  // pin a single version in the monorepo.
  {
    files: ["packages/kons/**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "zod",
              message: 'Kons import Zod from the engine: import { z } from "@kitsuden/engine/zod".',
            },
            {
              name: "bullmq",
              message: 'The queue is Postgres-based: import { queue } from "@kitsuden/engine".',
            },
          ],
          patterns: [
            {
              group: ["zod/*"],
              message: 'Kons import Zod from the engine: import { z } from "@kitsuden/engine/zod".',
            },
          ],
        },
      ],
    },
  },

  // ── Prettier must be last ──
  prettier
);
