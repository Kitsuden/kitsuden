/**
 * kitsuden new <name> — FRONTEND project from the neutral starter
 * ============================================================================
 *
 * Creates an Astro site that reads from a Kitsuden API that is already running.
 * It does NOT create or start the API.
 *
 * ── WHY ONLY THE FRONTEND ──────────────────────────────────────────────────
 *
 * The earlier version of this command promised a full project and did not
 * work: it was not registered in `index.ts`, it used `__dirname` in ESM,
 * it copied the whole starter (node_modules and dist included) and ran
 * `db:push` in an `apps/api` that the starter does not have.
 *
 * The Kitsuden API is not set up from here: there are no published images yet,
 * so a generated docker-compose would point to images that do not exist.
 * `--api` explains it and points to `docs/install/`. The `docker-publish.yml`
 * workflow publishes to
 * `ghcr.io/kitsuden/kitsuden/{api,admin,mcp}` when a `v*` tag is created;
 * until the first one is out, this stays the same.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 *   1. copies `kitsuden-starter-basic` without node_modules, dist, .astro or .env
 *      (filter in utils/copy-starter.ts);
 *   2. renames the package and removes what belonged to the monorepo (repository,
 *      author, license);
 *   3. writes `.env` from `.env.example` with KITSUDEN_API_URL, SITE_URL and
 *      SITE_NAME;
 *   4. with `--install` (or `--quickstart`), runs `pnpm install`;
 *   5. prints the next steps.
 *
 * Without a TTY (CI, pipes) it asks nothing: it uses the options or the default
 * values.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import chalk from "chalk";
import { execa } from "execa";
import inquirer from "inquirer";

import { copyStarter, findStarter } from "../utils/copy-starter.js";

export interface NewOptions {
  apiUrl?: string;
  siteUrl?: string;
  siteName?: string;
  from?: string;
  install?: boolean;
  quickstart?: boolean;
  yes?: boolean;
  api?: boolean;
}

export const DEFAULT_API_URL = "http://localhost:3000";
export const DEFAULT_SITE_URL = "http://localhost:4321";

/** The same one the starter ships (packages/starters/kitsuden-starter-basic/.gitignore). */
const GITIGNORE_DEFAULT = `# Build output and local state of this site
dist/
.astro/
node_modules/
.env
.inti/
.kitsuden/
`;

/** Valid unscoped npm package name, derived from the folder name. */
export function packageName(name: string): string {
  return (
    basename(name)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+/, "")
      .replace(/-+$/, "") || "kitsuden-site"
  );
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Replaces the value of `KEY=` in a .env, only on NON-commented lines.
 * If the key is not there, it adds it at the end. Exported for the tests.
 */
export function setVariable(env: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(env)) return env.replace(line, () => `${key}=${value}`);
  return `${env.replace(/\n?$/, "\n")}${key}=${value}\n`;
}

/** Quotes only if the value needs them (spaces, #, quotes). */
function envValue(v: string): string {
  return /[\s#"'$]/.test(v) ? JSON.stringify(v) : v;
}

export function apiText(): string {
  return [
    chalk.bold("About the Kitsuden API"),
    "",
    "  This project is only the public website. It needs a running Kitsuden API.",
    "  There are no published Kitsuden API images yet, so `kitsuden new` does not",
    "  generate a docker-compose for it. Install the API from the Kitsuden",
    "  repository (https://github.com/Kitsuden/kitsuden) following:",
    "",
    "    docs/install/server.md      Docker (recommended)",
    "    docs/install/local.md       local development (Bun + Postgres + Valkey)",
    "    docs/install/first-run.md   migrations and the first admin",
    "",
    "  Then set KITSUDEN_API_URL in .env to its address.",
  ].join("\n");
}

async function emptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true;
  return (await readdir(dir)).length === 0;
}

async function askQuestion(
  options: NewOptions,
  name: string
): Promise<{ apiUrl: string; siteUrl: string; siteName: string }> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const withoutQuestions = options.yes || options.quickstart || !interactive;

  let apiUrl = options.apiUrl;
  if (!apiUrl && !withoutQuestions) {
    const r = await inquirer.prompt([
      {
        type: "input",
        name: "apiUrl",
        message: "URL of your Kitsuden API (as this server will reach it):",
        default: DEFAULT_API_URL,
        validate: (v: string) => isHttpUrl(v) || "Use an http:// or https:// URL",
      },
    ]);
    apiUrl = r.apiUrl as string;
  }
  apiUrl = apiUrl || DEFAULT_API_URL;
  if (!isHttpUrl(apiUrl)) throw new Error(`--api-url is not an http(s) URL: ${apiUrl}`);

  const siteUrl = options.siteUrl || DEFAULT_SITE_URL;
  if (!isHttpUrl(siteUrl)) throw new Error(`--site-url is not an http(s) URL: ${siteUrl}`);

  return { apiUrl, siteUrl, siteName: options.siteName || name };
}

