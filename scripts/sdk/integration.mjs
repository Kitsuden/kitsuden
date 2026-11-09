#!/usr/bin/env node
/**
 * Integration run of both typed clients against a REAL local API
 * ============================================================================
 *
 * 1. migrates the test database given in KITSUDEN_SDK_IT_DATABASE_URL;
 * 2. starts the API (`bun --no-env-file src/index.ts`) on a free 127.0.0.1 port;
 * 3. seeds an admin session and two agents (apps/api/scripts/sdk-integration-seed.ts);
 * 4. runs the TypeScript suite (packages/sdk/tests/integration) and the Python
 *    one (packages/sdk-python/tests/integration, with uv) against it;
 * 5. stops the API.
 *
 *   KITSUDEN_SDK_IT_DATABASE_URL=postgres://user:pass@127.0.0.1:<port>/<name with test> \
 *   KITSUDEN_SDK_IT_REDIS_URL=redis://127.0.0.1:<port> \
 *   node scripts/sdk/integration.mjs [--only=ts|py] [--no-migrate]
 *
 * Refuses a database that is not local, whose name lacks `test` or has
 * `prod`, or on port 5432 (commonly a production database;
 * in CI, where 5432 is the job's own service, set CI=true).
 * The containers are yours: this script never starts or removes any.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API = join(ROOT, "apps/api");
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const withoutMigrating = args.includes("--no-migrate");

function fail(msg) {
  console.error(`[sdk-it] ${msg}`);
  process.exit(2);
}

const dbUrl = process.env.KITSUDEN_SDK_IT_DATABASE_URL;
if (!dbUrl) fail("set KITSUDEN_SDK_IT_DATABASE_URL (a local test database)");
const u = new URL(dbUrl);
const name = u.pathname.slice(1);
if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) fail("the database must be local");
if (!name.includes("test") || name.includes("prod"))
  fail(`database '${name}' does not look like a test database`);
if ((u.port || "5432") === "5432" && process.env.CI !== "true")
  fail("port 5432 is refused outside CI (production on the owner's machine)");

const freePort = () =>
  new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const envApi = {
  ...process.env,
  NODE_ENV: "test",
  KITSUDEN_TEST_DB: "postgres",
  DATABASE_URL: dbUrl,
  ...(process.env.KITSUDEN_SDK_IT_REDIS_URL
    ? { REDIS_URL: process.env.KITSUDEN_SDK_IT_REDIS_URL }
    : {}),
  PORT: String(port),
  HOST: "127.0.0.1",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  BETTER_AUTH_URL: origin,
  ALLOWED_ORIGINS: origin,
  RATE_LIMIT_ENABLED: "false",
  LOG_LEVEL: "error",
};
delete envApi.KITSUDEN_API_TOKEN;

const bun = process.platform === "win32" ? "bun.exe" : "bun";

if (!withoutMigrating) {
  console.error("[sdk-it] migrating the test database…");
  const m = spawnSync(bun, ["--no-env-file", "scripts/migrate.ts"], {
    cwd: API,
    env: envApi,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (m.status !== 0) fail(`migrations failed (${m.status})`);
}

console.error(`[sdk-it] starting the API on ${origin}…`);
const server = spawn(bun, ["--no-env-file", "src/index.ts"], {
  cwd: API,
  env: envApi,
  stdio: ["ignore", "ignore", "pipe"],
});
let errors = "";
server.stderr.on("data", (d) => (errors = (errors + d).slice(-4000)));
const stop = () => {
  if (!server.killed) server.kill();
};
process.on("exit", stop);

let ready = false;
for (let i = 0; i < 240 && !ready; i++) {
  if (server.exitCode !== null) break;
  try {
    const r = await fetch(`${origin}/api/health`);
    ready = r.status < 500;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ready) {
  console.error(errors);
  stop();
  fail("the API did not start");
}

const tmp = mkdtempSync(join(tmpdir(), "kitsuden-sdk-it-"));
const seed = join(tmp, "seed.json");
const s = spawnSync(
  bun,
  ["--no-env-file", "scripts/sdk-integration-seed.ts", `--api=${origin}`, `--out=${seed}`],
  {
    cwd: API,
    env: envApi,
    stdio: ["ignore", "ignore", "inherit"],
  }
);
if (s.status !== 0) {
  stop();
  // Seen once under load: src/db gives Postgres 3 s for `SELECT 1` and then
  // falls back to pg-mem without failing (the log fills with "[pg-mem]").
  fail("seeding failed (if the log shows [pg-mem], Postgres did not answer in 3 s: run it again)");
}
const data = JSON.parse(readFileSync(seed, "utf8"));
rmSync(tmp, { recursive: true, force: true });

const envTests = {
  ...process.env,
  KITSUDEN_API_URL: origin,
  KITSUDEN_API_TOKEN: data.direct.token,
  KITSUDEN_SDK_IT: "1",
  KITSUDEN_SDK_IT_COOKIE: data.cookie,
  KITSUDEN_SDK_IT_PROPOSE_TOKEN: data.propose.token,
  KITSUDEN_SDK_IT_PROPOSE_ID: data.propose.id,
  KITSUDEN_SDK_IT_DIRECT_ID: data.direct.id,
};

const results = [];
if (only !== "py") {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r = spawnSync(
    npx,
    ["vitest", "run", "--config", "packages/sdk/tests/integration/vitest.config.ts"],
    {
      cwd: ROOT,
      env: envTests,
      stdio: "inherit",
      shell: process.platform === "win32",
    }
  );
  results.push(["typescript", r.status]);
}
if (only !== "ts") {
  const r = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "--python",
      "3.12",
      "--with",
      "httpx>=0.24",
      "--with",
      "pytest",
      "--",
      "python",
      "-m",
      "pytest",
      "-q",
      "-p",
      "no:cacheprovider",
      "tests/integration",
    ],
    { cwd: join(ROOT, "packages/sdk-python"), env: envTests, stdio: "inherit" }
  );
  results.push(["python", r.status]);
}

stop();
for (const [q, st] of results)
  console.error(`[sdk-it] ${q}: ${st === 0 ? "passed" : `FAILED (${st})`}`);
process.exit(results.every(([, st]) => st === 0) ? 0 : 1);
