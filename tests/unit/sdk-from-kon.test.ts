/**
 * A kon's typed client without a running API: `generate.mjs --from-kon=<dir>`.
 *
 * The test kon is `tests/unit/fixtures/kon-notes` (not installed anywhere). Two ways
 * to the same client:
 *
 *   --from-kon   its `defineOperation` declarations, read statically (no server,
 *                no database);
 *   --from-url   what a running API serves at /api/docs/openapi.json. Here that
 *                document is built in-process by the same functions the route uses
 *                (fixtures/sdk-live-openapi.ts) and served by a throwaway HTTP server.
 *
 * Both must give the same operations and byte-identical generated files.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const KON = join(ROOT, "tests/unit/fixtures/kon-notes");
const SNAPSHOT = join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json");
const GENERATE = join(ROOT, "scripts/sdk/generate.mjs");
const dir = mkdtempSync(join(tmpdir(), "kitsuden-sdk-from-kon-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Doc = {
  openapi: string;
  info: { version: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, { "x-kitsuden-operation"?: { kon?: string } }>>;
  components: { schemas: Record<string, unknown> };
};
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Doc;

/** Nothing of a real environment reaches the child processes. */
function env() {
  const e = { ...process.env };
  for (const k of ["DATABASE_URL", "DATABASE_ADMIN_URL", "REDIS_URL", "VALKEY_URL"]) delete e[k];
  return e;
}

/** Async: the --from-url run needs this process's event loop to answer it. */
function node(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: env() });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdout.on("data", () => undefined);
    child.on("close", (status) => done({ status, stderr }));
  });
}

function files(base: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(base, p).replaceAll("\\", "/"), readFileSync(p, "utf8"));
    }
  };
  walk(base);
  return out;
}

const ops = (d: Doc) =>
  Object.entries(d.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, o]) => ({ key: `${method} ${path}`, o }))
  );

describe("generate.mjs --from-kon", () => {
  const staticSpec = join(dir, "static.json");
  const liveSpec = join(dir, "live-snapshot.json");
  const liveDoc = join(dir, "live-served.json");

  beforeAll(async () => {
    const r = await node([
      GENERATE,
      `--from-kon=${KON}`,
      `--spec=${staticSpec}`,
      `--out-ts=${join(dir, "ts-static")}`,
      `--out-py=${join(dir, "py-static")}`,
    ]);
    expect(r.status, r.stderr).toBe(0);
  }, 240_000);

  it("builds the kon's document from its declarations, without a server or database", () => {
    const d = read(staticSpec);
    expect(d.openapi).toBe("3.1.0");
    expect(d.tags.map((t) => t.name)).toEqual(["kon-notes"]);
    const all = ops(d);
    expect(all.length).toBeGreaterThan(0);
    for (const { o } of all) expect(o["x-kitsuden-operation"]?.kon).toBe("kon-notes");
    expect(Object.keys(d.paths).every((p) => p.startsWith("/notes/"))).toBe(true);
    expect(d.components.schemas.Problem).toBeDefined();

    expect(existsSync(join(dir, "ts-static/kons/notes.ts"))).toBe(true);
    expect(existsSync(join(dir, "ts-static/index.ts"))).toBe(true);
    expect(existsSync(join(dir, "py-static/kons/notes.py"))).toBe(true);
    expect(readFileSync(join(dir, "ts-static/index.ts"), "utf8")).toContain("readonly notes:");
  });

  it("gives the same operations and the same clients as --from-url against a running API", async () => {
    const built = spawnSync(
      "bun",
      ["--no-env-file", join(ROOT, "tests/unit/fixtures/sdk-live-openapi.ts"), KON, liveDoc],
      {
        cwd: join(ROOT, "apps/api"),
        encoding: "utf8",
        env: env(),
        shell: process.platform === "win32",
        timeout: 180_000,
      }
    );
    expect(built.status, built.stderr).toBe(0);

    const served = readFileSync(liveDoc, "utf8");
    const server = createServer((req, res) => {
      if (req.url === "/api/docs/openapi.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(served);
      } else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as AddressInfo;
    try {
      const r = await node([
        GENERATE,
        `--from-url=http://127.0.0.1:${port}`,
        `--spec=${liveSpec}`,
        `--out-ts=${join(dir, "ts-live")}`,
        `--out-py=${join(dir, "py-live")}`,
      ]);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      server.close();
    }

    const a = read(staticSpec);
    const b = read(liveSpec);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(a.info.version).toBe(b.info.version);
    expect(a.tags).toEqual(b.tags);
    expect(Object.fromEntries(ops(a).map((x) => [x.key, x.o]))).toEqual(
      Object.fromEntries(ops(b).map((x) => [x.key, x.o]))
    );
    expect(a.components.schemas.Problem).toEqual(b.components.schemas.Problem);

    for (const lang of ["ts", "py"]) {
      const s = files(join(dir, `${lang}-static`));
      const l = files(join(dir, `${lang}-live`));
      expect([...s.keys()].sort()).toEqual([...l.keys()].sort());
      for (const [k, text] of s) expect(text, `${lang}/${k}`).toBe(l.get(k));
    }
  }, 300_000);

  it("merges into an existing snapshot: the other kons stay", async () => {
    const target = join(dir, "merged.json");
    copyFileSync(SNAPSHOT, target);
    const before = read(target);
    const r = await node([
      GENERATE,
      `--from-kon=${KON}`,
      `--spec=${target}`,
      `--out-ts=${join(dir, "ts-merged")}`,
      `--out-py=${join(dir, "py-merged")}`,
    ]);
    expect(r.status, r.stderr).toBe(0);
    const after = read(target);
    const konOf = (o: { "x-kitsuden-operation"?: { kon?: string } }) =>
      o["x-kitsuden-operation"]?.kon;
    const others = (d: Doc) => ops(d).filter((x) => konOf(x.o) !== "kon-notes");
    expect(others(after)).toEqual(others(before));
    expect(ops(after).filter((x) => konOf(x.o) === "kon-notes").length).toBe(
      ops(read(staticSpec)).length
    );
    expect(after.tags.map((t) => t.name)).toContain("kon-notes");
    expect(existsSync(join(dir, "ts-merged/kons/notes.ts"))).toBe(true);
    expect(existsSync(join(dir, "ts-merged/kons/datasets.ts"))).toBe(true);
  }, 240_000);

  it("refuses a folder that is not a kon", async () => {
    const r = await node([
      GENERATE,
      `--from-kon=${join(ROOT, "tests/unit")}`,
      `--spec=${join(dir, "nope.json")}`,
      `--out-ts=${join(dir, "ts-nope")}`,
      `--out-py=${join(dir, "py-nope")}`,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no kon\.json/);
    expect(existsSync(join(dir, "ts-nope"))).toBe(false);
  }, 120_000);
});
