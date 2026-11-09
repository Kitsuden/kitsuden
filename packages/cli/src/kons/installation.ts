/**
 * Installing kons in a Kitsuden project — the logic of `kitsuden kon add|remove|list`
 * ============================================================================
 *
 * The kons do not live in the core repo: they are in
 * `kitsuden-kons` (or in any repo/package that follows the same format) and are
 * INSTALLED. Installing a kon is:
 *
 *   1. finding it at the origin (local path or git URL);
 *   2. checking that its SDK is compatible with this core
 *      (`GET /api/version` → `sdk.kons`, or the code constant if the API is
 *      not running);
 *   3. also bringing in the kons it depends on;
 *   4. copying it to `packages/kons/<id>/` (`copy` mode, the normal one) or leaving it where
 *      it is and pointing to it (`link` mode, for developing the kon);
 *   5. declaring it in `kitsuden.kons.json`, which is what the API reads
 *      (`apps/api/src/lib/installed-kons.ts`);
 *   6. `pnpm install` and the normal migration runner with `--kon <id>`.
 *
 * This module does 1–5 and launches no processes: that way it is tested without a network, without pnpm and
 * without a database. The command (`commands/kon.ts`) adds step 6.
 *
 * ── WHY COPY AND NOT LINK BY DEFAULT ──────────────────────────────────────
 *
 * A copy inside `packages/kons/` is one more workspace package: pnpm
 * resolves its `peerDependencies` (`@kitsuden/shared`, `@kitsuden/engine`,
 * hono, drizzle-orm, zod) against the core's own, so there is ONE single
 * instance of each. With two copies of the engine, a kon's `AppError` is not
 * `instanceof AppError` for the API and a 404 comes out as a 500. The copy keeps a
 * fingerprint (`hash`) so as not to overwrite hand-made changes on reinstall.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { KON_ID, FORBIDDEN_SCRIPTS } from "../registry/manifest.js";

export const KONS_FILE = "kitsuden.kons.json";

/** Modules that ship with the core (`packages/core`): never installed. */
export const CORE_KONS = new Set(["kon-datasets", "kon-media", "kon-blocks"]);

/** Default origin if there is no `--from` or `KITSUDEN_KONS_SOURCE`. */
export const DEFAULT_ORIGIN = "https://github.com/Kitsuden/kitsuden-kons.git";

export interface KonInput {
  source?: string;
  version?: string;
  sdk?: number;
  mode?: "copy" | "link";
  path?: string;
  package?: string;
  hash?: string;
  /** Git commit a source install came from. Reinstalls stay on it unless --latest. */
  commit?: string;
  enabled?: boolean;
  installedAt?: string;
}

export interface KonsFile {
  $comment?: string;
  kons: Record<string, KonInput>;
}

export interface KonManifestFile {
  id: string;
  name?: string;
  version?: string;
  sdk?: unknown;
  maturity?: string;
  description?: string;
  dependencies?: unknown;
  [k: string]: unknown;
}

/**
 * `blog`, `kon-blog`, `@kitsuden/kon-blog` → `kon-blog`.
 *
 * An id ends up in file paths and in the arguments of child processes, and it
 * can come from a repository the user does not control. So anything that does
 * not match KON_ID is refused here, at the one place every id passes through.
 */
