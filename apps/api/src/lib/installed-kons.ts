/**
 * Which kons are INSTALLED — by configuration, not by walking a folder
 * ============================================================================
 *
 * ── THE SPLIT ────────────────────────────────────────────────────
 *
 * Kitsuden is the core (API, engine, auth, agents, MCP, RLS, datasets, media,
 * blocks…). The kons —blog, wiki, CRM, games…— live in another repository
 * (`kitsuden-kons`) and are INSTALLED: `kitsuden kon add <name>`.
 *
 * Before, the loader walked `packages/kons/` and everything on disk
 * existed for the API: the core and the kons were the same tree. Now there are two
 * distinct questions, each with its own source:
 *
 *   · which kons are INSTALLED?  → the configuration (this module)
 *        - `kitsuden.kons.json` at the root (written by `kitsuden kon add`)
 *        - `KITSUDEN_KONS` in the environment (for Docker and for testing)
 *        - the core modules in `packages/core/*` (always)
 *   · which are ACTIVE?          → the `modules` table (the panel)
 *
 * A kon that is active in the database but not installed is not mounted: a warning is given with its name and
 * the command that fixes it. A kon that is installed but off is reserved so
 * it can be activated without restarting (`deferred-kons.ts`).
 *
 * ── WHERE A DECLARED KON IS LOOKED FOR ─────────────────────────────────────
 *
 *   1. `path` of its entry (local path, absolute or relative to the root)
 *   2. `packages/kons/<id>/` — the folder `kitsuden kon add` copies to
 *   3. `node_modules` — `@kitsuden/<id>`, `<id>` or the entry's `package`
 *
 * ── KITSUDEN_KONS ──────────────────────────────────────────────────────────
 *
 * Comma-separated list. Each element is an id (`blog` or `kon-blog`), or an
 * id with a source: `wiki=../kitsuden-kons/kons/kon-wiki` (path) or
 * `shop=@acme/kon-shop` (package). It is ADDED to what the file says; if the
 * same kon is in both, the environment wins.
 *
 * This module does not touch the database or the Bun runtime: it is used by the loader, the
 * panel registry, the migrations runner and `kitsuden.config.ts`, and it
 * must be readable at any point during startup.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KONS_SDK_VERSION } from "@kitsuden/shared";

/** Name of the kons configuration file, at the project root. */
export const KONS_FILE = "kitsuden.kons.json";

/** An entry of `kitsuden.kons.json` (all keys are optional). */
export interface KonInput {
  /** Where it was installed from: kons repo path or git URL. Informational. */
  source?: string;
  /** Version of the kon at install time (from its package.json). */
  version?: string;
  /** Version of the kons SDK it declared at install time. */
  sdk?: number;
  /** `copy` (copied to packages/kons) or `link` (used in place). */
  mode?: "copy" | "link";
  /** Folder of the kon: absolute or relative to the project root. */
  path?: string;
  /** Package name in node_modules, if it is not `@kitsuden/<id>`. */
  package?: string;
  /** Fingerprint of the copied content (so local changes are not overwritten on reinstall). */
  hash?: string;
  /**
   * Whether it is switched on when the `modules` table is first seeded. It is only the
   * SEED: as soon as the database has a row for the kon, the database rules.
   */
  enabled?: boolean;
  installedAt?: string;
}

export interface KonsFile {
  kons: Record<string, KonInput>;
}

/** The minimum of the manifest that consumers need. */
export interface KonManifestFile {
  id: string;
  name?: string;
  version?: string;
  sdk?: unknown;
  maturity?: string;
  tier?: string;
  core?: boolean;
  defaultEnabled?: boolean;
  mount?: { path?: string };
  tables?: unknown;
  dependencies?: unknown;
  [key: string]: unknown;
}

export interface InstalledKon {
  /** Canonical id, always prefixed: `kon-blog`. */
  id: string;
  /** Folder of the kon, or `null` if it is declared but not found. */
  path: string | null;
  /** `core` = packages/core; `config` = kitsuden.kons.json; `env` = KITSUDEN_KONS. */
  source: "core" | "config" | "env";
  /** The entry exactly as declared (empty for the core ones). */
  declaredOne: KonInput;
  /** Its manifest, if the folder exists and could be read. */
  manifest: KonManifestFile | null;
}

