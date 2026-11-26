#!/usr/bin/env node
/**
 * Release step 1: test, pack and inspect every published package.
 *
 *   node scripts/release/pack.mjs               all of them, in publish order
 *   node scripts/release/pack.mjs sdk cli       some of them
 *   node scripts/release/pack.mjs --skip-tests  pack and inspect only (tests ran already)
 *
 * For each package: `pnpm run prepublishOnly` (its tests and the dist check), then
 * `pnpm pack` into `release/`. `pnpm pack` runs `prepack` (delete dist/, build) and
 * rewrites `workspace:` ranges to real versions; `npm pack` would leave them, and
 * the published package would not install. Then every tarball is opened and
 * checked (see `inspect`). Nothing here talks to the registry.
 *
 * Release step 2 is the owner's: `npm publish release/<file>.tgz --tag beta` for
 * each line of `release/manifest.json`, in its order (docs/release.md). Publishing
 * the tarball checked here, not a fresh build, is the point.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "release");

/**
 * Publish order: a package goes after the ones it depends on, so that each
 * `npm publish` finds its dependencies already on the registry.
 */
export const PACKAGES = [
  { short: "shared", dir: "packages/shared" },
  { short: "codegen", dir: "packages/codegen" },
  { short: "sdk", dir: "packages/sdk" },
  { short: "cli", dir: "packages/cli" },
  { short: "mcp-server", dir: "packages/mcp-server" },
  { short: "create-kitsuden", dir: "packages/create-kitsuden" },
  { short: "kitsuden", dir: "packages/kitsuden" },
];

/**
 * Paths that must never be in a tarball. Tests are allowed only under `templates/`:
 * a scaffolded project (the starter, a kons repo) gets its own tests on purpose.
 */