export function konIdOf(name: string): string {
  const clean = name.trim().replace(/^@kitsuden\//, "");
  const id = clean.startsWith("kon-") ? clean : `kon-${clean}`;
  if (!KON_ID.test(id)) {
    throw new KonError(`Invalid kon id ${JSON.stringify(name)}: an id must match ${KON_ID}.`);
  }
  return id;
}

/** Short name to display and for commands: `kon-blog` → `blog`. */
export function shortName(id: string): string {
  return id.replace(/^kon-/, "");
}

/** Project root: `pnpm-workspace.yaml` + `packages/kons` (the install folder). */
export function findRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages", "kons"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── kitsuden.kons.json ──────────────────────────────────────────────────────

const COMMENT =
  "Kons installed in this Kitsuden project. Written by `kitsuden kon add|remove`; " +
  "read by the API (apps/api/src/lib/installed-kons.ts). KITSUDEN_KONS in the " +
  "environment adds more. Which installed kons are ACTIVE is decided in the admin panel.";

export function readKonsFile(root: string): KonsFile {
  const route = join(root, KONS_FILE);
  if (!existsSync(route)) return { kons: {} };
  const json = JSON.parse(readFileSync(route, "utf8")) as Partial<KonsFile>;
  const kons: Record<string, KonInput> = {};
  for (const [id, e] of Object.entries(json.kons ?? {})) kons[konIdOf(id)] = e ?? {};
  return { kons };
}

export function writeKonsFile(root: string, file: KonsFile): void {
  const sorted: Record<string, KonInput> = {};
  for (const id of Object.keys(file.kons).sort()) sorted[id] = file.kons[id]!;
  writeFileSync(
    join(root, KONS_FILE),
    JSON.stringify({ $comment: COMMENT, kons: sorted }, null, 2) + "\n"
  );
}

// ── Manifests ───────────────────────────────────────────────────────────────

export function readManifest(dir: string): KonManifestFile | null {
  const konJson = join(dir, "kon.json");
  if (existsSync(konJson)) {
    const m = JSON.parse(readFileSync(konJson, "utf8")) as KonManifestFile;
    return typeof m?.id === "string" ? m : null;
  }
  const pkgJson = join(dir, "package.json");
  if (existsSync(pkgJson)) {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    const k = pkg?.kitsuden;
    if (k && (k.type === "kon" || typeof k.id === "string")) {
      return { ...k, id: k.id || pkg.name, name: k.name || pkg.name, version: pkg.version };
    }
  }
  return null;
}

function packageVersion(dir: string): string | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

/**
 * Kons that one depends on: `dependencies.kons` / `dependencies.required` of the
 * manifest and the `@kitsuden/kon-*` of its package.json. Excluding the core ones.
 */
export function dependenciesOf(dir: string, manifest: KonManifestFile): string[] {
  const deps = new Set<string>();
  const d = manifest.dependencies as { kons?: unknown; required?: unknown } | unknown[] | undefined;
  const lists: unknown[] = Array.isArray(d) ? [d] : [d?.kons, d?.required];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    // konIdOf refuses a malformed id instead of dropping it: a kon that declares
    // one is broken or hostile, and installing the rest of it would hide that.
    for (const x of list) if (typeof x === "string" && x.startsWith("kon-")) deps.add(konIdOf(x));
  }
  const packagePath = join(dir, "package.json");
  if (existsSync(packagePath)) {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (name.startsWith("@kitsuden/kon-")) deps.add(konIdOf(name));
      }
    }
  }
  return [...deps].filter((id) => !CORE_KONS.has(id) && id !== konIdOf(manifest.id));
}

// ── SDK ─────────────────────────────────────────────────────────────────────