/** `blog`, `kon-blog` and `@kitsuden/kon-blog` are the same kon: `kon-blog`. */
export function konIdOf(name: string): string {
  const clean = name.trim().replace(/^@kitsuden\//, "");
  return clean.startsWith("kon-") ? clean : `kon-${clean}`;
}

/** Are they the same kon, with or without the prefix? */
export function sameKon(a: string, b: string): boolean {
  return konIdOf(a) === konIdOf(b);
}

let cacheRoot: string | null = null;

/**
 * The project root: the folder with `pnpm-workspace.yaml` and `packages/core`.
 *
 * It walks up from this module and from the working directory, like
 * `kon-migrations.ts`: it works from source, from the `dist/` bundle and
 * from a script launched in a subdirectory. `KITSUDEN_ROOT` sets it by hand.
 */
export function projectRoot(): string {
  if (process.env.KITSUDEN_ROOT) return resolve(process.env.KITSUDEN_ROOT);
  if (cacheRoot) return cacheRoot;

  const isRoot = (dir: string) =>
    existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages", "core"));

  const matches: string[] = [process.cwd()];
  try {
    matches.unshift(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // without import.meta.url (some bundling): the cwd is enough
  }

  for (const match of matches) {
    let dir = resolve(match);
    for (let i = 0; i < 30; i++) {
      if (isRoot(dir)) {
        cacheRoot = dir;
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cacheRoot = process.cwd();
  return cacheRoot;
}

/**
 * Reads `KITSUDEN_KONS`: `blog, wiki=../path, shop=@acme/kon-shop`.
 * An empty or absent value declares nothing.
 */
export function parseEnvKons(value: string | undefined): Map<string, KonInput> {
  const output = new Map<string, KonInput>();
  if (!value) return output;
  for (const chunk of value.split(/[,\s]+/)) {
    const element = chunk.trim();
    if (!element) continue;
    const equal = element.indexOf("=");
    const name = equal === -1 ? element : element.slice(0, equal);
    const origin = equal === -1 ? "" : element.slice(equal + 1).trim();
    if (!/^[@a-z0-9][a-z0-9._\/-]*$/i.test(name)) continue;
    const input: KonInput = {};
    if (origin) {
      // `@scope/pkg` or a name without slashes is a package; anything else, a path.
      if (origin.startsWith("@") || !/[\\/]/.test(origin)) input.package = origin;
      else input.path = origin;
    }
    output.set(konIdOf(name), input);
  }
  return output;
}

/**
 * Reads `kitsuden.kons.json`. A file that does not exist is an installation with no
 * kons; a broken one is reported loudly (and counts as empty), because staying silent
 * would make all kons disappear with no explanation.
 */
export function readKonsFile(root: string = projectRoot()): KonsFile {
  const route = join(root, KONS_FILE);
  if (!existsSync(route)) return { kons: {} };
  try {
    const json = JSON.parse(readFileSync(route, "utf8")) as Partial<KonsFile>;
    const kons: Record<string, KonInput> = {};
    for (const [id, input] of Object.entries(json.kons ?? {})) {
      kons[konIdOf(id)] = input && typeof input === "object" ? input : {};
    }
    return { kons };
  } catch (err) {
    console.error(
      `  ✗ ${route} is not valid JSON (${err instanceof Error ? err.message : err}): ` +
        `starting with NO kons installed. Fix it or reinstall them with \`kitsuden kon add\`.`
    );
    return { kons: {} };
  }
}

/** Reads `kon.json` or, if there is none, the `kitsuden` field of package.json. */
export function readManifestSync(dir: string): KonManifestFile | null {
  const konJson = join(dir, "kon.json");
  if (existsSync(konJson)) {
    try {
      const m = JSON.parse(readFileSync(konJson, "utf8")) as KonManifestFile;
      return m && typeof m.id === "string" ? m : null;
    } catch (err) {
      console.warn(
        `  ⚠️  ${konJson} is not valid JSON: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }
  const pkgJson = join(dir, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      const k = pkg?.kitsuden;
      if (k && (k.type === "kon" || k.type === "core-den" || typeof k.id === "string")) {
        return {
          ...k,
          id: k.id || pkg.name,
          name: k.name || pkg.name,
          version: pkg.version,
        } as KonManifestFile;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function isDir(route: string): boolean {
  try {
    return statSync(route).isDirectory();
  } catch {
    return false;
  }
}

/** `node_modules` folders where a published kon may be. */
function nodeModulesDirs(root: string): string[] {
  return [
    join(root, "node_modules"),
    join(root, "apps", "api", "node_modules"),
    join(process.cwd(), "node_modules"),
  ].filter((p, i, all) => all.indexOf(p) === i && existsSync(p));
}

/** Where the folder of a declared kon is (see the header). */
export function resolveKonRoute(
  id: string,
  input: KonInput,
  root: string = projectRoot()
): string | null {
  if (input.path) {
    const route = isAbsolute(input.path) ? input.path : resolve(root, input.path);
    return isDir(route) ? route : null;
  }

  const copy = join(root, "packages", "kons", id);
  if (isDir(copy)) return copy;

  const names = [input.package, `@kitsuden/${id}`, id].filter(Boolean) as string[];
  for (const nm of nodeModulesDirs(root)) {
    for (const name of names) {
      const route = join(nm, name);
      if (isDir(route)) return route;
    }
  }
  return null;
}

/** The core modules (`packages/core/*` with kon.json): always installed. */
export function coreKons(root: string = projectRoot()): InstalledKon[] {
  const dir = join(root, "packages", "core");
  if (!existsSync(dir)) return [];
  const output: InstalledKon[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const route = join(dir, e.name);
    if (!existsSync(join(route, "kon.json"))) continue;
    const manifest = readManifestSync(route);
    if (!manifest) continue;
    output.push({
      id: konIdOf(manifest.id),
      path: route,
      source: "core",
      declaredOne: {},
      manifest,
    });
  }
  return output.sort((a, b) => a.id.localeCompare(b.id));
}

let cache: { key: string; kons: InstalledKon[] } | null = null;

/**
 * All installed kons: the core ones and the declared ones, resolved.
 *
 * Cached by (root, KITSUDEN_KONS): installing or removing a kon changes the
 * file and requires restarting the API, just like changing the code.
 */
export function listInstalledKons(
  options: { root?: string; env?: string; refresh?: boolean } = {}
): InstalledKon[] {
  const root = options.root ?? projectRoot();
  const environment = options.env ?? process.env.KITSUDEN_KONS ?? "";
  const key = `${root}\u0000${environment}`;
  if (!options.refresh && cache?.key === key) return cache.kons;

  const core = coreKons(root);
  const ofTheCore = new Set(core.map((k) => k.id));

  const declaredAll = new Map<string, { input: KonInput; source: "config" | "env" }>();
  for (const [id, input] of Object.entries(readKonsFile(root).kons)) {
    declaredAll.set(id, { input, source: "config" });
  }
  for (const [id, input] of parseEnvKons(environment)) {
    const earlier = declaredAll.get(id);
    // The environment wins on SOURCE; the rest (version, seed) is kept.
    declaredAll.set(id, {
      input: {
        ...(earlier?.input ?? {}),
        ...input,
        ...(input.path ? { package: undefined } : {}),
        ...(input.package ? { path: undefined } : {}),
      },
      source: "env",
    });
  }

  const rest: InstalledKon[] = [];
  for (const [id, { input: input, source: origin }] of declaredAll) {
    if (ofTheCore.has(id)) continue; // declaring a core module does nothing
    const route = resolveKonRoute(id, input, root);
    rest.push({
      id,
      path: route,
      source: origin,
      declaredOne: input,
      manifest: route ? readManifestSync(route) : null,
    });
  }
  rest.sort((a, b) => a.id.localeCompare(b.id));

  const kons = [...core, ...rest];
  cache = { key, kons };
  return kons;
}

/** The installed kon with that id (with or without prefix), if it is installed. */
export function installedKon(id: string, kons = listInstalledKons()): InstalledKon | undefined {
  const searched = konIdOf(id);
  return kons.find((k) => k.id === searched);
}

/** Folder of an installed kon found on disk, or `null`. */
export function konRoute(id: string): string | null {
  return installedKon(id)?.path ?? null;
}

/** Is it a core module (datasets, media, blocks…)? */
export function isCoreModule(id: string): boolean {
  return installedKon(id)?.source === "core";
}

/** For tests: forget the cached root and list. */
export function forgetInstalledKons(): void {
  cache = null;
  cacheRoot = null;
}

/**
 * Can this core mount a kon that declares `sdk` in its manifest?
 *
 * Returns the reason NOT to mount it, or `null` if it is compatible. A kon without
 * `sdk` predates the field and is treated as v1. The number compared is
 * the one published by `GET /api/version` in `sdk.kons`.
 */
export function incompatibleSdkReason(
  id: string,
  sdk: unknown,
  coreVersion: number = KONS_SDK_VERSION
): string | null {
  if (sdk === undefined || sdk === null) return null;
  if (typeof sdk !== "number" || !Number.isInteger(sdk) || sdk < 1) {
    return `${id}: the "sdk" in its manifest is not an integer >= 1 (${JSON.stringify(sdk)})`;
  }
  if (sdk > coreVersion) {
    return (
      `${id} needs kons SDK v${sdk} and this Kitsuden offers v${coreVersion} ` +
      `(GET /api/version → sdk.kons). Update Kitsuden or install a version of the kon ` +
      `written for SDK v${coreVersion}.`
    );
  }
  return null;
}
