#!/usr/bin/env node
/**
 * Security scanners: secrets, dependencies, infrastructure as code, images
 * ============================================================================
 *
 * One script for CI and for a laptop, so both run the same versions with the same
 * rules. Docs: docs/security-scanning.md.
 *
 *   node scripts/security/scan.mjs                     secrets, deps, iac
 *   node scripts/security/scan.mjs --only=deps         one or more (comma-separated)
 *   node scripts/security/scan.mjs --image=kitsuden-api:ci   scan a built image
 *   node scripts/security/scan.mjs --root=../kitsuden-kons   scan another repository
 *
 * | check   | tool                         | fails on                                   |
 * | ------- | ---------------------------- | ------------------------------------------ |
 * | secrets | gitleaks (git history + tree) | any finding not in .gitleaksignore         |
 * | deps    | OSV-Scanner (pnpm-lock.yaml) | a HIGH or CRITICAL advisory (CVSS >= 7)    |
 * | iac     | Checkov (Dockerfiles, Actions)| any failed check not skipped in .checkov.yaml |
 * | image   | Trivy                        | a fixable HIGH or CRITICAL vulnerability   |
 *
 * Exceptions live in the files above, each with its reason; OSV ones in
 * osv-scanner.toml with an expiry date. Reports (SARIF and JSON) go to `.security/`
 * (gitignored), where the binaries are cached too.
 *
 * Binaries are downloaded from each project's GitHub release and checked against the
 * SHA-256 pinned below before they run. Checkov comes from PyPI through `uvx`, at
 * a pinned version. Bump a version only together with its checksums.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository to scan: this one, or another one with `--root=<dir>` (the kons
// repository runs this script from its checkout of the core). Its exception files
// (.gitleaks.toml, osv-scanner.toml, .checkov.yaml, .trivyignore.yaml) are read
// from that root, and the reports land in its `.security/`.
let ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let OUT = join(ROOT, ".security");
let BIN = join(OUT, "bin");

function setRoot(dir) {
  ROOT = resolve(dir);
  OUT = join(ROOT, ".security");
  BIN = join(OUT, "bin");
}

export const CHECKOV = "checkov==3.4.3";

/** Pinned releases: version, then per platform the asset and its SHA-256. */
export const TOOLS = {
  gitleaks: {
    version: "8.30.1",
    url: (v, a) => `https://github.com/gitleaks/gitleaks/releases/download/v${v}/${a}`,
    assets: {
      "linux-x64": [
        "gitleaks_8.30.1_linux_x64.tar.gz",
        "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
      ],
      "darwin-arm64": [
        "gitleaks_8.30.1_darwin_arm64.tar.gz",
        "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
      ],
      "win32-x64": [
        "gitleaks_8.30.1_windows_x64.zip",
        "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
      ],
    },
  },
  "osv-scanner": {
    version: "2.7.1",
    url: (v, a) => `https://github.com/google/osv-scanner/releases/download/v${v}/${a}`,
    assets: {
      "linux-x64": [
        "osv-scanner_linux_amd64",
        "fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8",
      ],
      "darwin-arm64": [
        "osv-scanner_darwin_arm64",
        "b22c02877a811c8f78956e8643efa554932b7378f590d13f8e97d4e9448a29f3",
      ],
      "win32-x64": [
        "osv-scanner_windows_amd64.exe",
        "7121dcf420aefbbf89a7f0050c4d3094e079ff93afd334dfc96f16b02ec85800",
      ],
    },
  },
  trivy: {
    version: "0.76.2",
    url: (v, a) => `https://github.com/aquasecurity/trivy/releases/download/v${v}/${a}`,
    assets: {
      "linux-x64": [
        "trivy_0.76.2_Linux-64bit.tar.gz",
        "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf",
      ],
      "darwin-arm64": [
        "trivy_0.76.2_macOS-ARM64.tar.gz",
        "ae7ea358326960406b703c77b2ac490190797d80b306b5b50c2a27221da0a5b8",
      ],
      "win32-x64": [
        "trivy_0.76.2_windows-64bit.zip",
        "691f737a7e5566a673c3a74dab9160552ec32101e953b659e5c77443d16dddb6",
      ],
    },
  },
};

const EXE = process.platform === "win32" ? ".exe" : "";

function run(cmd, args, { capture = false } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    let out = "";
    if (capture) child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code: code ?? 1, out }));
    child.on("error", (err) => done({ code: 127, out: String(err) }));
  });
}

