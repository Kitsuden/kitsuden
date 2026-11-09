/**
 * `kitsuden kon add|remove|list` — with the compiled CLI, on a fake project and a
 * fake kons repo in a temporary folder.
 *
 * The fake project has the minimum the command needs: pnpm-workspace,
 * packages/kons (the install folder), a core module, the SDK constant
 * and an `apps/api/scripts/migrate.ts` that RECORDS its arguments: that way it is
 * checked that the command calls the normal runner with `--kon <id>` without
 * needing a database. The real one is tested by hand (clean
 * install + `kon add blog` against Postgres).
 *
 *   pnpm --filter @kitsuden/cli build && node --test tests/kon.test.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const CLI = resolve(import.meta.dirname, "..", "dist", "index.js");

let base, project, origin;

function write(route, content) {
  mkdirSync(join(route, ".."), { recursive: true });
  writeFileSync(route, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function kon(id, extra = {}, pkgExtra = {}) {
  const dir = join(origin, "kons", id);
  write(join(dir, "kon.json"), {
    id,
    name: id,
    version: "1.0.0",
    sdk: 1,
    maturity: "beta",
    ...extra,
  });
  write(join(dir, "package.json"), { name: `@kitsuden/${id}`, version: "1.2.3", ...pkgExtra });
  write(join(dir, "index.ts"), `export const kon = { id: "${id}" };\n`);
  write(join(dir, "migrations", "0001_init.sql"), `-- ${id}\n`);
  write(join(dir, "node_modules", "basura", "x.js"), "is not copied");
}

function cli(...args) {
  return spawnSync(process.execPath, [CLI, "kon", ...args, "--root", project], {
    encoding: "utf8",
    env: { ...process.env, KITSUDEN_API_URL: "", KITSUDEN_KONS_SOURCE: "" },
  });
}

function declaredAll() {
  const f = join(project, "kitsuden.kons.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).kons : {};
}

before(() => {
  assert.ok(existsSync(CLI), "build the CLI first: pnpm --filter @kitsuden/cli build");
  base = mkdtempSync(join(tmpdir(), "kitsuden-kon-cli-"));
  project = join(base, "proyecto");
  origin = join(base, "kitsuden-kons");

  write(join(project, "pnpm-workspace.yaml"), 'packages:\n  - "packages/kons/*"\n');
  write(join(project, "packages", "kons", "package.json"), {
    name: "@kitsuden/kons",
    private: true,
  });
  write(join(project, "packages", "core", "media", "kon.json"), {
    id: "kon-media",
    name: "Media",
    version: "1.0.0",
  });
  write(
    join(project, "packages", "shared", "src", "operations.ts"),
    "export const KONS_SDK_VERSION = 1;\n"
  );
  // Fake runner: records the arguments it was called with.
  write(
    join(project, "apps", "api", "scripts", "migrate.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("migrate-args.json", JSON.stringify(process.argv.slice(2)));\n`
  );

  kon("kon-blog", { dependencies: { kons: ["kon-media"] } });
  kon("kon-formulas");
  kon("kon-builder", { dependencies: { kons: ["kon-formulas"] } });
  kon("kon-cartas");
  kon("kon-mazos", {}, { peerDependencies: { "@kitsuden/kon-cartas": "workspace:*" } });
  kon("kon-futuro", { sdk: 99 });
});

after(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("kitsuden kon add", () => {
  it("copies the kon to packages/kons, without node_modules, and declares it", () => {
    const r = cli("add", "blog", "--from", origin, "--no-install", "--no-migrate");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const dir = join(project, "packages", "kons", "kon-blog");
    assert.ok(existsSync(join(dir, "kon.json")));
    assert.ok(existsSync(join(dir, "migrations", "0001_init.sql")));
    assert.ok(!existsSync(join(dir, "node_modules")), "node_modules is not copied");

    const e = declaredAll()["kon-blog"];
    assert.equal(e.mode, "copy");
    assert.equal(e.version, "1.2.3");
    assert.equal(e.sdk, 1);
    assert.equal(e.source, origin);
    assert.match(e.hash, /^[0-9a-f]{64}$/);
    // kon-media belongs to the core: it is not installed even if it is a dependency.
    assert.ok(!declaredAll()["kon-media"]);
  });

  it("brings in the dependencies (manifest and peer @kitsuden/kon-*)", () => {
    let r = cli("add", "builder", "--from", origin, "--no-install", "--no-migrate");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(declaredAll()["kon-formulas"], "kon-formulas via dependencies.kons");
    r = cli("add", "mazos", "--from", origin, "--no-install", "--no-migrate");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(declaredAll()["kon-cartas"], "kon-cartas via peerDependencies");
  });

  it("runs the normal migration runner with --kon <id>", () => {
    const r = cli("add", "blog", "--from", origin, "--no-install");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const args = JSON.parse(
      readFileSync(join(project, "apps", "api", "migrate-args.json"), "utf8")
    );
    assert.deepEqual(args, ["--kon", "kon-blog"]);
  });

  it("refuses to install a kon from a newer SDK, without touching anything", () => {
    const before = JSON.stringify(declaredAll());
    const r = cli("add", "futuro", "--from", origin, "--no-install", "--no-migrate");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs kon SDK v99 and this Kitsuden provides v1/);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-futuro")));
    assert.equal(JSON.stringify(declaredAll()), before);
  });

  it("does not overwrite local changes of an installed copy (unless --force)", () => {
    const file = join(project, "packages", "kons", "kon-blog", "index.ts");
    writeFileSync(file, "// manual change\n");
    let r = cli("add", "blog", "--from", origin, "--no-install", "--no-migrate");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /local changes/);
    assert.equal(readFileSync(file, "utf8"), "// manual change\n");

    r = cli("add", "blog", "--from", origin, "--no-install", "--no-migrate", "--force");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(readFileSync(file, "utf8"), /export const kon/);
  });

  it("--link does not copy: it declares the kon's path in place", () => {
    const r = cli("add", "formulas", "--from", origin, "--link", "--no-install", "--no-migrate");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const e = declaredAll()["kon-formulas"];
    assert.equal(e.mode, "link");
    assert.equal(resolve(project, e.path), join(origin, "kons", "kon-formulas"));
  });

  it("--enable leaves the activation seed", () => {
    const r = cli(
      "add",
      "cartas",
      "--from",
      origin,
      "--enable",
      "--no-install",
      "--no-migrate",
      "--force"
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-cartas"].enabled, true);
  });

  it("a core module is not installed", () => {
    const r = cli("add", "media", "--from", origin, "--no-install", "--no-migrate");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /part of the Kitsuden core/);
  });
});

describe("kitsuden kon list", () => {
  it("lists core and installed with their status (--json)", () => {
    const r = cli("list", "--json");
    assert.equal(r.status, 0, r.stderr);
    const { sdk, kons } = JSON.parse(r.stdout);
    assert.equal(sdk, 1);
    const byId = Object.fromEntries(kons.map((k) => [k.id, k]));
    assert.equal(byId["kon-media"].source, "core");
    assert.equal(byId["kon-blog"].status, "ok");
    assert.equal(byId["kon-formulas"].mode, "link");
  });

  it("flags a modified copy", () => {
    writeFileSync(join(project, "packages", "kons", "kon-mazos", "index.ts"), "// another\n");
    const { kons } = JSON.parse(cli("list", "--json").stdout);
    assert.equal(kons.find((k) => k.id === "kon-mazos").status, "modified");
  });

  it("--available shows what the origin offers with its maturity", () => {
    const r = cli("list", "--available", "--from", origin, "--json");
    assert.equal(r.status, 0, r.stderr);
    const kons = JSON.parse(r.stdout);
    assert.ok(kons.some((k) => k.id === "kon-blog" && k.maturity === "beta"));
  });
});

describe("kitsuden kon remove", () => {
  it("does not remove a kon that another depends on (unless --force)", () => {
    const r = cli("remove", "cartas", "--no-install");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /kon-mazos depends on kon-cartas/);
  });

  it("does not delete a copy with local changes", () => {
    const r = cli("remove", "mazos", "--no-install");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /local changes/);
  });

  it("removes the copy and the declaration", () => {
    const r = cli("remove", "blog", "--no-install");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-blog")));
    assert.ok(!declaredAll()["kon-blog"]);
  });

  it("a linked kon stops being declared without deleting its folder", () => {
    const r = cli("remove", "builder", "formulas", "--no-install");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(origin, "kons", "kon-formulas", "kon.json")));
    assert.ok(!declaredAll()["kon-formulas"]);
  });
});
