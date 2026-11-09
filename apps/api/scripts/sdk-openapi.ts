#!/usr/bin/env bun
/**
 * The OpenAPI 3.1 document of the kon SDK operations, offline and deterministic
 * ============================================================================
 *
 * Input of the client generator (`scripts/sdk/generate.mjs`): every operation
 * declared with `defineOperation` by
 *
 *   - the INSTALLED kons (`packages/core/*`, `kitsuden.kons.json`, `KITSUDEN_KONS`),
 *   - the operations the core mounts itself (`registerCoreOperations`:
 *     agent permissions, approvals, proposals, brain memory, promotion),
 *
 * turned into OpenAPI with the SAME function the API uses for
 * `GET /api/docs/openapi.json` (`openApiOperation`). No database, no app, no
 * network: it imports the definitions, never mounts them.
 *
 * Output is sorted (paths, methods, keys of `x-kitsuden-*` objects are kept
 * as generated; tags sorted) so two runs give the same bytes.
 *
 *   bun --no-env-file scripts/sdk-openapi.ts                 # writes the snapshot
 *   bun --no-env-file scripts/sdk-openapi.ts --check         # fails if the snapshot is stale
 *   bun --no-env-file scripts/sdk-openapi.ts --out=<file>    # another destination
 *   bun --no-env-file scripts/sdk-openapi.ts --prune         # also drops kons not installed here
 *   bun --no-env-file scripts/sdk-openapi.ts --kon=<dir>     # ONLY the kon in that folder (repeatable)
 *
 * `--kon=<dir>` is the typed client of a kon that is not installed and without a
 * running API: it reads `<dir>/kon.json` and `<dir>/index.ts` (or `dist/index.js`),
 * builds the OpenAPI of its `defineOperation` declarations, and merges it into the
 * target like any other kon (the rest of the snapshot is kept; the operations that
 * kon had before are replaced). Neither the installed kons nor the core are read.
 * `scripts/sdk/generate.mjs --from-kon=<dir>` calls this and then generates. The
 * kon must be able to import `@kitsuden/engine` from its folder (a workspace
 * member, or a dependency of its own package.json).
 *
 * Writing MERGES: the operations of kons not installed here stay as they are in
 * the snapshot. In a clean clone the kons from kitsuden-kons are absent, and a plain
 * rewrite would delete their operations and clients. `--prune` is the explicit way
 * to do that, for example when a kon was really removed.
 *
 * `--check` compares only the kons that are installed HERE: in a clean clone
 * (CI) the kons from kitsuden-kons are absent, so their part of the snapshot
 * is kept and reported as "not installed, not checked".
 *
 * `--no-env-file` is not optional: in the primary checkout `apps/api/.env`
 * holds production credentials, and Bun would load them. This script also
 * forces the in-memory test database before importing anything.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── 0. Nothing here may reach a real database ────────────────────────────────
for (const k of ["DATABASE_URL", "DATABASE_ADMIN_URL", "REDIS_URL", "VALKEY_URL"])
  delete process.env[k];
process.env.NODE_ENV = "test";
process.env.KITSUDEN_TEST_DB = "memory";
// src/db refuses to load without a URL; port 1 on loopback never answers, and
// with KITSUDEN_TEST_DB=memory nothing tries it (pg-mem).
process.env.DATABASE_URL = "postgres://offline:offline@127.0.0.1:1/kitsuden_sdk_offline_test";
process.env.LOG_LEVEL = "silent";

const API_ROOT = resolve(import.meta.dir, "..");
const ROOT = resolve(API_ROOT, "../..");
const DEFAULT_TARGET = join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json");

const args = process.argv.slice(2);
const check = args.includes("--check");
const prune = args.includes("--prune");
const target = resolve(args.find((a) => a.startsWith("--out="))?.slice(6) ?? DEFAULT_TARGET);
/** `--kon=<dir>`: only these kon folders (relative to the current directory). */
const konDirs = args.filter((a) => a.startsWith("--kon=")).map((a) => resolve(a.slice(6)));
if (konDirs.length && prune) {
  process.stderr.write("[sdk-openapi] --kon and --prune do not go together\n");
  process.exit(2);
}

// Quiet: the route modules log while importing.
const log = (s: string) => process.stderr.write(`${s}\n`);
console.log = () => undefined;
console.info = () => undefined;
console.warn = () => undefined;
console.debug = () => undefined;