/** The kon SDK version given by this core's code. */
export function codeSdk(root: string): number | null {
  for (const route of [
    join(root, "packages", "shared", "src", "operations.ts"),
    join(root, "node_modules", "@kitsuden", "shared", "dist", "index.js"),
  ]) {
    if (!existsSync(route)) continue;
    const m = readFileSync(route, "utf8").match(/KONS_SDK_VERSION\s*=\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Reason NOT to install, or `null` (same criterion as the API's loader). */
export function incompatibleSdkReason(id: string, sdk: unknown, ofTheCore: number): string | null {
  if (sdk === undefined || sdk === null) return null;
  if (typeof sdk !== "number" || !Number.isInteger(sdk) || sdk < 1) {
    return `${id}: "sdk" in its manifest is not an integer >= 1 (${JSON.stringify(sdk)})`;
  }
  if (sdk > ofTheCore) {
    return (
      `${id} needs kon SDK v${sdk} and this Kitsuden provides v${ofTheCore} ` +
      `(GET /api/version → sdk.kons). Upgrade Kitsuden or install a version of the kon ` +
      `written for SDK v${ofTheCore}.`
    );
  }
  return null;
}

// ── Origin ──────────────────────────────────────────────────────────────────

/** Is it a git URL (and not a path)? */
export function isGitUrl(origin: string): boolean {
  return (
    /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|github:)/.test(origin) || /\.git(#.*)?$/.test(origin)
  );
}

/**
 * A kon's folder inside a local origin: the origin itself if it IS a kon,
 * or `<origin>/kons/<id>`, `<origin>/<id>`, `<origin>/packages/kons/<id>`.
 */
export function sourceKonDir(origin: string, id: string): string | null {
  const direct = readManifestSafe(origin);
  if (direct && validId(direct.id) === id) return origin;
  for (const candidate of [
    join(origin, "kons", id),
    join(origin, id),
    join(origin, "packages", "kons", id),
  ]) {
    if (existsSync(candidate) && readManifestSafe(candidate)) return candidate;
  }
  return null;
}

/** Like konIdOf, for a manifest that is only being looked at: null instead of an error. */
function validId(name: string): string | null {
  try {
    return konIdOf(name);
  } catch {
    return null;
  }
}

function readManifestSafe(dir: string): KonManifestFile | null {
  try {
    return statSync(dir).isDirectory() ? readManifest(dir) : null;
  } catch {
    return null;
  }
}

/** Kons offered by a local origin (for `kon list --available`). */
export function sourceKons(
  origin: string
): { id: string; dir: string; manifest: KonManifestFile }[] {
  const output: { id: string; dir: string; manifest: KonManifestFile }[] = [];
  for (const base of [join(origin, "kons"), origin]) {
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith("kon-")) continue;
      const dir = join(base, e.name);
      const manifest = readManifestSafe(dir);
      const id = manifest ? validId(manifest.id) : null;
      if (manifest && id) output.push({ id, dir, manifest });
    }
    if (output.length) break;
  }
  return output.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Copy and fingerprint ────────────────────────────────────────────────────

const NOT_COPIED = new Set(["node_modules", "dist", ".git", "coverage", ".turbo"]);

function filesOf(dir: string, base = dir, output: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_COPIED.has(e.name) || e.name.endsWith(".tsbuildinfo")) continue;
    const route = join(dir, e.name);
    if (e.isDirectory()) filesOf(route, base, output);
    else if (e.isFile()) output.push(relative(base, route).split("\\").join("/"));
  }
  return output;
}

/** Fingerprint of a kon's content (paths + bytes), without node_modules or dist. */
export function fingerprintOf(dir: string): string {
  const h = createHash("sha256");
  for (const rel of filesOf(dir).sort()) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** Symlinks in a kon: the copy keeps them, and the content hash does not cover them. */
function linksOf(dir: string, base = dir, output: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_COPIED.has(e.name)) continue;
    const route = join(dir, e.name);
    if (e.isSymbolicLink()) output.push(relative(base, route).split("\\").join("/"));
    else if (e.isDirectory()) linksOf(route, base, output);
  }
  return output;
}

/** Lifecycle scripts in a kon's package.json. pnpm runs them for workspace packages. */
export function forbiddenScriptsOf(dir: string): string[] {
  const route = join(dir, "package.json");
  if (!existsSync(route)) return [];
  const scripts = JSON.parse(readFileSync(route, "utf8"))?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  return Object.keys(scripts).filter((s) => FORBIDDEN_SCRIPTS.has(s));
}

function copyKon(origin: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  cpSync(origin, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      return !NOT_COPIED.has(name) && !name.endsWith(".tsbuildinfo");
    },
  });
}

// ── add / remove ────────────────────────────────────────────────────────────

export interface InstallOptions {
  root: string;
  /** Local folder with the kons (already cloned if it came from git). */
  source: string;
  /** What is recorded as `source` (the path or URL the user asked for). */
  declaredOrigin: string;
  link?: boolean;
  enable?: boolean;
  force?: boolean;
  /** SDK version of this core. */
  coreSdk: number;
  /** Git commit the source was checked out at (recorded in kitsuden.kons.json). */
  commit?: string;
  /**
   * Registry installs: the kons of the verified plan. Anything else a package
   * asks for was not signed and not shown to the user, so it is refused.
   */
  allowedPlan?: ReadonlySet<string>;
  now?: () => string;
}

export interface InstalledKonNow {
  id: string;
  dir: string;
  mode: "copy" | "link";
  version?: string;
  sdk?: number;
  /** true if it was installed as a dependency of another. */
  asDependency: boolean;
}

export class KonError extends Error {}

/**
 * Installs one or more kons and their dependencies. Writes the files and
 * `kitsuden.kons.json`; it does NOT run pnpm or migrations.
 */
