/**
 * Build of the Kitsuden Core modules as publishable npm packages
 * ============================================================================
 *
 * `datasets`, `media` and `blocks` are the framework's BATTERIES: every app
 * wants them. They are published as their own packages (`@kitsuden/datasets`, …) and are not
 * bundled inside `kitsuden`, to preserve the plugin model — they can be
 * enabled/disabled like any other kon.
 *
 * They are compiled to `dist/index.js` because the module-loader imports them
 * DYNAMICALLY at runtime: if they were published as `.ts` they would only load under
 * Bun, and `kitsuden` must also run under Node. The loader's resolver
 * prioritizes `dist/index.js` over `index.ts`, so in the monorepo the source
 * is still used and in the installation the compiled output.
 *
 * Usage:  bun run packages/core/scripts/build-core.ts
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CORE_DIR = join(import.meta.dir, "..");
const MODULES = ["datasets", "media", "blocks"];

/** Everything that must not be bundled: peer deps + host runtime. */
const EXTERNAL = [
  "@kitsuden/shared",
  "@kitsuden/engine",
  "kitsuden",
  "kitsuden/framework",
  "kitsuden/shared",
  "hono",
  "hono/*",
  "drizzle-orm",
  "drizzle-orm/*",
  "zod",
  "@aws-sdk/*",
  "sharp",
  "node:*",
  "bun:*",
];

/**
 * Fields the tarball needs that live in the source package.json.
 *
 * Before, this script wrote them itself, along with a translation of
 * `workspace:*` to semver — but it wrote over the SOURCE package.json, so
 * building left the tree in a state that `pnpm install` could no longer
 * resolve (`@kitsuden/shared` is not published, and the semver range sent it to the
 * registry). Now the manifest is static and the `workspace:` protocol is
 * translated by `pnpm publish` when packing, which is its job.
 */
const REQUIRED_MANIFEST_FIELDS = ["files", "main", "types", "exports"] as const;

let failed = false;

for (const name of MODULES) {
  const dir = join(CORE_DIR, name);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(`  ✗ ${name}: no package.json`);
    failed = true;
    continue;
  }

  const entry = existsSync(join(dir, "index.ts"))
    ? join(dir, "index.ts")
    : join(dir, `${name}.routes.ts`);

  rmSync(join(dir, "dist"), { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(dir, "dist"),
    target: "node",
    format: "esm",
    external: EXTERNAL,
    naming: "index.[ext]",
  });

  if (!result.success) {
    console.error(`  ✗ @kitsuden/${name}:`);
    for (const log of result.logs) console.error("     ", log.message);
    failed = true;
    continue;
  }

  // Types: re-export from the source (enough in the monorepo). For the published
  // tarball they are generated with `tsc --emitDeclarationOnly` from CI.
  writeFileSync(join(dir, "dist", "index.d.ts"), `export * from "../index";\n`);

  // The manifest must travel in the tarball: the module-loader reads kon.json
  // to know the id, the mountPath and the admin views. It is declared in the
  // source; here we only check that nothing is missing.
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const missing = REQUIRED_MANIFEST_FIELDS.filter((field) => pkg[field] === undefined);
  if (missing.length > 0) {
    console.error(`  ✗ @kitsuden/${name}: missing ${missing.join(", ")} in its package.json`);
    failed = true;
    continue;
  }
  if (!(pkg.files ?? []).includes("kon.json")) {
    console.error(`  ✗ @kitsuden/${name}: "kon.json" must be in "files"`);
    failed = true;
    continue;
  }

  const kb = (result.outputs.reduce((n, o) => n + o.size, 0) / 1024).toFixed(0);
  console.log(`  ✓ @kitsuden/${name} — ${kb} KB`);
}

if (failed) process.exit(1);
console.log("\n✅ Core modules ready to publish.\n");