const { KITSUDEN_VERSION: KITSUDEN_VERSION } = await import("@kitsuden/shared");
const { commonComponents, openApiOperation } = await import("../src/lib/operations-openapi");
const { coreOperations } = await import("../src/lib/core-operations");
const { listInstalledKons, readManifestSync } = await import("../src/lib/installed-kons");
const { operationsOf } = await import("../../../packages/engine/src/operations");

type Op = ReturnType<typeof operationsOf>[number];
interface Source {
  konId: string;
  mountPath: string;
  description: string;
  operations: Op[];
}

// ── 1. Kons: the installed ones, or only those named with --kon ─────────────
const sources = new Map<string, Source>();

type Manifest = NonNullable<ReturnType<typeof readManifestSync>>;

/** The SDK operations of the kon in `dir`, or `null` if it declares none. */
async function konSource(dir: string, manifest: Manifest): Promise<Source | null> {
  const input = ["index.ts", join("dist", "index.js"), "index.js"]
    .map((f) => join(dir, f))
    .find((f) => existsSync(f));
  if (!input) return null;
  const mod = (await import(pathToFileURL(input).href)) as Record<string, unknown>;
  const def = (mod.kon ?? mod.default) as
    | { id?: string; mountPath?: string; description?: string; name?: string; operations?: unknown }
    | undefined;
  if (!def?.operations) return null;
  const operations = operationsOf(def as never);
  if (operations.length === 0) return null;
  const id = manifest.id;
  // Same order as the kon loader (module-loader.ts): the definition, then kon.json,
  // then the default. The loader's default for a kon outside the default grimoire is
  // `/api/custom/<id>`; a kon meant for a client declares its mount, so this keeps
  // `/api/<name>` and warns.
  if (!def.mountPath && !manifest.mount?.path)
    log(`[sdk-openapi] ${id} declares no mount path: assuming /api/${id.replace(/^kon-/, "")}`);
  const mountPath = (
    def.mountPath ||
    manifest.mount?.path ||
    `/api/${id.replace(/^kon-/, "")}`
  ).replace(/\/+$/, "");
  return {
    konId: id,
    mountPath,
    description: String(def.description ?? manifest.description ?? def.name ?? id),
    operations,
  };
}

if (konDirs.length) {
  for (const dir of konDirs) {
    const manifest = existsSync(dir) ? readManifestSync(dir) : null;
    if (!manifest) {
      log(`[sdk-openapi] ${dir}: no kon.json (or package.json "kitsuden" field) with an id`);
      process.exit(2);
    }
    const source = await konSource(dir, manifest);
    if (!source) {
      log(`[sdk-openapi] ${manifest.id}: no operations declared with defineOperation in ${dir}`);
      process.exit(2);
    }
    sources.set(source.konId, source);
  }
} else {
  for (const k of listInstalledKons()) {
    if (!k.path || !k.manifest) continue;
    const source = await konSource(k.path, k.manifest);
    if (source) sources.set(source.konId, source);
  }

  // ── 2. Core operations (route modules that register themselves) ───────────
  const dirRoutes = join(API_ROOT, "src/routes");
  for (const f of readdirSync(dirRoutes).sort()) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(dirRoutes, f), "utf8");
    if (!text.includes("registerCoreOperations(")) continue;
    await import(pathToFileURL(join(dirRoutes, f)).href);
  }
  for (const n of coreOperations()) {
    if (sources.has(n.konId)) continue;
    sources.set(n.konId, {
      konId: n.konId,
      mountPath: n.mountPath.replace(/\/+$/, ""),
      description: n.description,
      operations: n.operations as Op[],
    });
  }
}

// ── 3. The document ─────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
const paths: Record<string, Record<string, Json>> = {};
const tags: { name: string; description: string }[] = [];
const METHOD_ORDER = ["get", "put", "post", "delete", "patch"];

for (const f of [...sources.values()].sort((a, b) => a.konId.localeCompare(b.konId))) {
  tags.push({ name: f.konId, description: f.description });
  for (const op of f.operations) {
    const g = openApiOperation(f.konId, f.mountPath, op as never);
    const item = (paths[g.path] ??= {});
    if (!item[g.method]) item[g.method] = g.operation;
  }
}

const sortedPaths: typeof paths = {};
for (const path of Object.keys(paths).sort()) {
  const item = paths[path]!;
  sortedPaths[path] = {};
  for (const m of METHOD_ORDER) if (item[m]) sortedPaths[path]![m] = item[m]!;
}