export function installKons(names: string[], o: InstallOptions): InstalledKonNow[] {
  const file = readKonsFile(o.root);
  const plan: { id: string; dir: string; manifest: KonManifestFile; asDependency: boolean }[] = [];
  const seen = new Set<string>();

  // 1–3: find, check the SDK and add dependencies, without touching anything yet.
  const pendingItems = names.map((n) => ({ id: konIdOf(n), asDependency: false }));
  while (pendingItems.length) {
    const { id, asDependency } = pendingItems.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (CORE_KONS.has(id)) {
      if (!asDependency) {
        throw new KonError(
          `${id} is part of the Kitsuden core (packages/core): nothing to install.`
        );
      }
      continue;
    }
    const dir = sourceKonDir(o.source, id);
    if (!dir) {
      throw new KonError(
        `${id} not found in ${o.declaredOrigin}` +
          (asDependency ? " (needed as a dependency)" : "") +
          `. Expected kons/${id}/ with a kon.json.`
      );
    }
    const manifest = readManifest(dir)!;
    if (konIdOf(manifest.id) !== id) {
      throw new KonError(
        `${id}: its folder declares a different kon (${JSON.stringify(manifest.id)}) in its manifest.`
      );
    }
    const reason = incompatibleSdkReason(id, manifest.sdk, o.coreSdk);
    if (reason) throw new KonError(reason);
    if (!o.link) {
      // A copy becomes a workspace package, so any later `pnpm install` would run
      // these scripts. Same rule as a published kon (registry/manifest.ts).
      const forbiddenItems = forbiddenScriptsOf(dir);
      if (forbiddenItems.length) {
        throw new KonError(
          `${id}: lifecycle scripts are not allowed in an installed kon (${forbiddenItems.join(", ")}).`
        );
      }
      const links = linksOf(dir);
      if (links.length) {
        throw new KonError(
          `${id}: symbolic links are not allowed in an installed kon (${links.join(", ")}).`
        );
      }
    }
    plan.push({ id, dir, manifest, asDependency });
    for (const dep of dependenciesOf(dir, manifest)) {
      // An already-installed dependency is not reinstalled (unless requested).
      if (file.kons[dep] && !names.map(konIdOf).includes(dep)) continue;
      if (o.allowedPlan && !o.allowedPlan.has(dep)) {
        throw new KonError(
          `${id} asks for ${dep}, which is not in the signed plan for this install. ` +
            `A published kon must list its dependencies in dependencies.kons.`
        );
      }
      pendingItems.push({ id: dep, asDependency: true });
    }
  }

  // Check for local changes BEFORE writing anything: all or nothing.
  for (const k of plan) {
    if (o.link) continue;
    const target = join(o.root, "packages", "kons", k.id);
    if (!existsSync(target) || o.force) continue;
    const earlier = file.kons[k.id];
    if (!earlier?.hash) {
      throw new KonError(
        `packages/kons/${k.id} already exists and was not installed by \`kitsuden kon add\`. ` +
          `Move your changes to the kon's repository, or overwrite it with --force.`
      );
    }
    if (earlier.mode !== "link" && fingerprintOf(target) !== earlier.hash) {
      throw new KonError(
        `packages/kons/${k.id} has local changes since it was installed. ` +
          `Move them to the kon's repository (e.g. kitsuden-kons), or overwrite with --force.`
      );
    }
  }

  // 4–5: copy (or point) and declare.
  const now = o.now ?? (() => new Date().toISOString());
  const facts: InstalledKonNow[] = [];
  for (const k of plan) {
    const version = packageVersion(k.dir) ?? (k.manifest.version as string | undefined);
    const sdk = typeof k.manifest.sdk === "number" ? k.manifest.sdk : undefined;
    const earlier = file.kons[k.id] ?? {};
    const input: KonInput = {
      source: o.declaredOrigin,
      ...(version ? { version } : {}),
      ...(sdk !== undefined ? { sdk } : {}),
      mode: o.link ? "link" : "copy",
      ...(o.commit ? { commit: o.commit } : {}),
      installedAt: now(),
    };
    if (o.link) {
      const rel = relative(o.root, k.dir).split("\\").join("/");
      input.path = isAbsolute(rel) || rel.startsWith("..") ? rel : `./${rel}`;
    } else {
      const target = join(o.root, "packages", "kons", k.id);
      copyKon(k.dir, target);
      input.hash = fingerprintOf(target);
    }
    // The activation seed: --enable requests it for what was asked for; if there was
    // one already, it is kept.
    if (o.enable && !k.asDependency) input.enabled = true;
    else if (earlier.enabled !== undefined) input.enabled = earlier.enabled;
    file.kons[k.id] = input;
    facts.push({
      id: k.id,
      dir: k.dir,
      mode: o.link ? "link" : "copy",
      version,
      sdk,
      asDependency: k.asDependency,
    });
  }
  writeKonsFile(o.root, file);
  return facts;
}

export interface DeleteOptions {
  root: string;
  force?: boolean;
  /** Do not delete the copy in packages/kons (just stop declaring it). */
  keepFiles?: boolean;
}

