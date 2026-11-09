/**
 * Build of the distributable `kitsuden` package
 * ============================================================================
 *
 * The monorepo has `@kitsuden/engine` importing host modules by relative
 * path (`../../apps/api/src/...`). That works INSIDE the workspace, but
 * an npm package cannot carry paths that leave its folder.
 *
 * Solution: publish ONE package with several entry points — the Next.js
 * model (`next`, `next/server`, `next/link`). The bundler resolves the relative
 * paths at build time, so the tarball is self-contained:
 *
 *   kitsuden          → the complete runtime (the Hono app ready to serve)
 *   kitsuden/engine   → the framework layers (repo, policies, validation…)
 *   kitsuden/shared   → types and Zod schemas
 *
 * Native and third-party dependencies stay EXTERNAL (they go in
 * package.json), they are not bundled: sharp/argon2/pg have per-platform
 * binaries and bundling them would break the installation.
 */

import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PKG_DIR = join(import.meta.dir, "..");
const ROOT = join(PKG_DIR, "..", "..");
const OUT = join(PKG_DIR, "dist");

const pkg = await Bun.file(join(PKG_DIR, "package.json")).json();

/**
 * Drift guard.
 *
 * This package bundles the `apps/api` code but declares its dependencies
 * separately, so the two lists can diverge without anything warning:
 * the tarball would install a different version from the one the bundled code uses.
 * It already happened with `redis` (here ^4, the code calling the v5 API).
 *
 * Rule: if a dependency exists in both, the range must be identical.
 */
const apiPkg = await Bun.file(join(ROOT, "apps/api/package.json")).json();
const apiDeps: Record<string, string> = {
  ...(apiPkg.dependencies ?? {}),
  ...(apiPkg.optionalDependencies ?? {}),
};
const ourDeps: Record<string, string> = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.optionalDependencies ?? {}),
  ...(pkg.peerDependencies ?? {}),
};

const drift = Object.entries(ourDeps)
  .filter(([name, range]) => apiDeps[name] !== undefined && apiDeps[name] !== range)
  .map(
    ([name, range]) => `  ${name}: kitsuden declares "${range}", apps/api uses "${apiDeps[name]}"`
  );

if (drift.length > 0) {
  console.error("❌ The dependencies drifted from apps/api:\n");
  console.error(drift.join("\n"));
  console.error("\nMake the ranges match in packages/kitsuden/package.json and rebuild.\n");
  process.exit(1);
}

/**
 * Externals: everything declared as a dependency + drizzle's subpaths.
 *
 * What is NOT declared (in `devDependencies`) goes into the bundle: small
 * pure-JS utilities (croner, openapi3-ts, hono-rate-limiter,
 * graphql-type-json, @hono/swagger-ui, @hono/zod-validator, the TRON one). This way
 * whoever installs `kitsuden` downloads fewer packages, and only the heavy ones or those with their
 * own state stay out: postgres/pg, drizzle-orm,
 * hono, better-auth, sharp, argon2, the MCP SDK, aws, redis, pino, graphql.
 * If they were bundled, native binaries and the drivers' dynamic `require`s
 * would no longer resolve on the user's machine.
 */
const EXTERNAL = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  // The heavy ones imported only when used (LLM SDK, PGlite, mail,
  // PDF): OPTIONAL peerDependencies. External all the same: whoever
  // uses them installs them; whoever does not, does not pay their weight.
  ...Object.keys(pkg.peerDependencies ?? {}),
  "drizzle-orm/*",
  "better-auth/*",
  "@aws-sdk/*",
  "node:*",
  "bun:*",
];

const ENTRIES = [
  { name: "index", path: join(ROOT, "apps/api/src/index.ts") },
  { name: "engine", path: join(ROOT, "packages/engine/index.ts") },
  { name: "framework", path: join(ROOT, "packages/engine/framework.ts") },
  { name: "shared", path: join(ROOT, "packages/shared/src/index.ts") },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log("📦 Building package `kitsuden`…\n");

for (const entry of ENTRIES) {
  const result = await Bun.build({
    entrypoints: [entry.path],
    outdir: OUT,
    target: "bun",
    format: "esm",
    external: EXTERNAL,
    naming: `${entry.name}.[ext]`,
    // The module-loader imports kons dynamically at runtime from the
    // user's filesystem: they must not be resolved here.
    splitting: false,
  });

  if (!result.success) {
    console.error(`❌ Bundle failed for ${entry.name}:`);
    for (const log of result.logs) console.error("  ", log.message);
    process.exit(1);
  }

  const bytes = result.outputs.reduce((n, o) => n + o.size, 0);
  console.log(
    `  ✓ kitsuden/${entry.name === "index" ? "" : entry.name} — ${(bytes / 1024).toFixed(0)} KB`
  );

  // Type declaration: re-exports from the monorepo source. For the
  // published tarball they are generated with `tsc --emitDeclarationOnly` (see README).
  writeFileSync(
    join(OUT, `${entry.name}.d.ts`),
    `export * from "${entry.path.replace(/\\/g, "/")}";\n`
  );
}

console.log("\n✅ dist/ ready. Verify with: npm pack --dry-run\n");
