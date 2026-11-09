/**
 * `kitsuden new` — for real: runs the compiled CLI, installs and builds the
 * generated project in a temporary folder, WITHOUT an API.
 *
 *   pnpm --filter @kitsuden/cli build && node --test tests/new.test.mjs
 *
 * KITSUDEN_CLI_SKIP_INSTALL=1 skips `pnpm install` + `pnpm build` (they need
 * a network to download Astro); the rest of the checks are done the same.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const CLI = resolve(import.meta.dirname, "..", "dist", "index.js");
const STARTER = resolve(import.meta.dirname, "..", "..", "starters", "kitsuden-starter-basic");
// A port where nobody is listening: if the build called the API, it would fail.
const API_UNREACHABLE = "http://127.0.0.1:9";

let tmp;
let project;

function cli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

before(() => {
  assert.ok(existsSync(CLI), "build the CLI first: pnpm --filter @kitsuden/cli build");
  tmp = mkdtempSync(join(tmpdir(), "kitsuden-new-"));
  project = join(tmp, "mi-web");
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("kitsuden new", () => {
  it("creates the project without asking when there is no TTY", () => {
    const r = cli(
      ["new", "mi-web", "--api-url", API_UNREACHABLE, "--site-url", "https://example.org"],
      tmp
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Created/);
    assert.match(r.stdout, /Next steps/);
  });

  it("does not copy node_modules, dist, .astro or the starter's .env", () => {
    for (const outside of ["node_modules", "dist", ".astro"]) {
      assert.equal(existsSync(join(project, outside)), false, `${outside} was copied`);
    }
    assert.ok(existsSync(join(project, ".env.example")));
    assert.match(readFileSync(join(project, ".gitignore"), "utf8"), /^\.env$/m);
    assert.ok(existsSync(join(project, "src", "pages", "index.astro")));
    assert.ok(existsSync(join(project, "astro.config.mjs")));
  });

  it("renames the package and removes what belonged to the monorepo", () => {
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    assert.equal(pkg.name, "mi-web");
    assert.equal(pkg.repository, undefined);
    assert.equal(pkg.author, undefined);
    const original = JSON.parse(readFileSync(join(STARTER, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies, original.dependencies);
  });

  it("writes .env from .env.example with the requested API and URL", () => {
    const env = readFileSync(join(project, ".env"), "utf8");
    assert.match(
      env,
      new RegExp(`^KITSUDEN_API_URL=${API_UNREACHABLE.replace(/[.]/g, "\\.")}$`, "m")
    );
    assert.match(env, /^SITE_URL=https:\/\/example\.org$/m);
    assert.match(env, /^SITE_NAME=mi-web$/m);
    // The site key is secret: it stays commented out.
    assert.match(env, /^# KITSUDEN_SITE_KEY=$/m);
  });

  it("does not overwrite a folder that already has something in it", () => {
    const r = cli(["new", "mi-web", "--api-url", API_UNREACHABLE], tmp);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists and is not empty/);
  });

  it("rejects an API URL that is not http(s)", () => {
    const r = cli(["new", "otra", "--api-url", "ftp://x"], tmp);
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(tmp, "otra")), false);
  });

  it("--api explains how to get the API without generating anything", () => {
    const r = cli(["new", "--api"], tmp);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no published Kitsuden API images/);
    assert.match(r.stdout, /docs\/install\/server\.md/);
  });

  it(
    "pnpm install + pnpm build work without an API",
    { skip: process.env.KITSUDEN_CLI_SKIP_INSTALL === "1", timeout: 600_000 },
    () => {
      const options = { cwd: project, encoding: "utf8", shell: process.platform === "win32" };
      const i = spawnSync("pnpm", ["install"], options);
      assert.equal(i.status, 0, i.stderr + i.stdout);
      const b = spawnSync("pnpm", ["build"], options);
      assert.equal(b.status, 0, b.stderr + b.stdout);
      assert.ok(existsSync(join(project, "dist", "server", "entry.mjs")));
    }
  );
});
