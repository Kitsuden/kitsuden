/**
 * create-kitsuden: a new Kitsuden project, with its secrets, in seconds.
 *
 *   docker (default)  docker-compose.yml + .env for the prebuilt images
 *                     (ghcr.io/kitsuden/kitsuden/{api,admin}:<version>). Nothing is
 *                     downloaded to scaffold: the files come with this package.
 *   local             a checkout of the source to run with Bun and pnpm, with
 *                     `.env` (for docker-compose.dev.yml) and `apps/api/.env`.
 *                     Needs the source: `git clone` (network), or `--source=<path>`
 *                     of a checkout you already have, or run it inside one.
 *
 * The production `.env` is written exactly as `install.sh` / `install.ps1` write
 * it, from the same `.env.production.example`: every `=<openssl rand -hex 32>`
 * becomes 32 random bytes in hex, SITE_DOMAIN / ACME_EMAIL / MAIL_FROM are
 * emptied, and the same "this machine" block is appended. Keep the three in step
 * (tests/unit/create-kitsuden.test.ts checks it against install.sh).
 *
 * Plain Node >= 20, no dependencies.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version;
export const DEFAULT_REGISTRY = "ghcr.io/kitsuden/kitsuden";
export const DEFAULT_SOURCE = "https://github.com/Kitsuden/kitsuden.git";
/** install.sh accepts an `.env` only if it carries this line (it greps for it). */
export const INSTALL_MARKER = "# Created by install.sh";
export const LOCAL_MARKER = "# Created by create-kitsuden (local development)";

/** What the Docker mode copies, by path relative to the repository root. */
export const TEMPLATE_FILES = [
  "docker-compose.yml",
  ".env.production.example",
  "docker/init-extensions.sql",
  "docker/seaweedfs-startup.sh",
  "docker/media-backup.sh",
];

/**
 * Where the templates are: the repository root when this runs from the monorepo
 * (always current), or `templates/` inside the published package (filled by
 * `scripts/sync-templates.mjs` before packing).
 */
export function templatesDir() {
  const repo = resolve(PACKAGE_DIR, "../..");
  if (
    existsSync(join(repo, "pnpm-workspace.yaml")) &&
    TEMPLATE_FILES.every((f) => existsSync(join(repo, f)))
  )
    return repo;
  const packed = join(PACKAGE_DIR, "templates");
  if (TEMPLATE_FILES.every((f) => existsSync(join(packed, f)))) return packed;
  throw new Error("the templates are missing from this package: reinstall create-kitsuden");
}

/** 32 random bytes in hex: the same as `openssl rand -hex 32`, safe in a URL. */
export function secret() {
  return randomBytes(32).toString("hex");
}

// ── Names and ports ─────────────────────────────────────────────────────────

const INSTANCE = /^[a-z0-9][a-z0-9_-]*$/;

/** The rules of install.sh for KITSUDEN_INSTANCE. */
export function checkInstance(name) {
  if (!INSTANCE.test(name))
    throw new Error(
      `instance "${name}": lowercase letters, digits, '-' and '_', starting with a letter or digit`
    );
  return name;
}

/** A valid instance from a folder name: `My App!` → `my-app`. */
export function instanceFromName(name) {
  const clean = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40);
  return clean || "kitsuden";
}

/** Is there already an install with this prefix (its database container or volume)? */
export function instanceInUse(instance, kind = "prod") {
  const run = (args) => spawnSync("docker", args, { encoding: "utf8", timeout: 8000 });
  const ps = run(["ps", "-a", "--format", "{{.Names}}"]);
  if (ps.error || ps.status !== 0) return false; // no Docker here: nothing to clash with
  // docker-compose.yml names them `<instance>_db_prod`; docker-compose.dev.yml `<instance>_db`.
  const [container, volume] =
    kind === "dev"
      ? [`${instance}_db`, `${instance}_postgres_data`]
      : [`${instance}_db_prod`, `${instance}_postgres_prod`];
  if (ps.stdout.split(/\r?\n/).includes(container)) return true;
  return run(["volume", "inspect", volume]).status === 0;
}

/**
 * Is the port free? It tries to LISTEN on it (it never connects to whatever is
 * there), on loopback and on all interfaces, as Docker would publish it.
 */
function canListen(port, host) {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => done(true)));
  });
}

export async function portFree(port) {
  return (await canListen(port, "127.0.0.1")) && (await canListen(port, "0.0.0.0"));
}

