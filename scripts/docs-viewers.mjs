#!/usr/bin/env node
/**
 * The API documentation viewers, pinned and served from our own origin
 * ============================================================================
 *
 * `/api/docs` (Swagger UI) and `/api/docs/modern` (Scalar) used to load their
 * code from jsDelivr with no version (`@latest`): whatever was published that
 * minute ran on a page where people paste API tokens. Now the API serves both
 * itself, from `apps/api/docs-viewers/` (git-ignored), and the page pins each
 * file with Subresource Integrity.
 *
 * This script fills that folder. For each viewer in
 * `apps/api/src/lib/docs-viewers.json` it downloads the npm tarball (the same
 * file `npm install` would), checks it against the pinned `integrity`
 * (sha512), takes ONLY the listed files and checks each against its `sri`.
 * The packages are not dependencies: Scalar alone would add ~30 packages (Vue,
 * CodeMirror, an AI chat) to the API and to the published `kitsuden` package to
 * serve one JavaScript file.
 *
 *   node scripts/docs-viewers.mjs              # download what is missing or wrong
 *   node scripts/docs-viewers.mjs --check      # exit 1 if a file is missing or wrong (no network)
 *   node scripts/docs-viewers.mjs --soft       # like the default, but a network failure only warns
 *   node scripts/docs-viewers.mjs --update     # after bumping a version: recompute every `sri`
 *   node scripts/docs-viewers.mjs --out=<dir>  # another folder
 *   node scripts/docs-viewers.mjs --outdated   # is a newer release on npm? (exit 1 if so)
 *
 * Run by `apps/api` build (Docker image) and dev, and by the `kitsuden`
 * package build. No dependencies: Node >= 18 (fetch, zlib).
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINS_FILE = join(ROOT, "apps/api/src/lib/docs-viewers.json");
const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OUT = resolve(arg("out") ?? join(ROOT, "apps/api/docs-viewers"));
const check = args.includes("--check");
const soft = args.includes("--soft");
const update = args.includes("--update");

const sri = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const log = (s) => process.stderr.write(`[docs-viewers] ${s}\n`);

/** Files of a (ustar / GNU) tar archive, by name. Enough for npm tarballs. */
export function untar(buf) {
  const files = new Map();
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 500);
    const name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "\0") files.set(name, body);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function pins() {
  return JSON.parse(readFileSync(PINS_FILE, "utf8"));
}

const target = (id, v, file) => join(OUT, `${id}@${v.version}`, file);

/** Is every file of this viewer on disk with the pinned hash? */
function present(id, v) {
  return Object.entries(v.files).every(([file, f]) => {
    const p = target(id, v, file);
    return f.sri && existsSync(p) && sri(readFileSync(p)) === f.sri;
  });
}

async function fetchViewer(id, v) {
  const res = await fetch(v.tarball);
  if (!res.ok) throw new Error(`GET ${v.tarball} → ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const [algo, expected] = [v.integrity.slice(0, 6), v.integrity.slice(7)];
  if (algo !== "sha512") throw new Error(`${id}: integrity must be sha512`);
  const got = createHash("sha512").update(tgz).digest("base64");
  if (got !== expected) {
    throw new Error(`${id}: the tarball does not match the pinned integrity (got sha512-${got})`);
  }
  const files = untar(gunzipSync(tgz));
  const out = {};
  for (const [file, f] of Object.entries(v.files)) {
    const bytes = files.get(f.from);
    if (!bytes) throw new Error(`${id}: ${f.from} is not in ${v.package}@${v.version}`);
    out[file] = bytes;
  }
  return out;
}

/**
 * `--outdated`: which pinned viewers have a newer release on npm. Dependabot does not
 * read docs-viewers.json, so the monthly workflow (.github/workflows/docs-viewers.yml)
 * runs this. Exit 1 when one is behind, so the run shows up; `--summary=<file>` appends
 * a Markdown table ($GITHUB_STEP_SUMMARY).
 */
async function outdated() {
  const rows = [];
  for (const [id, v] of Object.entries(pins().viewers)) {
    const res = await fetch(`https://registry.npmjs.org/${v.package}/latest`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET ${v.package}/latest → ${res.status}`);
    // The registry's answer reaches the summary file: only a plain x.y.z, rebuilt from
    // its numbers, gets there. Anything else is reported as such for a person to look at.
    const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(String((await res.json())?.version));
    const latest = m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : "(not x.y.z)";
    rows.push({ id, package: v.package, pinned: v.version, latest, behind: latest !== v.version });
  }
  for (const r of rows) {
    log(
      `${r.id}: ${r.package} pinned ${r.pinned}, latest ${r.latest}${r.behind ? "  <- newer release" : ""}`
    );
  }
  const summary = arg("summary");
  if (summary) {
    const table = rows
      .map(
        (r) =>
          `| ${r.id} | \`${r.package}\` | ${r.pinned} | ${r.latest} | ${r.behind ? "update" : "ok"} |`
      )
      .join("\n");
    appendFileSync(
      summary,
      `## Documentation viewers\n\n| viewer | package | pinned | latest | |\n|---|---|---|---|---|\n${table}\n\n` +
        "To move one: change version, tarball and integrity in apps/api/src/lib/docs-viewers.json, run `node scripts/docs-viewers.mjs --update`, read its release notes and security advisories, and check both pages (docs/api-contract.md).\n"
    );
  }
  return rows.some((r) => r.behind) ? 1 : 0;
}

async function main() {
  if (args.includes("--outdated")) return outdated();
  const doc = pins();
  let changedPins = false;
  let failed = 0;
  for (const [id, v] of Object.entries(doc.viewers)) {
    if (!update && present(id, v)) continue;
    if (check) {
      log(
        `${id}@${v.version}: missing or not matching its sri (run node scripts/docs-viewers.mjs)`
      );
      failed++;
      continue;
    }
    let files;
    try {
      files = await fetchViewer(id, v);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (soft) {
        log(`WARNING ${id}@${v.version} not downloaded (${msg}); /api/docs will say so`);
        continue;
      }
      throw err;
    }
    for (const [file, bytes] of Object.entries(files)) {
      const hash = sri(bytes);
      if (update) {
        if (v.files[file].sri !== hash) changedPins = true;
        v.files[file].sri = hash;
      } else if (hash !== v.files[file].sri) {
        throw new Error(
          `${id}/${file}: ${hash} is not the pinned ${v.files[file].sri || "(empty)"}`
        );
      }
      mkdirSync(dirname(target(id, v, file)), { recursive: true });
      writeFileSync(target(id, v, file), bytes);
    }
    log(`${id}@${v.version}: ${Object.keys(files).join(", ")}`);
  }
  if (changedPins) {
    writeFileSync(PINS_FILE, `${JSON.stringify(doc, null, 2)}\n`);
    log(`sri updated in ${PINS_FILE.slice(ROOT.length + 1).replaceAll("\\", "/")}`);
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
);