/** Removes kons from the installation. It does not touch the database: their tables and data stay. */
export function removeKons(names: string[], o: DeleteOptions): string[] {
  const file = readKonsFile(o.root);
  const ids = names.map(konIdOf);

  for (const id of ids) {
    if (CORE_KONS.has(id))
      throw new KonError(`${id} is part of the Kitsuden core: it cannot be removed.`);
    if (!file.kons[id]) throw new KonError(`${id} is not installed (not in ${KONS_FILE}).`);
  }

  // Does another kon that stays need it?
  if (!o.force) {
    for (const [other, input] of Object.entries(file.kons)) {
      if (ids.includes(other)) continue;
      const dir = inputPath(o.root, other, input);
      const m = dir ? readManifestSafe(dir) : null;
      if (!dir || !m) continue;
      const uses = dependenciesOf(dir, m).filter((d) => ids.includes(d));
      if (uses.length) {
        throw new KonError(
          `${other} depends on ${uses.join(", ")}: remove it too, or use --force.`
        );
      }
    }
  }

  // Local changes in the copy: they are not deleted without --force.
  for (const id of ids) {
    const input = file.kons[id]!;
    if (input.mode === "link" || o.keepFiles || o.force) continue;
    const target = join(o.root, "packages", "kons", id);
    if (existsSync(target) && input.hash && fingerprintOf(target) !== input.hash) {
      throw new KonError(
        `packages/kons/${id} has local changes: move them to the kon's repository, ` +
          `or remove with --force (or --keep-files to keep the folder).`
      );
    }
  }

  for (const id of ids) {
    const input = file.kons[id]!;
    if (input.mode !== "link" && !o.keepFiles) {
      rmSync(join(o.root, "packages", "kons", id), { recursive: true, force: true });
    }
    delete file.kons[id];
  }
  writeKonsFile(o.root, file);
  return ids;
}

/** Where the folder of a declared entry is (same order as the API). */
export function inputPath(root: string, id: string, input: KonInput): string | null {
  if (input.path) {
    const route = isAbsolute(input.path) ? input.path : resolve(root, input.path);
    return existsSync(route) ? route : null;
  }
  const copy = join(root, "packages", "kons", id);
  if (existsSync(copy)) return copy;
  for (const name of [input.package, `@kitsuden/${id}`, id].filter(Boolean) as string[]) {
    const route = join(root, "node_modules", name);
    if (existsSync(route)) return route;
  }
  return null;
}

export interface KonStatus {
  id: string;
  source: "core" | "installed";
  mode?: "copy" | "link";
  version?: string;
  sdk?: number | null;
  maturity?: string;
  path: string | null;
  /** ok | missing | sdk-incompatible | modified */
  status: "ok" | "missing" | "sdk-incompatible" | "modified";
  detail?: string;
}

/** What is installed, with its status (for `kon list`). */
export function installationStatus(root: string, coreSdk: number | null): KonStatus[] {
  const output: KonStatus[] = [];
  const core = join(root, "packages", "core");
  if (existsSync(core)) {
    for (const e of readdirSync(core, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(core, e.name);
      if (!existsSync(join(dir, "kon.json"))) continue;
      const m = readManifestSafe(dir);
      if (!m) continue;
      output.push({
        id: konIdOf(m.id),
        source: "core",
        version: m.version as string | undefined,
        maturity: m.maturity,
        path: relative(root, dir).split("\\").join("/"),
        status: "ok",
      });
    }
  }
  for (const [id, input] of Object.entries(readKonsFile(root).kons)) {
    const dir = inputPath(root, id, input);
    const m = dir ? readManifestSafe(dir) : null;
    let status: KonStatus["status"] = "ok";
    let detail: string | undefined;
    if (!dir || !m) {
      status = "missing";
      detail = `run: kitsuden kon add ${shortName(id)}`;
    } else if (coreSdk !== null && incompatibleSdkReason(id, m.sdk, coreSdk)) {
      status = "sdk-incompatible";
      detail = incompatibleSdkReason(id, m.sdk, coreSdk) ?? undefined;
    } else if (input.mode !== "link" && input.hash && fingerprintOf(dir) !== input.hash) {
      status = "modified";
      detail = "local changes since install";
    }
    output.push({
      id,
      source: "installed",
      mode: input.mode ?? "copy",
      version: input.version ?? (m?.version as string | undefined),
      sdk: typeof m?.sdk === "number" ? m.sdk : null,
      maturity: m?.maturity,
      path: dir ? relative(root, dir).split("\\").join("/") : null,
      status,
      detail,
    });
  }
  return output;
}