/** The first free port from `start`, skipping `taken`. */
export async function freePort(start, taken = new Set()) {
  let p = start;
  while (taken.has(p) || !(await portFree(p))) p++;
  taken.add(p);
  return p;
}

// ── Files ───────────────────────────────────────────────────────────────────

/**
 * The production `.env`, as install.sh writes it (same lines, same order). The
 * only difference: the images are the published ones, not `<instance>/api:latest`
 * built on this machine.
 */
export function renderProductionEnv(example, opts) {
  const { instance, ports, apiImage, adminImage } = opts;
  const makeSecret = opts.secret ?? secret;
  const out = [
    `${INSTALL_MARKER} (via create-kitsuden). Secrets are in here: never commit it, and keep a copy.`,
  ];
  const lines = example.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let line of lines) {
    line = line.replace(/\r$/, "");
    if (line.endsWith("=<openssl rand -hex 32>"))
      line = `${line.slice(0, line.indexOf("="))}=${makeSecret()}`;
    else if (/^(SITE_DOMAIN|ACME_EMAIL|MAIL_FROM)=/.test(line))
      line = line.slice(0, line.indexOf("=") + 1);
    else if (line.startsWith("COMPOSE_PROJECT_NAME=")) line = `COMPOSE_PROJECT_NAME=${instance}`;
    out.push(line);
  }
  const { api, admin, db, valkey } = ports;
  out.push(
    "",
    "# --- This machine (install.sh) ---",
    `KITSUDEN_INSTANCE=${instance}`,
    `KITSUDEN_API_IMAGE=${apiImage}`,
    `KITSUDEN_ADMIN_IMAGE=${adminImage}`,
    `API_PORT=${api}`,
    `ADMIN_PORT=${admin}`,
    `DB_PORT=${db}`,
    `VALKEY_PORT=${valkey}`,
    `BETTER_AUTH_URL=http://localhost:${api}`,
    `ADMIN_URL=http://localhost:${admin}`,
    `APP_URL=http://localhost:${admin}`,
    `ALLOWED_ORIGINS=http://localhost:${admin},http://127.0.0.1:${admin},http://localhost:${api},http://127.0.0.1:${api}`
  );
  const text = `${out.join("\n")}\n`;
  if (/^[A-Z_]+=</m.test(text))
    throw new Error(".env.production.example has a placeholder this tool does not know");
  return text;
}

/** Our images: a registry namespace that belongs to the project (never Docker Hub). */
const OWN_IMAGE =
  /^( {4}image: \$\{KITSUDEN_(?:API|ADMIN)_IMAGE:-ghcr\.io\/kitsuden\/kitsuden\/[a-z]+):latest\}\s*$/;

/**
 * docker-compose.yml for prebuilt images: the `build:` sections go (there is no
 * source to build from), and for our own images `pull_policy: never` becomes
 * `missing`, with the default tag pinned to this release instead of `latest`.
 *
 * `never` in the repository's file is there because it BUILDS the images (with
 * `missing`, compose would download instead of building) and because an
 * unqualified `kitsuden/*` name would come from a Docker Hub namespace that is
 * not ours. Here nothing is built, and the images are `ghcr.io/kitsuden/…`,
 * under the project's own organization, with the release tag in `.env`: compose
 * downloads them on the first `up`. Any other service keeps its policy.
 */
export function composeForImages(text, version) {
  const out = [];
  let skipping = false;
  let ownImage = false;
  for (let line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    const own = bare.match(OWN_IMAGE);
    if (own) {
      ownImage = true;
      line = `${own[1]}:${version}}`;
    } else if (/^ {2}\S/.test(bare)) {
      ownImage = false; // the next service
    } else if (ownImage && /^ {4}pull_policy: never\s*$/.test(bare)) {
      line = "    pull_policy: missing";
    }
    if (/^ {4}build:\s*$/.test(bare)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      const indent = line.match(/^ */)[0].length;
      if (line.trim() === "" || indent > 4) continue;
      skipping = false;
    }
    out.push(line);
  }
  const header = [
    `# Generated by create-kitsuden ${version} from Kitsuden's docker-compose.yml, for the`,
    "# published images: the `build:` sections were removed. The images are the ones in",
    "# .env (KITSUDEN_API_IMAGE, KITSUDEN_ADMIN_IMAGE), pinned to a release; the first",
    "# `docker compose up -d` downloads them. Keep them fully qualified (registry/name:tag):",
    "# an unqualified name would be looked up on Docker Hub.",
    "",
  ];
  return header.join("\n") + out.join("\n");
}

