/**
 * `pnpm sdk:openapi` in a clean clone: the kons of the other repo are not installed,
 * and writing the snapshot must not delete their operations.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SNAPSHOT = join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json");
const dir = mkdtempSync(join(tmpdir(), "kitsuden-sdk-openapi-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(target: string, ...flags: string[]) {
  const r = spawnSync(
    "bun",
    ["--no-env-file", "scripts/sdk-openapi.ts", `--out=${target}`, ...flags],
    {
      cwd: join(ROOT, "apps/api"),
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
    }
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(readFileSync(target, "utf8")) as {
    paths: Record<string, Record<string, Record<string, { kon?: string }>>>;
    tags: { name: string }[];
  };
}

describe("sdk-openapi writes by merging", () => {
  const target = join(dir, "snapshot.json");
  const external = {
    operationId: "external.get-thing",
    summary: "Get a thing",
    "x-kitsuden-operation": { kon: "kon-external-test", id: "get-thing" },
  };

  it("keeps the operations and tags of kons not installed here, and refreshes the rest", () => {
    copyFileSync(SNAPSHOT, target);
    const before = JSON.parse(readFileSync(target, "utf8")) as Record<string, any>;
    before.paths["/external-test/thing"] = { get: external };
    before.tags.push({ name: "kon-external-test", description: "Not installed here" });
    const approvals = before.paths["/approvals/agents/{id}/mode"].put;
    approvals.summary = "stale";
    writeFileSync(target, JSON.stringify(before));

    const after = run(target);
    expect(after.paths["/external-test/thing"]?.get).toEqual(external);
    expect(after.tags.map((t) => t.name)).toContain("kon-external-test");
    expect(after.paths["/approvals/agents/{id}/mode"]?.put).not.toMatchObject({ summary: "stale" });
    const names = after.tags.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  }, 120_000);

  it("--prune is the explicit way to drop them", () => {
    const after = run(target, "--prune");
    expect(after.paths["/external-test/thing"]).toBeUndefined();
    expect(after.tags.map((t) => t.name)).not.toContain("kon-external-test");
  }, 120_000);
});