const doc = {
  openapi: "3.1.0",
  info: {
    title: "Kitsuden API — kon SDK operations",
    version: KITSUDEN_VERSION,
    description:
      "Every operation declared with defineOperation by the installed kons and the core. " +
      "Generated by apps/api/scripts/sdk-openapi.ts; input of the typed clients (pnpm sdk:generate).",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{ url: "http://localhost:3000/api", description: "Local development" }],
  tags,
  paths: sortedPaths,
  components: commonComponents(),
};

const konOf = (o: unknown) =>
  (o as { "x-kitsuden-operation"?: { kon?: string } })["x-kitsuden-operation"]?.kon ?? "";

/**
 * Keeps what the snapshot already has for kons that are not installed here: their
 * operations and tags. Everything of an installed kon comes from its declaration.
 */
function mergeUninstalled(next: typeof doc, prior: typeof doc): { kept: number; kons: string[] } {
  const merged: typeof paths = {};
  const present = new Set(sources.keys());
  const kons = new Set<string>();
  let kept = 0;
  for (const [path, item] of Object.entries(prior.paths)) {
    for (const [method, o] of Object.entries(item)) {
      const kon = konOf(o);
      if (!kon || present.has(kon)) continue;
      (merged[path] ??= {})[method] = o as Json;
      kons.add(kon);
      kept++;
    }
  }
  for (const [path, item] of Object.entries(next.paths))
    merged[path] = { ...merged[path], ...item };
  const out: typeof paths = {};
  for (const path of Object.keys(merged).sort()) {
    out[path] = {};
    for (const m of METHOD_ORDER) if (merged[path]![m]) out[path]![m] = merged[path]![m]!;
  }
  next.paths = out;
  const ownTags = new Set(next.tags.map((t) => t.name));
  next.tags = [
    ...next.tags,
    ...prior.tags.filter((t) => kons.has(t.name) && !ownTags.has(t.name)),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { kept, kons: [...kons].sort() };
}

const declaredOperations = Object.values(sortedPaths).reduce(
  (n, p) => n + Object.keys(p).length,
  0
);

// ── 4. Write or check ───────────────────────────────────────────────────────
if (check) {
  if (!existsSync(target)) {
    log(`[sdk-openapi] ${target} does not exist: run pnpm sdk:openapi`);
    process.exit(1);
  }
  const prior = JSON.parse(readFileSync(target, "utf8")) as typeof doc;
  const konOf = (o: Json) => (o["x-kitsuden-operation"] as { kon?: string } | undefined)?.kon ?? "";
  const presentItems = new Set(sources.keys());
  const byKey = (d: typeof doc, onlyPresent: boolean) => {
    const m = new Map<string, string>();
    for (const [path, item] of Object.entries(d.paths))
      for (const [method, o] of Object.entries(item)) {
        if (onlyPresent && !presentItems.has(konOf(o as Json))) continue;
        m.set(`${method.toUpperCase()} ${path}`, JSON.stringify(o));
      }
    return m;
  };
  const now = byKey(doc, false);
  const before = byKey(prior, true);
  const changes: string[] = [];
  for (const [k, v] of now)
    if (before.get(k) !== v) changes.push(before.has(k) ? `changed ${k}` : `new ${k}`);
  for (const k of before.keys()) if (!now.has(k)) changes.push(`removed ${k}`);
  const absent = [
    ...new Set(
      Object.values(prior.paths)
        .flatMap((i) => Object.values(i))
        .map((o) => konOf(o as Json))
        .filter((k) => !presentItems.has(k))
    ),
  ].sort();
  if (absent.length) log(`[sdk-openapi] not installed here, not checked: ${absent.join(", ")}`);
  if (JSON.stringify(prior.components) !== JSON.stringify(doc.components))
    changes.push("changed components");
  if (changes.length) {
    log(
      `[sdk-openapi] the snapshot is STALE (${changes.length}):\n  ${changes.slice(0, 40).join("\n  ")}`
    );
    log("Run `pnpm sdk:openapi && pnpm sdk:generate` and commit the result.");
    process.exit(1);
  }
  log(
    `[sdk-openapi] snapshot up to date (${now.size} operations checked from ${presentItems.size} kons)`
  );
  process.exit(0);
}

if (!prune && existsSync(target)) {
  const { kept, kons } = mergeUninstalled(
    doc,
    JSON.parse(readFileSync(target, "utf8")) as typeof doc
  );
  if (kept)
    log(
      `[sdk-openapi] kept ${kept} operations of kons not installed here (${kons.join(", ")}); --prune drops them`
    );
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
log(`[sdk-openapi] ${declaredOperations} operations from ${sources.size} kons → ${target}`);
process.exit(0);