/** `apps/api/.env` and the root `.env` (for docker-compose.dev.yml) of a checkout. */
export function renderLocalEnv(apiExample, opts) {
  const makeSecret = opts.secret ?? secret;
  const { ports } = opts;
  const pg = makeSecret();
  const s3Key = makeSecret().slice(0, 20);
  const s3Secret = makeSecret();
  const root = [
    `${LOCAL_MARKER}. Secrets are in here: never commit it.`,
    "# Read by docker-compose.dev.yml (Postgres, SeaweedFS, Valkey for development).",
    "# Containers, volumes and network are named after the instance (<instance>_db…).",
    `KITSUDEN_INSTANCE=${opts.instance ?? "kitsuden"}`,
    "POSTGRES_USER=kitsuden",
    `POSTGRES_PASSWORD=${pg}`,
    "POSTGRES_DB=kitsuden_dev",
    `POSTGRES_PORT=${ports.db}`,
    `VALKEY_PORT=${ports.valkey}`,
    `S3_ACCESS_KEY=${s3Key}`,
    `S3_SECRET_KEY=${s3Secret}`,
    "S3_BUCKET=kitsuden-media",
    "",
  ].join("\n");
  const api = [`${LOCAL_MARKER}.`];
  const lines = apiExample.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let line of lines) {
    line = line.replace(/\r$/, "");
    const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
    if (key === "BETTER_AUTH_SECRET" || key === "KITSUDEN_SECRETS_KEY")
      line = `${key}=${makeSecret()}`;
    else if (key === "DATABASE_URL")
      line = `DATABASE_URL=postgres://kitsuden:${pg}@localhost:${ports.db}/kitsuden_dev`;
    else if (key === "S3_ACCESS_KEY") line = `S3_ACCESS_KEY=${s3Key}`;
    else if (key === "S3_SECRET_KEY") line = `S3_SECRET_KEY=${s3Secret}`;
    else if (key === "PORT") line = `PORT=${ports.api}`;
    else if (key === "BETTER_AUTH_URL") line = `BETTER_AUTH_URL=http://localhost:${ports.api}`;
    api.push(line);
  }
  const apiText = `${api.join("\n")}\n`;
  const left = apiText.match(/^[A-Z_][A-Z0-9_]*=.*<[A-Z0-9_]+>.*$/m);
  if (left)
    throw new Error(
      `apps/api/.env.example has a placeholder this tool does not know: ${left[0].split("=")[0]}`
    );
  return { root, api: apiText };
}

function writeSecretFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: the mode is not enforced there; the folder's ACL is what counts.
  }
}

function isEmptyDir(dir) {
  return !existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0);
}

function isCheckout(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg.name === "kitsuden-cms" && existsSync(join(dir, "apps/api/.env.example"));
  } catch {
    return false;
  }
}

// ── The scaffold ────────────────────────────────────────────────────────────

/**
 * Creates the project. Returns what it wrote and the next steps.
 *
 * @param {object} o
 * @param {string} o.dir                  target folder
 * @param {"docker"|"local"} [o.mode]
 * @param {string} [o.instance]           prefix of containers and volumes (docker)
 * @param {{api:number,admin:number,db:number,valkey:number}} [o.ports]  fixed ports
 * @param {boolean} [o.probe]             look for free ports and existing installs (default true)
 * @param {string} [o.registry]           image registry prefix
 * @param {string} [o.imageTag]           image tag (default: this package's version)
 * @param {string} [o.source]             local mode: git URL or path of a checkout
 * @param {string} [o.ref]                local mode: branch or tag to clone
 */
