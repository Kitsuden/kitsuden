// Vitest Configuration for Unit Tests

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "path";

import { defineConfig } from "vitest/config";

/**
 * Tests that need a kon that is NOT installed → outside the suite.
 *
 * The kons live in the kitsuden-kons repo and are installed in
 * packages/kons/<kon>/ (`kitsuden kon add`). A kon's own tests went away
 * with it; the core's remain here, and some use a kon as an example
 * (idempotency with kon-ecommerce, Inti's contract with kon-games…). In a clean clone,
 * with no kons, those have nothing to test: they are excluded and it says
 * which ones, instead of failing with an ENOENT that looks like a core error.
 */
function testsWithMissingKons(): string[] {
  const dir = path.resolve(__dirname);
  const root = path.resolve(__dirname, "../..");
  const outside: string[] = [];
  const absent = new Set<string>();
  const patterns = [
    /packages\/kons\/(kon-[a-z0-9-]+)/g,
    /"packages",\s*"kons",\s*"(kon-[a-z0-9-]+)"/g,
    /from\s+"@kitsuden\/(kon-[a-z0-9-]+)/g,
    // read("kon-members/migrations/…") and similar: paths relative to packages/kons
    /["'`](kon-[a-z0-9-]+)\/(?:migrations|src|admin|graphics)\//g,
  ];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".test.ts")) continue;
    const text = readFileSync(path.join(dir, name), "utf8");
    // A test that NAMES a kon without needing it (e.g. one that checks that
    // it does NOT exist) says so with this marker and is never excluded.
    if (text.includes("kitsuden-test: needs-no-kons")) continue;
    const kons = new Set<string>();
    for (const pattern of patterns) for (const m of text.matchAll(pattern)) kons.add(m[1]!);
    const areMissing = [...kons].filter((k) => !existsSync(path.join(root, "packages", "kons", k)));
    if (areMissing.length) {
      outside.push(`tests/unit/${name}`);
      areMissing.forEach((k) => absent.add(k));
    }
  }
  if (outside.length) {
    console.log(
      `[vitest] ${outside.length} test(s) excluded: they use kons that are not installed ` +
        `(${[...absent].sort().join(", ")}). Install them with "kitsuden kon add" to run them.`
    );
  }
  return outside;
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/apps/**/node_modules/**",
      "**/packages/**/node_modules/**",
      ...testsWithMissingKons(),
    ],
    coverage: {
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "tests/"],
    },
    setupFiles: ["./tests/unit/setup.ts"],

    /**
     * Starting PGlite (PostgreSQL embedded in WASM) and creating the schema takes
     * seconds, and more when several files compete for CPU.
     *
     * Without raising this ceiling, the `beforeAll` times out and **vitest marks the
     * tests as SKIPPED, not as failed** — which is the worst possible
     * combination: the suite comes out green while 32 membership and
     * Broadcast tests have not run. Exactly that happened as the suite grew.
     */
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@core": path.resolve(__dirname, "../../packages/core"),
      "@api": path.resolve(__dirname, "../../apps/api/src"),

      // `@/` is apps/api's internal alias. The tsconfig resolves it, so
      // the code compiles; without this line vitest cannot find it and any
      // test that imports an API service fails with "Cannot find package
      // '@/db'" — an error that says nothing about the test or the service.
      "@/": path.resolve(__dirname, "../../apps/api/src") + "/",

      // `@kitsuden/shared` points to `dist/` via package.json, so as soon as
      // `src/` is touched without rebuilding, tests fail with "X is not a
      // function" — an error that says nothing about the real change and that has already
      // cost time three times.
      //
      // Here it resolves to SOURCE: the tests exercise what you have just
      // written, not an old artifact. Vitest transpiles the TS the same.
      // Careful: only `shared`, which is pure. Aliasing `@kitsuden/engine` would drag
      // the database startup into the unit suite.
      "@kitsuden/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
});
