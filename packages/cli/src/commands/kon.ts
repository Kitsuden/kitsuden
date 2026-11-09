/**
 * `kitsuden kon add|remove|list` — install kons into a Kitsuden project
 * ============================================================================
 *
 *   kitsuden kon add blog                      ← from ../kitsuden-kons or the official repo
 *                                                (unsigned: asks for confirmation, see below)
 *   kitsuden kon add wiki --from ../kitsuden-kons
 *   kitsuden kon add shop --from https://github.com/acme/kons.git --ref v1.2.0
 *   kitsuden kon add blog --link               ← without copying (developing the kon)
 *   kitsuden kon remove blog                   ← leaves the tables and the data
 *   kitsuden kon list [--available] [--json]
 *
 * The logic lives in `../kons/installation.ts` (no processes, tested separately).
 * Here we add what does launch processes: cloning the git origin, `pnpm
 * install` and the normal migration runner (`apps/api/scripts/migrate.ts
 * --kon <id>`), which is the same one the container runs on startup.
 *
 * Installing from git is installing unsigned code: nothing proves who wrote it,
 * its migrations run with the DDL role, and the API loads it in-process. So it
 * needs an interactive yes or --trust-source, and the exact commit is shown,
 * recorded in kitsuden.kons.json and reused on later installs (--latest moves
 * it). Lifecycle scripts are refused in the kon and disabled in pnpm install.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import chalk from "chalk";

import { syncDockerOverlay } from "../kons/docker-overlay.js";
import {
  KonError,
  DEFAULT_ORIGIN,
  findRoot,
  isGitUrl,
  installationStatus,
  konIdOf,
  installKons,
  sourceKons,
  readKonsFile,
  shortName,
  removeKons,
  codeSdk,
  type InstalledKonNow,
} from "../kons/installation.js";
import { hasConfiguredRegistry } from "../registry/client.js";
import { runCommandSync } from "../utils/run-command.js";

import {
  konAddFromRegistry,
  askQuestion,
  removeFromLock,
  type RegistryOptions,
} from "./kon-registry.js";

export interface KonCommandOptions {
  from?: string;
  ref?: string;
  link?: boolean;
  enable?: boolean;
  force?: boolean;
  trustSource?: boolean;
  latest?: boolean;
  install?: boolean; // --no-install → false
  migrate?: boolean; // --no-migrate → false
  keepFiles?: boolean;
  available?: boolean;
  json?: boolean;
  root?: string;
  apiUrl?: string;
  /** Write docker-compose.kons.yml (once; later adds and removes keep it in step). */
  docker?: boolean;
}

export function rootOf(options: KonCommandOptions): string {
  const root = options.root ? resolve(options.root) : findRoot(process.cwd());
  if (!root || !existsSync(join(root, "packages", "kons"))) {
    throw new KonError(
      "Not inside a Kitsuden project (no pnpm-workspace.yaml + packages/kons found). " +
        "Run it from the project, or pass --root <dir>."
    );
  }
  return root;
}

/**
 * The kon SDK version of this core: the one published by the running API
 * (`GET /api/version` → `sdk.kons`) and, if it does not respond, the one in the code.
 */
export async function coreSdk(
  root: string,
  apiUrl?: string
): Promise<{ sdk: number; from: string; version?: string }> {
  const url = (apiUrl || process.env.KITSUDEN_API_URL || "").replace(/\/+$/, "");
  if (url) {
    try {
      const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const json = (await r.json()) as {
          product?: string;
          /** The 0.8 name of `product`. Remove in 0.10. */
          producto?: string;
          version?: unknown;
          sdk?: { kons?: unknown };
        };
        if ((json.product ?? json.producto) === "kitsuden" && typeof json.sdk?.kons === "number") {
          return {
            sdk: json.sdk.kons,
            from: `${url}/api/version`,
            ...(typeof json.version === "string" ? { version: json.version } : {}),
          };
        }
      }
    } catch {
      // API off or unreachable: the code is used
    }
  }
  const ofTheCode = codeSdk(root);
  if (ofTheCode === null) {
    throw new KonError(
      "Could not find this Kitsuden's kon SDK version (packages/shared/src/operations.ts). " +
        "Pass --api-url of a running API, or reinstall Kitsuden."
    );
  }
  return { sdk: ofTheCode, from: "packages/shared (source)" };
}