/**
 * The real work, without `process.exit` or prompts: used by the command and
 * the tests. Returns the created folder.
 */
export async function createProject(
  name: string,
  values: { apiUrl: string; siteUrl: string; siteName: string; from?: string; cwd?: string }
): Promise<{ target: string; source: string; sourceType: string }> {
  const target = resolve(values.cwd ?? process.cwd(), name);
  if (!(await emptyDir(target))) {
    throw new Error(`${target} already exists and is not empty`);
  }

  const starter = findStarter(values.from);
  if (!starter) {
    throw new Error(
      values.from
        ? `--from ${values.from} is not a Kitsuden starter (needs package.json, astro.config.mjs and .env.example)`
        : "The Kitsuden starter was not found. Run from the Kitsuden repository, use a CLI " +
            "installed from npm (it bundles the starter), or pass --from <path-to-kitsuden-starter-basic>."
    );
  }

  await copyStarter(starter.dir, target);

  // package.json: its own name, and what described the monorepo's starter is removed.
  const pkgPath = join(target, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
  pkg.name = packageName(name);
  pkg.version = "0.1.0";
  pkg.description = `Website built on Kitsuden (from kitsuden-starter-basic)`;
  delete pkg.repository;
  delete pkg.author;
  delete pkg.license;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  // npm never publishes a `.gitignore` inside a package, so the starter
  // shipped in the npm CLI arrives without one. Without this, the `.env` below
  // (which may end up with KITSUDEN_SITE_KEY) would go into the first commit.
  if (!existsSync(join(target, ".gitignore"))) {
    await writeFile(join(target, ".gitignore"), GITIGNORE_DEFAULT, "utf8");
  }

  // .env from .env.example. KITSUDEN_SITE_KEY stays commented out: it is a
  // secret, and asking for it as an option would leave it in the shell history.
  let env = await readFile(join(target, ".env.example"), "utf8");
  env = setVariable(env, "KITSUDEN_API_URL", envValue(values.apiUrl));
  env = setVariable(env, "SITE_URL", envValue(values.siteUrl));
  env = setVariable(env, "SITE_NAME", envValue(values.siteName));
  await writeFile(join(target, ".env"), env, "utf8");

  return { target, source: starter.dir, sourceType: starter.source };
}

export async function newCommand(name: string | undefined, options: NewOptions = {}) {
  if (!name && options.api) {
    apiInfoCommand();
    return;
  }
  if (!name) {
    console.error(chalk.red("Missing project name. Example: kitsuden new my-site"));
    process.exit(1);
  }

  try {
    const values = await askQuestion(options, basename(name));
    const {
      target,
      source: origin,
      sourceType,
    } = await createProject(name, {
      ...values,
      from: options.from,
    });

    console.log(chalk.green(`✔ Created ${target}`));
    console.log(chalk.gray(`  starter: ${origin} (${sourceType})`));
    console.log(chalk.gray(`  .env: KITSUDEN_API_URL=${values.apiUrl} SITE_URL=${values.siteUrl}`));

    const install = options.install || options.quickstart;
    if (install) {
      console.log(chalk.cyan("\n→ pnpm install"));
      try {
        await execa("pnpm", ["install"], { cwd: target, stdio: "inherit" });
      } catch (e) {
        console.error(
          chalk.red(`pnpm install failed: ${(e as Error).message.split("\n")[0]}`) +
            "\nThe project was created; run `pnpm install` inside it once the problem is fixed."
        );
        process.exit(1);
      }
    }

    const ir = relative(process.cwd(), target) || ".";
    console.log(`\n${chalk.bold("Next steps")}\n`);
    console.log(`  cd ${ir}`);
    if (!install) console.log("  pnpm install");
    console.log("  pnpm dev            # http://localhost:4321 (needs the API running)");
    console.log("  pnpm build          # production build; it does not call the API");
    console.log("  pnpm start          # serve dist/ (reads KITSUDEN_API_URL at start)");
    console.log(
      `\n  In the Kitsuden admin, publish a page with the slug "home" to fill "/".` +
        `\n  Optional: set KITSUDEN_SITE_KEY in .env (see the project's README).\n`
    );

    if (options.api) console.log(`${apiText()}\n`);
    else
      console.log(
        chalk.gray(
          "  No Kitsuden API yet? Run `kitsuden new --api` or read docs/install/ in the Kitsuden repository.\n"
        )
      );
  } catch (e) {
    console.error(chalk.red(`✖ ${(e as Error).message}`));
    process.exit(1);
  }
}

/** `kitsuden new --api` with no name: just the explanation. */
export function apiInfoCommand(): void {
  console.log(`${apiText()}\n`);
}
