#!/usr/bin/env node
/**
 * Kitsuden's rules for its OpenAPI contract (Spectral)
 * ============================================================================
 *
 * Lints an OpenAPI document with `scripts/api-contract/spectral.yaml`: the
 * generic OpenAPI rules plus Kitsuden's own (operation ids, fine scopes,
 * problem+json errors, Idempotency-Key, pagination…).
 *
 *   node scripts/api-contract/lint.mjs                        # the committed SDK snapshot
 *   node scripts/api-contract/lint.mjs --spec=<file>          # another document
 *   node scripts/api-contract/lint.mjs --spec=<URL>           # e.g. http://localhost:3001/api/docs/<kon>/openapi.json
 *   node scripts/api-contract/lint.mjs --summary=<file>       # append a Markdown report ($GITHUB_STEP_SUMMARY)
 *   node scripts/api-contract/lint.mjs --github               # annotations in a GitHub job
 *
 * Exit code 1 when there is at least one `error`; warnings are listed and counted.
 *
 * Spectral is not a dependency: it runs with npx at a PINNED version (like
 * Schemathesis with uvx). A kon author lints their kon against the same rules
 * as the core.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RULESET = join(ROOT, "scripts/api-contract/spectral.yaml");
export const SPECTRAL = "@stoplight/spectral-cli@6.17.1";

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n) => args.includes(`--${n}`);
const SEVERITY = ["error", "warn", "info", "hint"];

async function main() {
  const tmp = [];
  let spec = arg("spec") ?? "packages/sdk/openapi/kitsuden.openapi.json";
  const label = spec;
  if (/^https?:\/\//.test(spec)) {
    const res = await fetch(spec, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${spec} → ${res.status}`);
    const file = join(tmpdir(), `kitsuden-lint-${process.pid}.json`);
    writeFileSync(file, await res.text());
    tmp.push(file);
    spec = file;
  } else {
    spec = resolve(ROOT, spec);
    if (!existsSync(spec)) throw new Error(`${spec} does not exist`);
  }
  const out = join(tmpdir(), `kitsuden-lint-result-${process.pid}.json`);
  tmp.push(out);

  try {
    const r = spawnSync(
      "npx",
      [
        "--yes",
        SPECTRAL,
        "lint",
        spec,
        "--ruleset",
        RULESET,
        "--format",
        "json",
        "--output",
        out,
        "--fail-severity",
        "error",
        "--quiet",
      ].map((a) => (process.platform === "win32" && /\s/.test(a) ? `"${a}"` : a)),
      { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" }
    );
    if (r.error) throw new Error(`could not run npx: ${r.error.message}`);
    if (!existsSync(out)) {
      throw new Error(`Spectral produced no report (exit ${r.status}):\n${r.stderr || r.stdout}`);
    }
    const results = JSON.parse(readFileSync(out, "utf8") || "[]");
    return report(results, label);
  } finally {
    for (const f of tmp) rmSync(f, { force: true });
  }
}

/** Where a result points, readable: `GET /admin/x responses.403` or `paths./x`. */
function where(path) {
  if (path[0] === "paths" && path.length >= 3) {
    return `${String(path[2]).toUpperCase()} ${path[1]}${path.length > 3 ? ` ${path.slice(3).join(".")}` : ""}`;
  }
  return path.join(".");
}

function report(results, label) {
  const byRule = new Map();
  for (const r of results) {
    const key = r.code;
    if (!byRule.has(key)) byRule.set(key, { severity: r.severity, items: [] });
    byRule.get(key).items.push(r);
  }
  const errors = results.filter((r) => r.severity === 0).length;
  const warnings = results.filter((r) => r.severity === 1).length;
  const rules = [...byRule.entries()].sort(
    (a, b) => a[1].severity - b[1].severity || b[1].items.length - a[1].items.length
  );

  const lines = [];
  for (const [code, { severity, items }] of rules) {
    lines.push(`${SEVERITY[severity].padEnd(5)} ${code} (${items.length})`);
    const shown = severity === 0 ? items : items.slice(0, 5);
    for (const r of shown) lines.push(`        ${where(r.path)}: ${r.message}`);
    if (shown.length < items.length) lines.push(`        … ${items.length - shown.length} more`);
  }
  process.stdout.write(
    `${lines.join("\n")}${lines.length ? "\n" : ""}[api-lint] ${label}: ${errors} error(s), ${warnings} warning(s)\n`
  );

  if (flag("github")) {
    for (const r of results.filter((x) => x.severity <= 1)) {
      const level = r.severity === 0 ? "error" : "warning";
      const file = relative(ROOT, resolve(ROOT, r.source ?? label)).replaceAll("\\", "/");
      const line = (r.range?.start?.line ?? 0) + 1;
      const msg = `${r.code}: ${where(r.path)}: ${r.message}`.replace(/\r?\n/g, " ");
      process.stdout.write(`::${level} file=${file},line=${line}::${msg}\n`);
    }
  }

  if (arg("summary")) {
    const rows = rules
      .map(
        ([code, { severity, items }]) => `| ${SEVERITY[severity]} | \`${code}\` | ${items.length} |`
      )
      .join("\n");
    appendFileSync(
      arg("summary"),
      `## API contract: Spectral rules\n\n${errors} error(s), ${warnings} warning(s) in \`${label}\`.\n\n` +
        (rows
          ? `| severity | rule | count |\n|---|---|---|\n${rows}\n`
          : "_Nothing to report._\n") +
        `\n_${SPECTRAL}, ruleset scripts/api-contract/spectral.yaml_\n`
    );
  }
  return errors > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[api-lint] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
);