/** Downloads a pinned tool once, checks its SHA-256, returns the executable's path. */
export async function tool(name) {
  const spec = TOOLS[name];
  const platform = `${process.platform}-${process.arch}`;
  const asset = spec.assets[platform];
  if (!asset) throw new Error(`${name}: no pinned build for ${platform}`);
  const [file, sha256] = asset;
  const dir = join(BIN, `${name}-${spec.version}`);
  const exe = join(dir, `${name}${EXE}`);
  if (existsSync(exe)) return exe;

  const res = await fetch(spec.url(spec.version, file));
  if (!res.ok) throw new Error(`${name}: download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`${name}: SHA-256 mismatch for ${file} (got ${got})`);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, file);
  writeFileSync(archive, bytes);
  if (/\.(tar\.gz|zip)$/.test(file)) {
    // Windows' own tar (bsdtar) also reads zip files
    const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
    const { code } = await run(tar, ["-xf", archive, "-C", dir]);
    if (code !== 0) throw new Error(`${name}: could not extract ${file}`);
    rmSync(archive);
  } else {
    writeFileSync(exe, bytes);
    rmSync(archive);
  }
  if (process.platform !== "win32") await run("chmod", ["+x", exe]);
  return exe;
}

// ── secrets ─────────────────────────────────────────────────────────────────
async function secrets() {
  const gitleaks = await tool("gitleaks");
  // History first (a secret deleted in a later commit is still public), then the
  // working tree, which also covers files not committed yet.
  const config = ["--config", join(ROOT, ".gitleaks.toml")];
  const history = await run(gitleaks, [
    "git",
    ...config,
    // The checked-out branch only: a shared clone may hold other people's branches
    "--log-opts=HEAD",
    "--redact",
    "--no-banner",
    "--report-format=sarif",
    `--report-path=${join(OUT, "gitleaks-history.sarif")}`,
    ".",
  ]);
  const tree = await run(gitleaks, [
    "dir",
    ...config,
    "--redact",
    "--no-banner",
    "--report-format=sarif",
    `--report-path=${join(OUT, "gitleaks-tree.sarif")}`,
    ".",
  ]);
  return history.code === 0 && tree.code === 0;
}

// ── dependencies ────────────────────────────────────────────────────────────
/** Highest CVSS score in an OSV-Scanner group, 0 when the advisory has none. */
export function groupScore(group) {
  const n = Number.parseFloat(group?.max_severity ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** Splits OSV-Scanner's JSON into blocking (CVSS >= 7) and reported findings. */
export function triageOsv(report) {
  const blocking = [];
  const other = [];
  for (const result of report?.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const group of pkg.groups ?? []) {
        const finding = {
          pkg: `${pkg.package?.name}@${pkg.package?.version}`,
          ids: group.aliases?.length ? group.aliases : group.ids,
          score: groupScore(group),
        };
        (finding.score >= 7 ? blocking : other).push(finding);
      }
    }
  }
  return { blocking, other };
}

async function deps() {
  const osv = await tool("osv-scanner");
  const config = ["--config", join(ROOT, "osv-scanner.toml")];
  await run(osv, [
    "scan",
    "source",
    ...config,
    "--format=sarif",
    `--output-file=${join(OUT, "osv.sarif")}`,
    "--lockfile",
    "pnpm-lock.yaml",
  ]);
  const { code, out } = await run(
    osv,
    ["scan", "source", ...config, "--format=json", "--lockfile", "pnpm-lock.yaml"],
    { capture: true }
  );
  // 0 no findings, 1 findings; anything else is the scanner failing
  if (code !== 0 && code !== 1) {
    console.error(`osv-scanner failed (exit ${code})`);
    return false;
  }
  writeFileSync(join(OUT, "osv.json"), out);
  const { blocking, other } = triageOsv(JSON.parse(out || "{}"));
  for (const f of other)
    console.log(`  report  ${f.pkg}  ${f.ids.join(", ")}  (${f.score || "?"})`);
  for (const f of blocking) console.log(`  BLOCK   ${f.pkg}  ${f.ids.join(", ")}  (${f.score})`);
  console.log(`deps: ${blocking.length} high or critical, ${other.length} lower`);
  return blocking.length === 0;
}

// ── infrastructure as code ──────────────────────────────────────────────────
async function iac() {
  const { code } = await run("uvx", [
    "--from",
    CHECKOV,
    "checkov",
    "--config-file",
    join(ROOT, ".checkov.yaml"),
    "--directory",
    ".",
    "--output",
    "cli",
    "--output",
    "sarif",
    "--output-file-path",
    `console,${join(OUT, "checkov.sarif")}`,
  ]);
  return code === 0;
}

// ── a built image ───────────────────────────────────────────────────────────
async function image(ref) {
  const trivy = await tool("trivy");
  const common = ["image", "--scanners", "vuln", "--ignorefile", join(ROOT, ".trivyignore.yaml")];
  await run(trivy, [
    ...common,
    "--format",
    "sarif",
    "--output",
    join(OUT, `trivy-${ref.replace(/[^\w.-]+/g, "_")}.sarif`),
    ref,
  ]);
  const { code } = await run(trivy, [
    ...common,
    "--severity",
    "HIGH,CRITICAL",
    "--ignore-unfixed",
    "--exit-code",
    "1",
    ref,
  ]);
  return code === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const root = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
  if (root) setRoot(root);
  const only = argv.find((a) => a.startsWith("--only="))?.slice(7);
  const images = argv.filter((a) => a.startsWith("--image=")).map((a) => a.slice(8));
  const checks = only ? only.split(",") : images.length ? [] : ["secrets", "deps", "iac"];
  mkdirSync(BIN, { recursive: true });

  const steps = { secrets, deps, iac };
  const failed = [];
  for (const name of checks) {
    if (!steps[name]) throw new Error(`unknown check: ${name} (secrets, deps, iac)`);
    console.log(`\n── ${name} ──`);
    if (!(await steps[name]())) failed.push(name);
  }
  for (const ref of images) {
    console.log(`\n── image ${ref} ──`);
    if (!(await image(ref))) failed.push(`image ${ref}`);
  }
  console.log(failed.length ? `\nFailed: ${failed.join(", ")}` : "\nAll security checks passed.");
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(2);
  });
}
