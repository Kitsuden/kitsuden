/**
 * Compile test: the site builds WITHOUT Inti and, when `@intijs/*` is
 * installed, WITH it (`INTI=true`).
 *
 *   node --test tests/build.test.mjs        (or: pnpm test:build)
 *
 * Each build is inspected, not just run:
 *
 *   · without Inti: no `@intijs` code and no `/_actions` route in the bundle;
 *   · with Inti: the actions route and Inti's editor are in the bundle;
 *   · both: secrets present in the environment at build time
 *     (KITSUDEN_SITE_KEY, INTI_KITSUDEN_TOKEN) are NOT written into it.
 *
 * The Inti build runs first so `dist/` ends up as the plain build. It is
 * skipped, with the reason, when `@intijs/core` is not installed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** How the route manifest names the actions endpoint */
const ACTIONS_ROUTE = '"route":"/_actions/[...path]"';
const SENTINEL = "kitsuden-build-test-secret-0123456789";

/** Installed = present in node_modules (a link: or git dependency counts) */
function hasInti() {
  return ["core", "adapter-kitsuden"].every((name) =>
    existsSync(join(root, "node_modules", "@intijs", name, "package.json"))
  );
}

function build(extraEnv) {
  const astro = join(root, "node_modules", "astro", "bin", "astro.mjs");
  const result = spawnSync(process.execPath, [astro, "build"], {
    cwd: root,
    env: {
      ...process.env,
      KITSUDEN_SITE_KEY: SENTINEL,
      INTI_KITSUDEN_TOKEN: SENTINEL,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  return result.status;
}

/** Every text file of the server bundle, concatenated */
function bundle() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(m?js|json|html|css)$/.test(name)) out.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(root, "dist"));
  return out.join("\n");
}

test(
  "builds WITH Inti (INTI=true)",
  { skip: hasInti() ? false : "@intijs/core is not installed (see README)" },
  () => {
    assert.equal(build({ INTI: "true" }), 0, "astro build with INTI=true failed");
    const code = bundle();
    assert.ok(code.includes(ACTIONS_ROUTE), "the Inti actions route is mounted");
    assert.ok(/VisualBridge|intiActions|updateBlockField/.test(code), "Inti's editor is bundled");
    assert.ok(!code.includes(SENTINEL), "no secret written into the build");
  }
);

test("builds WITHOUT Inti", () => {
  assert.equal(build({ INTI: "" }), 0, "astro build failed");
  assert.ok(existsSync(join(root, "dist", "server", "entry.mjs")));
  const code = bundle();
  assert.ok(!/(from\s*|import\(\s*)["']@intijs\//.test(code), "no @intijs import in the bundle");
  assert.ok(!/updateBlockField|VisualBridge/.test(code), "no Inti editor code in the bundle");
  assert.ok(!code.includes(ACTIONS_ROUTE), "no actions route");
  assert.ok(!code.includes(SENTINEL), "no secret written into the build");
});

test(
  "INTI=true without @intijs/* fails with a clear message",
  { skip: hasInti() ? "@intijs/core is installed" : false },
  () => {
    const astro = join(root, "node_modules", "astro", "bin", "astro.mjs");
    const result = spawnSync(process.execPath, [astro, "build"], {
      cwd: root,
      env: { ...process.env, INTI: "true" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /@intijs\/core or @intijs\/adapter-kitsuden is not installed/
    );
  }
);
