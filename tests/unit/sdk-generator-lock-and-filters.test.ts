/**
 * `scripts/sdk/generate.mjs`: filters by kon and path, and `kitsuden-lock.json`.
 *
 * Runs the generator on a copy of the committed snapshot into temporary folders:
 *
 *   - `--include-kon` / `--exclude-kon` / `--include-path` / `--exclude-path`
 *     give a smaller client, and a typo in a kon name is an error, not a
 *     silently smaller client;
 *   - the filters are kept in the lock: a run without flags regenerates the
 *     same filtered client, and `--check` passes on it; `--reset-filters` forgets them;
 *   - `--check` says WHY a client is stale (contract, generator or filters);
 *   - the lock depends on the contract's content, not on where or how the
 *     document was written.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SNAPSHOT = join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json");
const GENERATE = join(ROOT, "scripts/sdk/generate.mjs");
const dir = mkdtempSync(join(tmpdir(), "kitsuden-sdk-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const spec = join(dir, "spec.json");
writeFileSync(spec, JSON.stringify(snapshot, null, 2));

function gen(out: string, ...extra: string[]) {
  return spawnSync(
    process.execPath,
    [
      GENERATE,
      `--spec=${spec}`,
      `--out-ts=${join(dir, out, "ts")}`,
      `--out-py=${join(dir, out, "py")}`,
      ...extra,
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
}

const konFiles = (out: string) =>
  readdirSync(join(dir, out, "ts", "kons"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
const lockOf = (out: string, lang = "ts") =>
  JSON.parse(readFileSync(join(dir, out, lang, "kitsuden-lock.json"), "utf8"));

describe("generate.mjs filters", () => {
  it("--include-kon keeps only those kons, in both languages and in the index", () => {
    const r = gen("inc", "--include-kon=datasets,kon-media");
    expect(r.status, r.stderr).toBe(0);
    expect(konFiles("inc")).toEqual(["datasets", "media"]);
    expect(existsSync(join(dir, "inc/py/kons/datasets.py"))).toBe(true);
    expect(existsSync(join(dir, "inc/py/kons/agents.py"))).toBe(false);
    const index = readFileSync(join(dir, "inc/ts/index.ts"), "utf8");
    expect(index).toContain("readonly datasets:");
    expect(index).not.toContain("readonly agents:");
    const lock = lockOf("inc");
    expect(lock.filters.includeKons).toEqual(["datasets", "media"]);
    expect(Object.keys(lock.kons)).toEqual(["kon-datasets", "kon-media"]);
    expect(lockOf("inc", "py")).toEqual(lock);
  });

  it("keeps the filters in the lock: a run without flags and --check give the same client", () => {
    const before = readFileSync(join(dir, "inc/ts/index.ts"), "utf8");
    const again = gen("inc");
    expect(again.status, again.stderr).toBe(0);
    expect(konFiles("inc")).toEqual(["datasets", "media"]);
    expect(readFileSync(join(dir, "inc/ts/index.ts"), "utf8")).toBe(before);
    const check = gen("inc", "--check");
    expect(check.status, check.stderr).toBe(0);
    expect(check.stderr).toContain("filters");
  });

  it("--reset-filters goes back to every kon", () => {
    const r = gen("inc", "--reset-filters");
    expect(r.status, r.stderr).toBe(0);
    expect(konFiles("inc").length).toBe(Object.keys(lockOf("inc").kons).length);
    expect(konFiles("inc").length).toBeGreaterThan(10);
    expect(lockOf("inc").filters.includeKons).toEqual([]);
  });

  it("path globs: `**`, `*` and a #METHOD", () => {
    const r = gen(
      "paths",
      "--include-path=/datasets/**#GET",
      "--exclude-path=/datasets/*/entries/**"
    );
    expect(r.status, r.stderr).toBe(0);
    expect(konFiles("paths")).toEqual(["datasets"]);
    const lock = lockOf("paths");
    const expected = Object.entries(snapshot.paths as Record<string, Record<string, unknown>>)
      .filter(([p]) => p.startsWith("/datasets/") && !/^\/datasets\/[^/]*\/entries\//.test(p))
      .filter(([, item]) => item.get).length;
    expect(lock.operations).toBe(expected);
    const ts = readFileSync(join(dir, "paths/ts/kons/datasets.ts"), "utf8");
    expect(ts).not.toMatch(/method: "POST"/);
  });

  it("a kon name that is not in the document is an error, not a smaller client", () => {
    const r = gen("typo", "--include-kon=datsets");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/kon 'datsets' is not in the document/);
  });
});

describe("kitsuden-lock.json", () => {
  it("says why the client is stale when the contract changes", () => {
    const full = gen("why");
    expect(full.status, full.stderr).toBe(0);
    const changed = structuredClone(snapshot);
    const first = Object.values(
      changed.paths as Record<string, Record<string, { summary?: string }>>
    )[0];
    Object.values(first)[0].summary = "Changed by the test";
    const other = join(dir, "changed.json");
    writeFileSync(other, JSON.stringify(changed));
    const r = spawnSync(
      process.execPath,
      [
        GENERATE,
        `--spec=${other}`,
        `--out-ts=${join(dir, "why/ts")}`,
        `--out-py=${join(dir, "why/py")}`,
        "--check",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/why: the contract changed .*same kons and operation counts/);
    expect(r.stderr).not.toMatch(/why: the generator/);
  });

  it("does not depend on where or how the document was written", () => {
    const minified = join(dir, "min.json");
    writeFileSync(minified, JSON.stringify(snapshot));
    const a = gen("where-a");
    const b = spawnSync(
      process.execPath,
      [
        GENERATE,
        `--spec=${minified}`,
        `--out-ts=${join(dir, "where-b/ts")}`,
        `--out-py=${join(dir, "where-b/py")}`,
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);
    expect(lockOf("where-b")).toEqual(lockOf("where-a"));
  });

  it("the committed clients carry the lock of the committed snapshot", () => {
    const committed = JSON.parse(
      readFileSync(join(ROOT, "packages/sdk/src/generated/kitsuden-lock.json"), "utf8")
    );
    const fresh = gen("committed");
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(lockOf("committed")).toEqual(committed);
  });
});