/** The requested origin, or `KITSUDEN_KONS_SOURCE`, or `../kitsuden-kons`, or the official repo. */
function requestedOrigin(root: string, options: KonCommandOptions): string {
  if (options.from) return options.from;
  if (process.env.KITSUDEN_KONS_SOURCE) return process.env.KITSUDEN_KONS_SOURCE;
  const sibling = resolve(root, "..", "kitsuden-kons");
  if (existsSync(join(sibling, "kons"))) return sibling;
  return DEFAULT_ORIGIN;
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function git(args: string[], cwd?: string): { ok: boolean; output: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    shell: false,
  });
  return { ok: r.status === 0, output: (r.stdout ?? "").trim() };
}

/** Credentials in a URL must not reach kitsuden.kons.json or the terminal. */
function urlWithoutCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/, "$1");
}

interface PreparedOrigin {
  local: string;
  declaredOne: string;
  /** The git commit that was checked out. Absent for a local folder. */
  commit?: string;
}

/**
 * Puts the origin in a local folder: if it is git, it brings it to .kitsuden/kons-cache,
 * at the commit that `ref` resolves to (by default, the main branch).
 */
function prepareSource(root: string, origin: string, ref?: string): PreparedOrigin {
  if (!isGitUrl(origin)) {
    const local = resolve(process.cwd(), origin);
    if (!existsSync(local)) throw new KonError(`Source not found: ${local}`);
    return { local, declaredOne: origin };
  }
  const url = origin.replace(/^github:/, "https://github.com/").replace(/(#.*)$/, "");
  const branch = ref ?? origin.match(/#(.+)$/)?.[1];
  if (url.startsWith("-")) throw new KonError(`Invalid git source: ${JSON.stringify(origin)}`);
  if (branch && !SAFE_REF.test(branch))
    throw new KonError(`Invalid git ref: ${JSON.stringify(branch)}`);

  const cache = join(
    root,
    ".kitsuden",
    "kons-cache",
    createHash("sha256").update(url).digest("hex").slice(0, 16)
  );
  mkdirSync(cache, { recursive: true });
  if (!existsSync(join(cache, ".git")) && !git(["init", "--quiet", cache]).ok) {
    throw new KonError(`Could not create the git cache at ${cache} (is git installed?).`);
  }
  // Fetched by ref every time: a stale cached copy must never pass for the
  // commit the user is about to confirm.
  const secure = urlWithoutCredentials(url);
  if (
    !git(["fetch", "--quiet", "--depth", "1", "--no-tags", "--", url, branch ?? "HEAD"], cache).ok
  ) {
    throw new KonError(`git fetch of ${secure}${branch ? ` at ${branch}` : ""} failed.`);
  }
  if (!git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], cache).ok) {
    throw new KonError(`git checkout of ${secure} failed.`);
  }
  git(["clean", "--quiet", "-fdx"], cache);
  const commit = git(["rev-parse", "HEAD"], cache).output;
  if (!/^[0-9a-f]{40,64}$/.test(commit))
    throw new KonError(`Could not read the commit of ${secure}.`);
  return { local: cache, declaredOne: branch ? `${secure}#${branch}` : secure, commit };
}

/**
 * The commit a reinstall stays on: the one recorded for these kons, if they all
 * came from this URL at the same commit. A new push to the source does not
 * reach an existing project until someone asks for it (--latest or --ref).
 */
export function recordedCommit(root: string, origin: string, names: string[]): string | undefined {
  if (!isGitUrl(origin)) return undefined;
  const url = urlWithoutCredentials(
    origin.replace(/^github:/, "https://github.com/").replace(/(#.*)$/, "")
  );
  const { kons } = readKonsFile(root);
  const inputs = names.map((n) => kons[konIdOf(n)]);
  const commits = new Set(
    inputs.map((e) => (e?.commit && e.source?.split("#")[0] === url ? e.commit : undefined))
  );
  const [commit] = commits;
  return commits.size === 1 ? commit : undefined;
}

/** The warning and the yes for a git source. False means: stop, nothing was installed. */
async function confirmGitOrigin(
  origin: PreparedOrigin,
  options: KonCommandOptions
): Promise<boolean> {
  console.log(chalk.yellow(`\n! Unsigned source: ${origin.declaredOne}`));
  console.log(chalk.yellow(`  commit ${origin.commit}`));
  console.log(
    chalk.gray(
      "  Nothing verifies who wrote this code. It will be copied into this project, its\n" +
        "  migrations will run with the DDL role and the API will load it in-process.\n" +
        "  A signed registry checks the publisher: see docs/kons/registry.md."
    )
  );
  if (options.trustSource) return true;
  if (await askQuestion("Install from this source at this commit?")) return true;
  console.error(
    chalk.red(
      "✖ Not installed: confirmation required (answer y, or pass --trust-source after reviewing)."
    )
  );
  process.exitCode = 3;
  return false;
}

function run(order: string, args: string[], cwd: string): number {
  return runCommandSync(order, args, { cwd });
}

export function fail(e: unknown): never {
  console.error(chalk.red(`✖ ${(e as Error).message}`));
  process.exit(1);
}

// ── add ─────────────────────────────────────────────────────────────────────

export async function konAddCommand(names: string[], options: KonCommandOptions): Promise<void> {
  // A registry install: `kon add blog@^2`, --registry, or a configured registry
  // (kitsuden.registries.json / KITSUDEN_KON_REGISTRY) and no --from/--link.
  if (!options.from && !options.link) {
    let registryRoot: string | null = null;
    try {
      registryRoot = rootOf(options);
    } catch (e) {
      fail(e);
    }
    const asksVersion = names.some((n) => n.lastIndexOf("@") > 0);
    if (
      (options as { registry?: string }).registry ||
      asksVersion ||
      hasConfiguredRegistry(registryRoot)
    ) {
      return konAddFromRegistry(names, options as KonCommandOptions & RegistryOptions);
    }
  }
  let root: string;
  let facts: InstalledKonNow[];
  try {
    // Before anything is fetched: a bad name must not reach git or the disk.
    for (const n of names) konIdOf(n);
    root = rootOf(options);
    const { sdk, from } = await coreSdk(root, options.apiUrl);
    const request = requestedOrigin(root, options);
    const pinnedItem =
      options.ref || options.latest ? undefined : recordedCommit(root, request, names);
    const prepared = prepareSource(root, request, options.ref ?? pinnedItem);
    if (prepared.commit && !(await confirmGitOrigin(prepared, options))) return;
    const { local, declaredOne, commit } = prepared;
    facts = installKons(names, {
      root,
      source: local,
      declaredOrigin: pinnedItem ? declaredOne.split("#")[0]! : declaredOne,
      commit,
      link: options.link,
      enable: options.enable,
      force: options.force,
      coreSdk: sdk,
    });
    console.log(chalk.gray(`  kon SDK of this Kitsuden: v${sdk} (${from})`));
  } catch (e) {
    fail(e);
  }

  for (const k of facts) {
    const dep = k.asDependency ? chalk.gray(" (dependency)") : "";
    const where = k.mode === "link" ? `linked from ${k.dir}` : `packages/kons/${k.id}`;
    console.log(
      chalk.green(`✔ ${k.id}${k.version ? `@${k.version}` : ""}`) + dep + chalk.gray(` → ${where}`)
    );
  }

  postInstallSteps(root, facts, options);
  reportDockerOverlay(root, options);
}

/** Keeps docker-compose.kons.yml in step (when it exists, or with --docker). */
function reportDockerOverlay(root: string, options: KonCommandOptions): void {
  const r = syncDockerOverlay(root, options.docker === true);
  if (!r) return;
  if (r.written) {
    console.log(
      chalk.gray(
        `  docker-compose.kons.yml → KITSUDEN_KONS="${r.kons.join(",")}" from ${r.context}`
      )
    );
  } else {
    console.warn(chalk.yellow(`! docker-compose.kons.yml not updated: ${r.reason}.`));
  }
}

/**
 * pnpm install + the normal migration runner (`--kon <id>`), for a source or a
 * registry install alike: a registry kon's migrations go through the same
 * runner and the same DDL role as any other.
 */
export function postInstallSteps(
  root: string,
  facts: InstalledKonNow[],
  options: KonCommandOptions
): void {
  // pnpm install: the copy is a workspace package and its own
  // (third-party) dependencies have to be there.
  if (options.install !== false && facts.some((k) => k.mode === "copy")) {
    console.log(chalk.cyan("\n→ pnpm install --ignore-scripts"));
    if (run("pnpm", ["install", "--ignore-scripts"], root) !== 0) {
      console.error(
        chalk.red(
          "✖ pnpm install failed. The kon is declared; fix the error and run `pnpm install --ignore-scripts`."
        )
      );
      process.exit(1);
    }
  }

  // The normal runner, with --kon: applies the migrations of what is installed even if
  // it is not yet active in the database (and those of everything active, as always).
  if (options.migrate !== false) {
    const runner = join(root, "apps", "api", "scripts", "migrate.ts");
    if (!existsSync(runner)) {
      console.warn(
        chalk.yellow("! apps/api/scripts/migrate.ts not found: migrations not applied.")
      );
    } else {
      const args = ["run", "scripts/migrate.ts", ...facts.flatMap((k) => ["--kon", k.id])];
      console.log(chalk.cyan(`\n→ bun ${args.join(" ")}  (apps/api)`));
      if (run("bun", args, join(root, "apps", "api")) !== 0) {
        console.error(
          chalk.red(
            `✖ Migrations failed. The kon is installed; run them again with:\n` +
              `    cd apps/api && bun run scripts/migrate.ts ${facts.map((k) => `--kon ${k.id}`).join(" ")}`
          )
        );
        process.exit(2);
      }
    }
  }

  console.log(`
${chalk.bold("Next steps")}
  · Restart the API so it mounts the new kon(s).
  · Kons that are not on by default are activated in the admin panel (Kons),
    or installed with --enable.`);
}

// ── remove ──────────────────────────────────────────────────────────────────

export async function konRemoveCommand(names: string[], options: KonCommandOptions): Promise<void> {
  let root: string;
  let removedItems: string[];
  try {
    root = rootOf(options);
    removedItems = removeKons(names, { root, force: options.force, keepFiles: options.keepFiles });
  } catch (e) {
    fail(e);
  }
  for (const id of removedItems) console.log(chalk.green(`✔ removed ${id}`));
  removeFromLock(root, removedItems);
  reportDockerOverlay(root, options);
  if (options.install !== false) {
    console.log(chalk.cyan("\n→ pnpm install --ignore-scripts"));
    run("pnpm", ["install", "--ignore-scripts"], root);
  }
  console.log(`
${chalk.bold("Note")}
  · Its tables and data are kept in the database (nothing is dropped).
  · Restart the API. If the kon is still active in the panel, the API logs it
    as "active but not installed" and does not mount it.`);
}

// ── list ────────────────────────────────────────────────────────────────────

export async function konListCommand(options: KonCommandOptions): Promise<void> {
  let root: string;
  try {
    root = rootOf(options);
  } catch (e) {
    fail(e);
  }

  if (options.available) {
    let local: string;
    try {
      ({ local } = prepareSource(root, requestedOrigin(root, options), options.ref));
    } catch (e) {
      fail(e);
    }
    const kons = sourceKons(local).map((k) => ({
      id: k.id,
      version: k.manifest.version,
      sdk: k.manifest.sdk ?? null,
      maturity: k.manifest.maturity ?? null,
      description: k.manifest.description ?? "",
    }));
    if (options.json) {
      console.log(JSON.stringify(kons, null, 2));
      return;
    }
    for (const k of kons) {
      console.log(
        `${chalk.bold(shortName(k.id).padEnd(20))} ${String(k.maturity ?? "-").padEnd(13)} ${chalk.gray(k.description.slice(0, 70))}`
      );
    }
    return;
  }

  const sdk = codeSdk(root);
  let status: ReturnType<typeof installationStatus>;
  try {
    status = installationStatus(root, sdk);
  } catch (e) {
    fail(e);
  }
  if (options.json) {
    console.log(JSON.stringify({ sdk, kons: status }, null, 2));
    return;
  }
  for (const k of status) {
    const color = k.status === "ok" ? chalk.green : chalk.red;
    const mode = k.source === "core" ? "core" : k.mode;
    console.log(
      `${color(k.status.padEnd(17))} ${chalk.bold(k.id.padEnd(24))} ${String(k.version ?? "").padEnd(12)} ${String(mode).padEnd(5)} ${chalk.gray(k.path ?? k.detail ?? "")}`
    );
    if (k.status !== "ok" && k.detail) console.log(chalk.gray(`${" ".repeat(18)}${k.detail}`));
  }
}