export async function scaffold(o) {
  const dir = resolve(o.dir);
  const mode = o.mode ?? "docker";
  if (mode !== "docker" && mode !== "local")
    throw new Error(`unknown mode "${mode}" (docker or local)`);
  const probe = o.probe !== false;
  const taken = new Set();
  const pick = async (key, start) =>
    o.ports?.[key] ?? (probe ? await freePort(start, taken) : start);

  if (mode === "docker") {
    if (!isEmptyDir(dir)) throw new Error(`${dir} exists and is not empty: choose a new folder`);
    let instance = checkInstance(o.instance ?? instanceFromName(basename(dir)));
    if (probe && instanceInUse(instance)) {
      if (o.instance) throw new Error(`the instance "${instance}" already exists on this machine`);
      let n = 2;
      while (instanceInUse(`${instance}${n}`)) n++;
      instance = `${instance}${n}`;
    }
    const ports = {
      api: await pick("api", 3000),
      admin: await pick("admin", 3001),
      db: await pick("db", 5432),
      valkey: await pick("valkey", 6379),
    };
    const tag = o.imageTag ?? VERSION;
    const registry = (o.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
    const apiImage = `${registry}/api:${tag}`;
    const adminImage = `${registry}/admin:${tag}`;
    const src = templatesDir();
    const read = (f) => readFileSync(join(src, f), "utf8");

    mkdirSync(join(dir, "docker"), { recursive: true });
    writeFileSync(
      join(dir, "docker-compose.yml"),
      composeForImages(read("docker-compose.yml"), VERSION)
    );
    for (const f of TEMPLATE_FILES.filter((f) => f.startsWith("docker/")))
      writeFileSync(join(dir, f), read(f));
    writeFileSync(join(dir, ".env.production.example"), read(".env.production.example"));
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    const env = renderProductionEnv(read(".env.production.example"), {
      instance,
      ports,
      apiImage,
      adminImage,
      secret: o.secret,
    });
    writeSecretFile(join(dir, ".env"), env);

    return {
      dir,
      mode,
      instance,
      ports,
      files: [
        "docker-compose.yml",
        ".env",
        ".env.production.example",
        ".gitignore",
        ...TEMPLATE_FILES.filter((f) => f.startsWith("docker/")),
      ],
      next: [
        `cd ${dir}`,
        `docker compose up -d      (the first time it downloads ${apiImage} and ${adminImage})`,
        `Open http://localhost:${ports.admin} and create your administrator. The one-time setup token is in the API log:`,
        `  docker compose logs kitsuden_api | grep -A4 "No administrator"`,
        `MCP endpoint: http://localhost:${ports.api}/api/mcp   Guide for agents: http://localhost:${ports.api}/llms.txt`,
      ],
    };
  }

  // ── local ──
  const written = [];
  let cloned = false;
  if (!isCheckout(dir)) {
    if (!isEmptyDir(dir))
      throw new Error(`${dir} exists, is not empty and is not a Kitsuden checkout`);
    const source = o.source ?? DEFAULT_SOURCE;
    const local = existsSync(source);
    const args = [
      "clone",
      ...(local ? [] : ["--depth", "1"]),
      ...(o.ref ? ["--branch", o.ref] : []),
    ];
    const r = spawnSync("git", [...args, local ? resolve(source) : source, dir], {
      stdio: "inherit",
    });
    if (r.error) throw new Error(`git is needed for the local mode (${r.error.message})`);
    if (r.status !== 0) throw new Error(`git clone ${source} failed`);
    if (!isCheckout(dir)) throw new Error(`${source} is not a Kitsuden checkout`);
    cloned = true;
  }
  const ports = {
    api: await pick("api", 3000),
    admin: 5173,
    db: await pick("db", 5432),
    valkey: await pick("valkey", 6379),
  };
  // Its own development containers and database, if another checkout already has them.
  let instance = checkInstance(o.instance ?? instanceFromName(basename(dir)));
  if (probe && !existsSync(join(dir, ".env")) && instanceInUse(instance, "dev")) {
    if (o.instance) throw new Error(`the instance "${instance}" already exists on this machine`);
    let n = 2;
    while (instanceInUse(`${instance}${n}`, "dev")) n++;
    instance = `${instance}${n}`;
  }
  const envs = renderLocalEnv(readFileSync(join(dir, "apps/api/.env.example"), "utf8"), {
    ports,
    instance,
    secret: o.secret,
  });
  const kept = [];
  for (const [rel, text] of [
    [".env", envs.root],
    ["apps/api/.env", envs.api],
  ]) {
    if (existsSync(join(dir, rel))) kept.push(rel);
    else {
      writeSecretFile(join(dir, rel), text);
      written.push(rel);
    }
  }
  return {
    dir,
    mode,
    instance,
    ports,
    cloned,
    files: written,
    kept,
    next: [
      `cd ${dir}`,
      "Install Bun 1.3+ first (the API runs on it), then: npm i -g pnpm@9.15.4",
      "pnpm install --frozen-lockfile",
      "docker compose -f docker-compose.dev.yml up -d kitsuden_db",
      "pnpm db:migrate",
      `pnpm dev:api      # API on http://localhost:${ports.api}`,
      "pnpm dev:admin    # panel on http://localhost:5173",
    ],
  };
}
