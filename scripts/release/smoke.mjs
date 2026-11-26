#!/usr/bin/env node
/**
 * Release step 1b: install the tarballs of `release/` into an EMPTY project and use them.
 *
 *   node scripts/release/smoke.mjs            (after node scripts/release/pack.mjs)
 *   node scripts/release/smoke.mjs --keep     leave the project folder to look at
 *
 * Outside the workspace nothing resolves to the sources: this is what a user gets
 * from `npm install`. The tarballs depend on each other at their real versions
 * (`@kitsuden/cli` → `@kitsuden/codegen@0.9.0-beta`), which are not on the registry
 * yet, so `overrides` points each one at its tarball. Everything else comes from
 * the registry, as for a user.
 *
 * Checks: every entry point imports (ESM) and requires (CJS); the types resolve
 * under `moduleResolution: nodenext`; `kitsuden --version` and `create-kitsuden
 * --help` run; `create-kitsuden` scaffolds a docker project that points at the
 * images of this version; the MCP server loads under Bun.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keep = process.argv.includes("--keep");
const manifest = JSON.parse(readFileSync(join(ROOT, "release", "manifest.json"), "utf8"));
const shell = process.platform === "win32";

const failures = [];
function check(name, ok, detail = "") {
  console.log(
    `${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${detail.trim().split("\n").slice(-15).join("\n    ")}` : ""}`
  );
  if (!ok) failures.push(name);
}
function run(cmd, args, cwd, opts = {}) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", shell, timeout: 300_000, ...opts });
}

const dir = mkdtempSync(join(tmpdir(), "kitsuden-smoke-"));
console.log(`project: ${dir}`);

const deps = {};
for (const p of manifest) deps[p.name] = `file:${join(ROOT, p.file).replace(/\\/g, "/")}`;
writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    { name: "smoke", private: true, type: "module", dependencies: deps, overrides: deps },
    null,
    2
  )
);

const install = run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], dir);
check("npm install of the tarballs into an empty project", install.status === 0, install.stderr);
if (install.status !== 0) process.exit(1);

const version = (name) => manifest.find((p) => p.name === name)?.version;

// ── ESM and CJS entry points ────────────────────────────────────────────────
const esm = `
const out = {};
const shared = await import("@kitsuden/shared"); out.shared = Object.keys(shared).length;
const codegen = await import("@kitsuden/codegen"); out.codegen = typeof codegen.generateReact;
for (const s of ["react", "vue", "svelte", "generators/types"]) await import("@kitsuden/codegen/" + s);
const sdk = await import("@kitsuden/sdk"); out.sdk = typeof sdk.createKitsuden;
for (const s of ["realtime", "rpc", "toon-protocol"]) await import("@kitsuden/sdk/" + s);
const kitsuden = await import("kitsuden");
out.same = Object.keys(sdk).every((k) => kitsuden[k] === sdk[k]);
const cf = await import("create-kitsuden"); out.create = typeof cf.scaffold;
console.log(JSON.stringify(out));
`;
const e = run("node", ["--input-type=module", "-e", esm], dir, { shell: false });
let out = {};
try {
  out = JSON.parse(e.stdout.trim().split("\n").at(-1));
} catch {}
check("ESM: @kitsuden/shared exports", out.shared > 0, e.stderr);
check("ESM: @kitsuden/codegen and its subpaths", out.codegen === "function", e.stderr);
check("ESM: @kitsuden/sdk and its subpaths", out.sdk === "function", e.stderr);
check("ESM: kitsuden is the SDK module itself", out.same === true, e.stderr);
check("ESM: create-kitsuden exports scaffold", out.create === "function", e.stderr);

const cjs = `
const sdk = require("@kitsuden/sdk");
const k = require("kitsuden");
const cg = require("@kitsuden/codegen");
require.resolve("@kitsuden/sdk/openapi.json");
if (k !== sdk || typeof sdk.createKitsuden !== "function" || typeof cg.generateReact !== "function") process.exit(1);
console.log("ok");
`;
const c = run("node", ["-e", cjs], dir, { shell: false });
check(
  "CJS: @kitsuden/sdk, kitsuden, @kitsuden/codegen",
  c.status === 0 && c.stdout.includes("ok"),
  c.stderr
);

// ── Types, as a user's tsconfig sees them ───────────────────────────────────
writeFileSync(
  join(dir, "types.ts"),
  `import { createKitsuden } from "kitsuden";
import * as sdk from "@kitsuden/sdk";
import { generateReact, type CollectionInfo } from "@kitsuden/codegen";
import * as shared from "@kitsuden/shared";
const a: typeof sdk.createKitsuden = createKitsuden;
const col: CollectionInfo = { slug: "p", name: "P", kind: "dataset", primaryKey: "id", columns: [] };
const files: { filename: string }[] = generateReact({ collection: col, framework: "react", type: "types" });
export { a, files, shared };
`
);
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["es2022", "dom"],
      types: [],
    },
    files: ["types.ts"],
  })
);
const tsc = run("node", [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "."], dir, {
  shell: false,
});
check(
  "types resolve (nodenext): kitsuden, @kitsuden/sdk, codegen, shared",
  tsc.status === 0,
  tsc.stdout + tsc.stderr
);

// ── Commands ────────────────────────────────────────────────────────────────
const v = run("npx", ["--no-install", "kitsuden", "--version"], dir);
check(
  `npx kitsuden --version prints ${version("@kitsuden/cli")}`,
  v.status === 0 && v.stdout.trim() === version("@kitsuden/cli"),
  v.stderr + v.stdout
);
const h = run("npx", ["--no-install", "kitsuden", "--help"], dir);
check("npx kitsuden --help", h.status === 0 && /Usage: kitsuden/.test(h.stdout), h.stderr);
const ch = run("npx", ["--no-install", "create-kitsuden", "--help"], dir);
check(
  "npx create-kitsuden --help",
  ch.status === 0 && ch.stdout.includes(version("create-kitsuden")),
  ch.stderr
);

const scaffold = run(
  "npx",
  ["--no-install", "create-kitsuden", "app", "--yes", "--mode", "docker", "--skip-checks"],
  dir
);
const compose = join(dir, "app", "docker-compose.yml");
const env = join(dir, "app", ".env");
check(
  "create-kitsuden scaffolds a docker project",
  scaffold.status === 0 && existsSync(compose) && existsSync(env),
  scaffold.stderr + scaffold.stdout
);
if (existsSync(env)) {
  const text =
    readFileSync(env, "utf8") + (existsSync(compose) ? readFileSync(compose, "utf8") : "");
  const tag = version("create-kitsuden");
  check(
    `the scaffold uses ghcr.io/kitsuden/kitsuden/{api,admin}:${tag}`,
    text.includes(`ghcr.io/kitsuden/kitsuden/api:${tag}`) &&
      text.includes(`ghcr.io/kitsuden/kitsuden/admin:${tag}`)
  );
  // The repository's compose never pulls (it builds); a scaffold has nothing to build.
  check(
    "the scaffold pulls its images (no pull_policy: never)",
    !/pull_policy:\s*never/.test(text)
  );
}

const mcp = run(
  "bun",
  [
    "-e",
    'const m = await import("@kitsuden/mcp-server"); if (typeof m.createKitsudenMcpServer !== "function") process.exit(1); console.log("ok")',
  ],
  dir,
  { shell: false }
);
check(
  "@kitsuden/mcp-server loads under Bun",
  mcp.status === 0 && mcp.stdout.includes("ok"),
  mcp.stderr
);
check(
  "kitsuden-mcp bin is installed",
  existsSync(join(dir, "node_modules", "@kitsuden", "mcp-server", "dist", "standalone.js"))
);

if (!keep) rmSync(dir, { recursive: true, force: true });
console.log(
  failures.length ? `\n✗ ${failures.length} check(s) failed` : "\n✓ All smoke checks passed"
);
process.exit(failures.length ? 1 : 0);