const FORBIDDEN_PATHS = [
  [/^(?!templates\/)(.*\/)?(tests?|__tests__|__mocks__|fixtures)\//, "test folder"],
  [/^(?!templates\/).*\.(test|spec)\.[cm]?[jt]sx?$/, "test file"],
  // `.env.example` and `.env.<name>.example` are templates; any other .env is not
  [/(^|\/)\.env(?!(\.[^/]+)?\.(example|sample)$)(\.[^/]*)?$/, ".env file"],
  [/(^|\/)\.npmrc$/, ".npmrc (may hold a token)"],
  [/\.(pem|key|p12|pfx|keystore)$/, "key file"],
  [/(^|\/)id_(rsa|ed25519|ecdsa)/, "SSH key"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/\.tsbuildinfo$/, "tsbuildinfo"],
  [/(^|\/)\.(git|DS_Store|turbo|cache)(\/|$)/, "tool folder"],
];

/** Content that must never be in a tarball. */
const SECRETS = [
  [/npm_[A-Za-z0-9]{36}/, "npm token"],
  [/gh[pousr]_[A-Za-z0-9]{36}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{40,}/, "GitHub token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, "private key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic key"],
  [/\bsk-(proj-)?[A-Za-z0-9]{32,}/, "OpenAI key"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/kitsuden_agent_[A-Za-z0-9]{24,}/, "Kitsuden agent token"],
];

/** A connection URL with a literal password (not a placeholder or a variable). */
const URL_PASSWORD =
  /\b(postgres(?:ql)?|mysql|redis|rediss|amqp|mongodb(?:\+srv)?):\/\/([^:/\s"'`@]+):([^@\s"'`]+)@/g;
const PLACEHOLDER =
  /^(\$|<|\{|\*+$|x+$|password$|pass$|secret$|changeme|change_me|postgres$|kitsuden$|user$|pw$|example)/i;

/** Where this machine's paths would leak from (the build writes them, never the sources). */
function localMarkers() {
  const markers = new Set();
  const home = homedir();
  for (const variant of [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")]) {
    if (variant.length > 3) markers.add(variant);
  }
  const user = userInfo().username;
  if (user && user.length > 2) {
    markers.add(`Users\\${user}`);
    markers.add(`Users/${user}`);
    markers.add(`home/${user}`);
  }
  return [...markers];
}

/** Reads a .tgz into { path, data } entries (ustar, as npm and pnpm write it). */
export function readTarball(file) {
  const buf = gunzipSync(Buffer.isBuffer(file) ? file : readFileSync(file));
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const data = buf.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === "0" || type === "\0") entries.push({ path: name.replace(/^package\//, ""), data });
  }
  return entries;
}

/** Everything that must hold for a tarball to be published. Returns the problems. */
export function inspect(file, sourceManifest) {
  const problems = [];
  const entries = readTarball(file);
  const paths = entries.map((e) => e.path);

  for (const path of paths) {
    for (const [re, what] of FORBIDDEN_PATHS) if (re.test(path)) problems.push(`${what}: ${path}`);
  }

  const markers = localMarkers();
  for (const { path, data } of entries) {
    const text = data.toString("utf8");
    for (const [re, what] of SECRETS) if (re.test(text)) problems.push(`${what} in ${path}`);
    for (const m of text.matchAll(URL_PASSWORD)) {
      if (!PLACEHOLDER.test(m[3]))
        problems.push(`URL with a literal password in ${path}: ${m[1]}://${m[2]}:***@`);
    }
    for (const marker of markers) {
      if (text.includes(marker)) {
        problems.push(`local path (${marker.replace(/[^\\/]+$/, "…")}) in ${path}`);
        break;
      }
    }
  }

  const manifestEntry = entries.find((e) => e.path === "package.json");
  if (!manifestEntry) {
    problems.push("no package.json");
    return { problems, entries };
  }
  const pkg = JSON.parse(manifestEntry.data.toString("utf8"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (/^(workspace|link|file|portal):/.test(range))
        problems.push(`${field}.${name} is "${range}"`);
    }
  }
  if (pkg.private) problems.push("package.json says private");
  if (pkg.name !== sourceManifest.name || pkg.version !== sourceManifest.version)
    problems.push(
      `tarball is ${pkg.name}@${pkg.version}, the source says ${sourceManifest.name}@${sourceManifest.version}`
    );
  for (const field of ["license", "repository", "homepage", "bugs", "description"]) {
    if (!pkg[field]) problems.push(`package.json has no "${field}"`);
  }
  if (!paths.some((p) => /^license(\.md|\.txt)?$/i.test(p))) problems.push("no LICENSE");
  if (!paths.some((p) => /^readme(\.md)?$/i.test(p))) problems.push("no README");
  if (
    /\.ts$/.test(pkg.main ?? "") ||
    JSON.stringify(pkg.exports ?? {}).match(/"\.\/src\/[^"]+\.ts"/)
  )
    problems.push("main/exports point at TypeScript sources (publishConfig not applied?)");

  return { problems, entries, pkg };
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  return r.status === 0;
}

function main() {
  const argv = process.argv.slice(2);
  const skipTests = argv.includes("--skip-tests");
  const wanted = argv.filter((a) => !a.startsWith("--"));
  const selected = wanted.length ? PACKAGES.filter((p) => wanted.includes(p.short)) : PACKAGES;
  const unknown = wanted.filter((w) => !PACKAGES.some((p) => p.short === w));
  if (unknown.length) {
    console.error(
      `unknown package(s): ${unknown.join(", ")} (known: ${PACKAGES.map((p) => p.short).join(", ")})`
    );
    process.exit(2);
  }

  mkdirSync(OUT, { recursive: true });
  const manifest = [];
  let failed = false;

  for (const p of selected) {
    const dir = join(ROOT, p.dir);
    const source = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    console.log(`\n━━ ${source.name}@${source.version} ━━`);

    if (!skipTests && source.scripts?.prepublishOnly) {
      console.log("prepublishOnly (tests and dist check)…");
      // prepublishOnly checks dist/, so it needs a build first; prepack rebuilds again from clean.
      if (source.scripts?.prepack && !run("pnpm", ["run", "prepack"], dir)) {
        console.error(`✗ ${source.name}: prepack failed`);
        failed = true;
        continue;
      }
      if (!run("pnpm", ["run", "prepublishOnly"], dir)) {
        console.error(`✗ ${source.name}: prepublishOnly failed`);
        failed = true;
        continue;
      }
    }

    // Remove an older tarball of the same package so the manifest never points at a stale one.
    // `<stem>-<digit>`: `kitsuden-` alone would also match kitsuden-cli-…, kitsuden-sdk-…
    const stem = source.name.replace(/^@/, "").replace("/", "-");
    const older = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d.*\\.tgz$`);
    for (const f of readdirSync(OUT)) if (older.test(f)) rmSync(join(OUT, f));

    if (!run("pnpm", ["pack", "--pack-destination", OUT], dir)) {
      console.error(`✗ ${source.name}: pnpm pack failed`);
      failed = true;
      continue;
    }
    const tarball = join(OUT, `${stem}-${source.version}.tgz`);
    // Read once: the bytes inspected are the bytes measured and hashed.
    const bytesRead = readFileSync(tarball);
    const { problems, entries } = inspect(bytesRead, source);
    const bytes = bytesRead.length;
    const integrity = `sha512-${createHash("sha512").update(bytesRead).digest("base64")}`;
    if (problems.length) {
      failed = true;
      console.error(`✗ ${basename(tarball)}: ${problems.length} problem(s)`);
      for (const pr of problems.slice(0, 40)) console.error(`   - ${pr}`);
    } else {
      console.log(
        `✓ ${basename(tarball)}: ${entries.length} files, ${(bytes / 1024).toFixed(1)} kB, nothing forbidden`
      );
    }
    manifest.push({
      name: source.name,
      version: source.version,
      tag: source.version.includes("-") ? "beta" : "latest",
      file: `release/${basename(tarball)}`,
      files: entries.length,
      bytes,
      integrity,
      ok: problems.length === 0,
    });
  }

  if (!wanted.length)
    writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `\n${failed ? "✗ Some packages are NOT ready." : "✓ All tarballs are ready."} ${OUT}`
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
