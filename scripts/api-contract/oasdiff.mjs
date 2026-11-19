#!/usr/bin/env node
/**
 * Breaking changes in the published contract (oasdiff)
 * ============================================================================
 *
 * Compares the committed OpenAPI snapshot of the kon SDK operations
 * (`packages/sdk/openapi/kitsuden.openapi.json`, the input of the typed
 * clients) with the same file at another git revision, and classifies every
 * difference: ERR (breaks an existing client), WARN (may break one), INFO.
 *
 *   node scripts/api-contract/oasdiff.mjs                       # vs origin/main
 *   node scripts/api-contract/oasdiff.mjs --base=<git ref>      # vs another revision
 *   node scripts/api-contract/oasdiff.mjs --base-file=<file>    # vs a file (a kon's old spec)
 *   node scripts/api-contract/oasdiff.mjs --spec=<file>         # another "new" document
 *   node scripts/api-contract/oasdiff.mjs --changelog           # every change, not only breaking
 *   node scripts/api-contract/oasdiff.mjs --summary=<file>      # append a Markdown report
 *                                                               # (CI: $GITHUB_STEP_SUMMARY)
 *   node scripts/api-contract/oasdiff.mjs --github              # annotations in a GitHub job
 *
 * Exit code: 1 when there is at least one ERR, 0 otherwise (WARN does not fail).
 *
 * oasdiff is not a dependency: it is a Go binary (Apache-2.0). This script
 * downloads the PINNED release once into `node_modules/.cache`, checks its
 * SHA-256 against the table below and refuses to run anything else. To move
 * to another version: change OASDIFF_VERSION and the hashes, taken from the
 * release's `checksums.txt` (https://github.com/oasdiff/oasdiff/releases).
 * `OASDIFF_BINARY=<path>` uses a binary you installed yourself instead.
 *
 * Deprecation policy (docs/api-contract.md): removing an operation that was
 * never marked `deprecated` is an ERR. A deprecated one may go once its
 * `x-sunset` date has passed; with no `x-sunset`, oasdiff asks for
 * DEPRECATION_DAYS of notice.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SNAPSHOT = "packages/sdk/openapi/kitsuden.openapi.json";

export const OASDIFF_VERSION = "1.37.0";
/** sha256 of each release archive, from the release's checksums.txt. */
const OASDIFF_SHA256 = {
  "darwin-all": "eccf5b9f46e689f8adcd79b79d4fdbde26a28301b6a74a0b449ad6a49e187e45",
  "linux-amd64": "eac87307d31d08c36800c58a409c247f1c5db37fbb72e2544402f22a87cbca3c",
  "linux-arm64": "072a425ac647ecf2808721e91293fd644cee7935d2b32e650b3158539b2c7898",
  "windows-amd64": "d72f1c5c4ba4adddafa4ec3c38f1c34f09df8ddb2d2bdd75869f94145c5bcc6d",
  "windows-arm64": "8d452a04078ffa2428ce303d7565d5ec01de590cb9cd01f159b10341b3dde7e1",
};
/** Notice a deprecated operation gets before it may be removed, when it has no `x-sunset`. */
export const DEPRECATION_DAYS = 90;

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => args.includes(`--${n}`);

function platformKey() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (process.platform === "darwin") return "darwin-all";
  if (!arch) throw new Error(`oasdiff: no pinned build for ${process.platform}/${process.arch}`);
  if (process.platform === "linux") return `linux-${arch}`;
  if (process.platform === "win32") return `windows-${arch}`;
  throw new Error(`oasdiff: no pinned build for ${process.platform}`);
}

