/**
 * Install safety of `kitsuden kon add`, with the compiled CLI on a throwaway
 * project: kon ids, hidden dependencies, lifecycle scripts, and unsigned git
 * sources (confirmation, pinned commit, no scripts in pnpm install).
 *
 *   pnpm --filter @kitsuden/cli build && node --test tests/kon-security.test.mjs
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const DIST = resolve(import.meta.dirname, "..", "dist");
const CLI = join(DIST, "index.js");
const m = (p) => import(new URL(`file:///${join(DIST, p).replace(/\\/g, "/")}`).href);

let base, project, origin, repo, fakeBin;

function write(route, content) {
  mkdirSync(join(route, ".."), { recursive: true });
  writeFileSync(route, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function kon(root, id, extra = {}, pkgExtra = {}) {
  const dir = join(root, "kons", id);
  write(join(dir, "kon.json"), { id, name: id, version: "1.0.0", sdk: 1, ...extra });
  write(join(dir, "package.json"), { name: `@kitsuden/${id}`, version: "1.0.0", ...pkgExtra });
  write(join(dir, "index.ts"), `export const kon = { id: "${id}" };\n`);
  return dir;
}

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, "kon", ...args, "--root", project], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, KITSUDEN_API_URL: "", KITSUDEN_KONS_SOURCE: "", ...env },
  });
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function declaredAll() {
  const f = join(project, "kitsuden.kons.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).kons : {};
}

before(() => {
  assert.ok(existsSync(CLI), "build the CLI first: pnpm --filter @kitsuden/cli build");
  base = mkdtempSync(join(tmpdir(), "kitsuden-kon-security-"));
  project = join(base, "proyecto");
  origin = join(base, "origin");
  repo = join(base, "kons-repo.git");

  write(join(project, "pnpm-workspace.yaml"), 'packages:\n  - "packages/kons/*"\n');
  write(join(project, "packages", "kons", "package.json"), {
    name: "@kitsuden/kons",
    private: true,
  });
  write(
    join(project, "packages", "shared", "src", "operations.ts"),
    "export const KONS_SDK_VERSION = 1;\n"
  );

  // A pnpm that writes down its arguments, as a real program and as the .cmd shim
  // that Windows installs: the shim is the path that needs cmd.exe.
  fakeBin = join(base, "bin");
  write(
    join(fakeBin, "pnpm.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PNPM_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`
  );
  write(join(fakeBin, "pnpm.cmd"), `@echo off\r\nnode "%~dp0pnpm.mjs" %*\r\n`);
  write(join(fakeBin, "pnpm"), `#!/bin/sh\nexec node "$(dirname "$0")/pnpm.mjs" "$@"\n`);
  spawnSync("chmod", ["+x", join(fakeBin, "pnpm")]);
});

after(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("kon ids", () => {
  it("refuses an id with shell or path characters, on the command line", () => {
    for (const id of ["kon-a/p&calc&", "../../etc", "kon-a&calc", "kon-A", "kon-a b"]) {
      const r = cli(["add", id, "--from", origin, "--no-install", "--no-migrate"]);
      assert.notEqual(r.status, 0, id);
      assert.match(r.stderr, /Invalid kon id/, id);
    }
    assert.deepEqual(declaredAll(), {});
  });

  it("refuses a dependency whose id is malformed, and installs nothing", () => {
    kon(origin, "kon-hidden", { dependencies: { kons: [], required: ["kon-a/p&calc&"] } });
    mkdirSync(join(origin, "kons", "kon-hidden", "p&calc&"), { recursive: true });
    const r = cli(["add", "hidden", "--from", origin, "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid kon id/);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-hidden")));
    assert.deepEqual(declaredAll(), {});
  });

  it("refuses a @kitsuden/kon-* package name that is not a valid id", () => {
    kon(origin, "kon-peer", {}, { peerDependencies: { "@kitsuden/kon-a&calc": "*" } });
    const r = cli(["add", "peer", "--from", origin, "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid kon id/);
  });

  it("refuses a folder whose manifest declares another kon", () => {
    kon(origin, "kon-disfraz", { id: "kon-otro" });
    const r = cli(["add", "disfraz", "--from", origin, "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /declares a different kon/);
  });

  it("kitsuden.kons.json with a bad id is an error, not a path", () => {
    const f = join(project, "kitsuden.kons.json");
    writeFileSync(f, JSON.stringify({ kons: { "kon-../../x": {} } }));
    const r = cli(["list"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid kon id/);
    rmSync(f);
  });
});

describe("hidden dependencies (registry)", () => {
  const PUBLISHABLE = {
    id: "kon-demo",
    name: "Demo",
    description: "x",
    version: "1.0.0",
    sdk: 1,
    kitsuden: ">=0.9.0",
    license: "MIT",
    author: "T",
    permissions: { scopes: [], hosts: [], sensitive: [] },
  };

  it("a published manifest cannot declare dependencies.required outside dependencies.kons", async () => {
    const { validateManifest } = await m("registry/manifest.js");
    const o = { forPublish: true };
    assert.match(
      validateManifest(
        { ...PUBLISHABLE, dependencies: { kons: [], required: ["kon-oculto"] } },
        o
      ).errors.join(),
      /dependencies\.required: kon-oculto must also be listed/
    );
    assert.match(
      validateManifest(
        { ...PUBLISHABLE, dependencies: { required: ["kon-a/p&calc&"] } },
        o
      ).errors.join(),
      /invalid id/
    );
    assert.ok(
      validateManifest(
        { ...PUBLISHABLE, dependencies: { kons: ["kon-a"], required: ["kon-a"] } },
        o
      ).ok
    );
    assert.ok(
      validateManifest({ ...PUBLISHABLE, dependencies: { required: ["kon-media"] } }, o).ok,
      "core modules are satisfied"
    );
  });

  it("a published manifest cannot pull a kon through package.json alone", async () => {
    const { validateManifest } = await m("registry/manifest.js");
    const r = validateManifest(PUBLISHABLE, {
      forPublish: true,
      package: { version: "1.0.0", dependencies: { "@kitsuden/kon-oculto": "*" } },
    });
    assert.match(r.errors.join(), /package\.json dependencies: kon-oculto must also be listed/);
  });

  it("the installer refuses anything outside the signed plan", async () => {
    const { installKons } = await m("kons/installation.js");
    const staging = join(base, "staging");
    kon(staging, "kon-firmado", { dependencies: { kons: [], required: ["kon-oculto"] } });
    kon(staging, "kon-oculto");
    assert.throws(
      () =>
        installKons(["kon-firmado"], {
          root: project,
          source: staging,
          declaredOrigin: "registry:test",
          coreSdk: 1,
          allowedPlan: new Set(["kon-firmado"]),
        }),
      /not in the signed plan/
    );
    assert.deepEqual(declaredAll(), {});
  });
});

describe("lifecycle scripts and links", () => {
  it("refuses a kon with an install script, whatever the source", () => {
    kon(origin, "kon-script", {}, { scripts: { build: "tsc", postinstall: "node evil.js" } });
    const r = cli(["add", "script", "--from", origin, "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /lifecycle scripts are not allowed.*postinstall/);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-script")));
  });

  it("refuses a kon with a symbolic link", (t) => {
    const dir = kon(origin, "kon-enlace");
    try {
      symlinkSync(join(base, "fuera"), join(dir, "enlace"));
    } catch {
      return t.skip("this user cannot create symlinks");
    }
    const r = cli(["add", "enlace", "--from", origin, "--no-install", "--no-migrate"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /symbolic links are not allowed/);
  });

  it("runs pnpm install with --ignore-scripts, through the .cmd shim on Windows", () => {
    kon(origin, "kon-limpio");
    const file = join(base, "pnpm-args.json");
    const r = cli(["add", "limpio", "--from", origin, "--no-migrate"], {
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
      Path: `${fakeBin}${delimiter}${process.env.Path ?? process.env.PATH}`,
      PNPM_ARGS_FILE: file,
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ["install", "--ignore-scripts"]);
    assert.equal(cli(["remove", "limpio", "--no-install"]).status, 0);
  });
});

describe("unsigned git source", () => {
  let first;

  before(() => {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet");
    kon(repo, "kon-git");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "one");
    first = git(repo, "rev-parse", "HEAD");
  });

  it("without a terminal and without --trust-source, installs nothing (exit 3)", () => {
    const r = cli(["add", "git", "--from", repo, "--no-install", "--no-migrate"]);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    assert.match(r.stdout, /Unsigned source/);
    assert.match(r.stdout, new RegExp(first));
    assert.match(r.stderr, /confirmation required/);
    assert.ok(!existsSync(join(project, "packages", "kons", "kon-git")));
    assert.deepEqual(declaredAll(), {});
  });

  it("--yes alone does not count", () => {
    const r = cli(["add", "git", "--from", repo, "--yes", "--no-install", "--no-migrate"]);
    assert.equal(r.status, 3, r.stderr + r.stdout);
  });

  it("--trust-source installs and records the commit", () => {
    const r = cli(["add", "git", "--from", repo, "--trust-source", "--no-install", "--no-migrate"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-git"].commit, first);
    assert.equal(declaredAll()["kon-git"].source, repo);
  });

  it("a later push does not reach a reinstall until --latest", () => {
    writeFileSync(join(repo, "kons", "kon-git", "index.ts"), "// second\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "two");
    const secondItem = git(repo, "rev-parse", "HEAD");

    let r = cli(["add", "git", "--from", repo, "--trust-source", "--no-install", "--no-migrate"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-git"].commit, first);
    assert.match(
      readFileSync(join(project, "packages", "kons", "kon-git", "index.ts"), "utf8"),
      /export const kon/
    );

    r = cli([
      "add",
      "git",
      "--from",
      repo,
      "--trust-source",
      "--latest",
      "--no-install",
      "--no-migrate",
    ]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-git"].commit, secondItem);
    assert.match(
      readFileSync(join(project, "packages", "kons", "kon-git", "index.ts"), "utf8"),
      /second/
    );
  });

  it("--ref takes a commit, and refuses one that looks like an option", () => {
    let r = cli([
      "add",
      "git",
      "--from",
      repo,
      "--ref",
      first,
      "--trust-source",
      "--no-install",
      "--no-migrate",
      "--force",
    ]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-git"].commit, first);
    r = cli([
      "add",
      "git",
      "--from",
      repo,
      "--ref=--upload-pack=evil",
      "--trust-source",
      "--no-install",
      "--no-migrate",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid git ref/);
  });

  it("a local folder is not a git source: no prompt, no commit", () => {
    kon(origin, "kon-local");
    const r = cli(["add", "local", "--from", origin, "--no-install", "--no-migrate"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(declaredAll()["kon-local"].commit, undefined);
  });
});

describe("registry index freshness", () => {
  it("a written index expires, and an expired one is refused", async () => {
    const { generateKeys, readSecretKey } = await m("registry/signature.js");
    const { loadIndex, writeLocalIndex, emptyIndex, INDEX_VALIDITY_DAYS } =
      await m("registry/index.js");
    const { secretKey: secret, publicKey: publicKeyPem } = generateKeys();
    const key = readSecretKey(secret);
    const dir = join(base, "registro-fresco");

    const writtenItem = writeLocalIndex(dir, emptyIndex("t"), key);
    const days = (new Date(writtenItem.expires).getTime() - Date.now()) / 86_400_000;
    assert.ok(Math.abs(days - INDEX_VALIDITY_DAYS) < 1);

    await loadIndex(dir, { key: publicKeyPem });
    await assert.rejects(
      loadIndex(dir, {
        key: publicKeyPem,
        now: new Date(Date.now() + (INDEX_VALIDITY_DAYS + 1) * 86_400_000),
      }),
      /expired/
    );
  });

  it("kon resign renews the expiry with a later serial", async () => {
    const { generateKeys } = await m("registry/signature.js");
    const { secretKey: secret } = generateKeys();
    const dir = join(base, "registro-resign");
    const keyFile = join(base, "registro.key");
    writeFileSync(keyFile, secret);
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [CLI, "kon", "resign", "--registry", dir, "--index-key", keyFile, ...args],
        { encoding: "utf8" }
      );

    let r = run("--expires-days", "7");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const one = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    assert.ok(Math.abs((new Date(one.expires).getTime() - Date.now()) / 86_400_000 - 7) < 1);

    r = run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const dos = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    assert.equal(dos.serial, one.serial + 1);

    r = run("--expires-days", "0");
    assert.notEqual(r.status, 0);
  });
});
