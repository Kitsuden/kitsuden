/**
 * `kitsuden make kon` — the generated kon compiles and its own test passes
 * ============================================================================
 *
 * The generator's templates are code inside strings: nothing type-checks them until a kon is
 * generated. A broken template once shipped (a handler cut in half, a variable declared twice),
 * so this test generates a STANDALONE kons repository in a temporary folder, links it to this
 * Kitsuden checkout, and runs in it the generated test and `tsc`. It also plans a kon inside a
 * project, to check paths and imports there.
 *
 *   pnpm --filter @kitsuden/cli build && node --test tests/make-kon.test.mjs
 *
 * It needs this checkout's node_modules installed (the temporary repository links them).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const CLI = resolve(import.meta.dirname, "..", "dist", "index.js");
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const shell = process.platform === "win32";

let work;
let repo;

function run(cmd, args, cwd, env = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    shell,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}
const cli = (args, cwd) => run(process.execPath, [CLI, ...args], cwd);

before(() => {
  assert.ok(existsSync(CLI), "build the CLI first: pnpm --filter @kitsuden/cli build");
  work = mkdtempSync(join(tmpdir(), "kitsuden-make-kon-"));
  repo = join(work, "kitsuden-kon-demo-notes");
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("kitsuden make kon --standalone", () => {
  it("writes a kons repository with the kon and its test", () => {
    const r = cli(["make", "kon", "demo-notes", "--standalone", repo], work);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const k = join(repo, "kons", "kon-demo-notes");
    for (const f of [
      "kon.json",
      "package.json",
      "tsconfig.json",
      "index.ts",
      "demo-notes.routes.ts",
      "demo-notes.policy.ts",
      "demo-notes.schema.ts",
      "migrations/0000_initial.sql",
      "README.md",
      "AGENTS.md",
    ]) {
      assert.ok(existsSync(join(k, f)), `missing kons/kon-demo-notes/${f}`);
    }
    for (const f of [
      "package.json",
      "tsconfig.kons.json",
      "vitest.config.ts",
      ".gitignore",
      ".gitattributes",
      ".npmrc",
      "scripts/link-core.mjs",
      "scripts/kon-sync.mjs",
      "schemas/kon-schema.json",
      "tests/unit/helpers/safe-kons-bench.ts",
      "tests/unit/kon-demo-notes.test.ts",
    ]) {
      assert.ok(existsSync(join(repo, f)), `missing ${f}`);
    }
    const manifest = JSON.parse(readFileSync(join(k, "kon.json"), "utf8"));
    assert.equal(manifest.tables[0].name, "demo_notes_items");
    assert.equal(manifest.category, "content");
    assert.equal(manifest.maturity, "experimental");
    const index = readFileSync(join(k, "index.ts"), "utf8");
    assert.match(index, /import manifest from "\.\/kon\.json" with \{ type: "json" \}/);
    assert.match(
      readFileSync(join(k, "demo-notes.policy.ts"), "utf8"),
      /actAsUser: actsAsUserIn\("demo-notes"\)/
    );
    assert.match(
      readFileSync(join(k, "migrations/0000_initial.sql"), "utf8"),
      /kitsuden_rls_team\('demo_notes_items'/
    );
    assert.match(
      readFileSync(join(repo, "package.json"), "utf8"),
      /"name": "kitsuden-kon-demo-notes"/
    );
  });

  it("refuses a folder that is not empty and a kon that already exists", () => {
    assert.equal(cli(["make", "kon", "demo-notes", "--standalone", repo], work).status, 1);
    assert.equal(cli(["make", "kon", "demo-notes"], repo).status, 1);
  });

  it("adds a second kon from inside the new repository", () => {
    const r = cli(["make", "kon", "second"], join(repo, "kons"));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(repo, "kons", "kon-second", "kon.json")));
    assert.ok(existsSync(join(repo, "tests", "unit", "kon-second.test.ts")));
  });

  it("the other generators work inside the kons repository", () => {
    for (const args of [
      ["policy", "Draft"],
      ["request", "CreateNote"],
      ["job", "SendDigest"],
      ["test", "flow"],
      ["model", "note"],
    ]) {
      const r = cli(["make", ...args, "--kon", "demo-notes"], repo);
      assert.equal(r.status, 0, `make ${args.join(" ")}: ${r.stderr}${r.stdout}`);
    }
    const k = join(repo, "kons", "kon-demo-notes");
    assert.match(readFileSync(join(k, "demo-notes.policy.ts"), "utf8"), /"demo-notes-draft"/);
    assert.ok(existsSync(join(k, "create-note.request.ts")));
    assert.ok(existsSync(join(k, "send-digest.job.ts")));
    assert.ok(existsSync(join(repo, "tests", "unit", "kon-demo-notes-flow.test.ts")));
    // Inside a kon's folder (or a subfolder of it), --kon is inferred from the enclosing kon.json.
    const secondDir = join(repo, "kons", "kon-second");
    for (const args of [
      ["policy", "Review"],
      ["request", "UpdateSecond"],
      ["model", "entry"],
    ]) {
      const r = cli(["make", ...args], secondDir);
      assert.equal(r.status, 0, `make ${args.join(" ")} in kon-second: ${r.stderr}${r.stdout}`);
    }
    assert.match(readFileSync(join(secondDir, "second.policy.ts"), "utf8"), /"second-review"/);
    assert.ok(existsSync(join(secondDir, "update-second.request.ts")));
    assert.ok(existsSync(join(secondDir, "src", "entry.model.ts")));
    // At the root of a kons repository (not inside a kon), --kon is still required.
    const r = cli(["make", "request", "Orphan"], repo);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--kon/);
  });

  it("links this checkout, and the generated tests and tsc pass", { timeout: 900_000 }, () => {
    const link = run(process.execPath, ["scripts/link-core.mjs"], repo, { KITSUDEN_DIR: REPO });
    assert.equal(link.status, 0, link.stderr + link.stdout);
    const install = run("pnpm", ["install", "--offline", "--ignore-scripts"], repo);
    assert.equal(install.status, 0, install.stderr + install.stdout);

    // makemigrations for a model generated in the kons repository (both with --kon and from inside the kon).
    const mm1 = cli(["makemigrations", "--kon", "demo-notes"], repo);
    assert.equal(mm1.status, 0, mm1.stderr + mm1.stdout);
    assert.ok(existsSync(join(repo, "kons", "kon-demo-notes", "migrations", "0001_models.sql")));
    const mm2 = cli(["makemigrations"], join(repo, "kons", "kon-second"));
    assert.equal(mm2.status, 0, mm2.stderr + mm2.stdout);
    assert.ok(existsSync(join(repo, "kons", "kon-second", "migrations", "0001_models.sql")));

    const vitest = join(repo, "node_modules", "vitest", "vitest.mjs");
    const tests = run(
      process.execPath,
      [
        vitest,
        "run",
        "tests/unit/kon-demo-notes.test.ts",
        "tests/unit/kon-second.test.ts",
        "tests/unit/kon-demo-notes-flow.test.ts",
      ],
      repo
    );
    assert.equal(tests.status, 0, (tests.stdout + tests.stderr).slice(-6000));

    const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
    for (const k of ["kon-demo-notes", "kon-second"]) {
      const t = run(process.execPath, [tsc, "--noEmit", "-p", `kons/${k}`], repo);
      // Errors inside the linked core (.kitsuden/…) are the checkout's, not the generated kon's.
      const own = (t.stdout + t.stderr)
        .split("\n")
        .filter((l) => /error TS/.test(l) && !l.startsWith(".kitsuden"));
      assert.deepEqual(own, [], own.join("\n"));
    }

    const sync = run(process.execPath, ["scripts/kon-sync.mjs", "--check"], repo);
    assert.equal(sync.status, 0, sync.stderr + sync.stdout);
  });
});

describe("kitsuden make kon in a project", () => {
  it("plans packages/kons/<id> and imports the project's helpers", async () => {
    const { planKon } = await import("../dist/commands/make-kon.js");
    const root = join(work, "project");
    mkdirSync(join(root, "packages", "kons"), { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const plan = planKon("demo-notes", { root });
    assert.equal(plan.layout, "project");
    assert.equal(plan.konDir, "packages/kons/kon-demo-notes");
    const test = plan.files.find((f) => f.path.endsWith("kon-demo-notes.test.ts")).content;
    assert.match(test, /from "\.\/helpers\/kon-with-users"/);
    assert.match(test, /from "\.\.\/\.\.\/packages\/kons\/kon-demo-notes\/demo-notes\.routes"/);
  });

  it("refuses to run where there is neither a project nor a kons repository", () => {
    const lost = join(work, "lost");
    mkdirSync(lost, { recursive: true });
    const r = cli(["make", "kon", "lost"], lost);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--standalone/);
  });
});