/** The pinned binary, downloaded and verified on first use. */
async function oasdiffBinary() {
  if (process.env.OASDIFF_BINARY) return process.env.OASDIFF_BINARY;
  const key = platformKey();
  const exe = process.platform === "win32" ? "oasdiff.exe" : "oasdiff";
  const dir = join(
    ROOT,
    "node_modules/.cache/kitsuden-api-contract",
    `oasdiff-${OASDIFF_VERSION}-${key}`
  );
  const bin = join(dir, exe);
  if (existsSync(bin)) return bin;

  const archive = `oasdiff_${OASDIFF_VERSION}_${key.replace("-", "_")}.tar.gz`;
  const url = `https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/${archive}`;
  process.stderr.write(`[oasdiff] downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`oasdiff: GET ${url} → ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== OASDIFF_SHA256[key]) {
    throw new Error(
      `oasdiff: checksum mismatch for ${archive}\n  expected ${OASDIFF_SHA256[key]}\n  got      ${got}\nNothing was extracted.`
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, archive), bytes);
  // Relative names and `cwd`: GNU tar (Git Bash) reads `C:\...` as a remote host.
  const r = spawnSync("tar", ["-xzf", archive, exe], { cwd: dir, encoding: "utf8" });
  rmSync(join(dir, archive), { force: true });
  if (r.status !== 0 || !existsSync(bin)) {
    throw new Error(`oasdiff: could not extract ${archive}: ${r.stderr || r.error?.message}`);
  }
  return bin;
}

/** The snapshot at a git revision, or null when it did not exist there. */
function snapshotAt(ref) {
  const r = spawnSync("git", ["show", `${ref}:${SNAPSHOT}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

function run(bin, sub, base, head, extra) {
  const r = spawnSync(bin, [sub, base, head, ...extra], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`oasdiff ${sub}: ${r.error.message}`);
  return r;
}

async function main() {
  const head = resolve(ROOT, arg("spec") ?? SNAPSHOT);
  let base = arg("base-file") ? resolve(arg("base-file")) : null;
  // oasdiff reads a missing file as an empty document and reports "no changes".
  for (const f of [head, base]) {
    if (f && !existsSync(f)) throw new Error(`${f} does not exist`);
  }
  const ref = arg("base") ?? "origin/main";
  const label = base ? base : `${ref}:${SNAPSHOT}`;
  if (!base) {
    const text = snapshotAt(ref);
    if (text === null) {
      process.stderr.write(`[oasdiff] ${label} does not exist: nothing to compare with.\n`);
      return 0;
    }
    base = join(tmpdir(), `kitsuden-oasdiff-base-${process.pid}.json`);
    writeFileSync(base, text);
  }

  const bin = await oasdiffBinary();
  // `--deprecation-days-stable`: oasdiff treats an operation with no
  // `x-stability-level` as stable.
  const policy = [`--deprecation-days-stable=${DEPRECATION_DAYS}`];
  try {
    const breaking = run(bin, "breaking", base, head, [
      ...policy,
      "--fail-on",
      "ERR",
      "--format",
      flag("github") ? "githubactions" : "text",
    ]);
    process.stdout.write(breaking.stdout);
    if (breaking.stderr) process.stderr.write(breaking.stderr);
    if (breaking.status !== 0 && breaking.status !== 1) {
      throw new Error(`oasdiff breaking exited ${breaking.status}`);
    }

    const wantsChangelog = flag("changelog") || arg("summary");
    if (wantsChangelog) {
      const md = run(bin, "changelog", base, head, [...policy, "--format", "markdown"]);
      if (md.status !== 0) throw new Error(`oasdiff changelog exited ${md.status}: ${md.stderr}`);
      const body = md.stdout.trim() || "_No changes in the contract._";
      if (flag("changelog")) process.stdout.write(`\n${body}\n`);
      if (arg("summary")) {
        const verdict =
          breaking.status === 1
            ? "**Breaking changes (ERR)**: an existing client stops working. Mark the operation `deprecated` with an `x-sunset` date first (docs/api-contract.md)."
            : "No breaking change (ERR).";
        appendFileSync(
          arg("summary"),
          `## API contract: changes vs \`${label}\`\n\n${verdict}\n\n${body}\n\n_oasdiff ${OASDIFF_VERSION}_\n`
        );
      }
    }
    return breaking.status === 1 ? 1 : 0;
  } finally {
    if (!arg("base-file")) rmSync(base, { force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[oasdiff] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
);
