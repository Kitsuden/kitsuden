#!/usr/bin/env node
/**
 * The test database, on Linux, macOS and Windows.
 *
 *   node scripts/test-db.mjs up           start Postgres and Valkey, wait, migrate
 *   node scripts/test-db.mjs down         stop them (--nuke also removes the data)
 *   node scripts/test-db.mjs migrate      apply the migrations to the test database
 *   node scripts/test-db.mjs api          migrate, then run the API suite
 *   node scripts/test-db.mjs api-all      up, the API suite, down
 *   node scripts/test-db.mjs exec -- CMD  run CMD with the test environment
 *
 * Settings come from .env.test, created from .env.test.example by `up`. A variable
 * already in the environment wins, which is how CI passes its own. The test suite
 * deletes whole tables without a WHERE, so this refuses to run against anything that
 * does not look like a test database.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "apps", "api");
const ENV_FILE = ".env.test";
const ENV_EXAMPLE = `${ENV_FILE}.example`;
const COMPOSE = ["compose", "-f", "docker-compose.test.yml", "--env-file", ENV_FILE];
const CONTAINER = "kitsuden_test_db";
const HEALTH_TIMEOUT_SECONDS = 60;
const CONNECT_TIMEOUT_MS = 3000;

function fail(message) {
  console.error(`test-db: ${message}`);
  process.exit(1);
}

/**
 * Every argument below is a constant, so a shell cannot reinterpret anything. It
 * is needed on Windows only, where bun may be a .cmd shim.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** Parses KEY=value lines. Values are never printed. */
export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

/**
 * Why this must not be used as the test database, or null. CI has a throwaway
 * service on the regular port; on anyone's machine, 5432 can be the real thing.
 */
export function unsafeReason(env) {
  if (env.KITSUDEN_ALLOW_UNSAFE_TEST_DB === "1") return null;
  const db = env.POSTGRES_DB ?? "kitsuden_test";
  const port = String(env.POSTGRES_PORT ?? "5434");
  if (!/test/i.test(db)) return `database "${db}" does not have "test" in its name`;
  if (/prod/i.test(db)) return `database "${db}" has "prod" in its name`;
  if (port === "5432") return "port 5432 is the regular Postgres port, not the test one (5434)";
  const url = env.DATABASE_URL;
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return "DATABASE_URL is not a URL";
    }
    const name = parsed.pathname.slice(1);
    if (!/test/i.test(name) || /prod/i.test(name))
      return "DATABASE_URL does not point to a test database";
    if ((parsed.port === "5432" || parsed.port === "") && !env.CI)
      return "DATABASE_URL does not use the test port";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
      return "DATABASE_URL is not on this machine";
  }
  return null;
}

/**
 * The example first, so an .env.test made before a variable was added still has it.
 * Reading never creates a file: that is the job of `up`.
 */
function readEnvFiles() {
  const read = (name) => {
    const file = join(ROOT, name);
    return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  };
  return { ...read(ENV_EXAMPLE), ...read(ENV_FILE) };
}

/**
 * The environment a test command runs in: the files, then whatever the process
 * already has, then the overrides. Refuses an unsafe database wherever it came from,
 * because the variable may well be left over from the shell.
 */
export function testEnvironment(overrides = {}) {
  const env = { ...readEnvFiles(), ...process.env, NODE_ENV: "test", ...overrides };
  const reason = unsafeReason(env);
  if (reason) {
    const origin = process.env.DATABASE_URL ? "the environment" : ENV_FILE;
    fail(`refusing to run tests with the settings from ${origin}: ${reason}.`);
  }
  return env;
}

/** Creates the file docker compose reads if needed, and checks it. */
function prepareComposeEnv() {
  const file = join(ROOT, ENV_FILE);
  if (!existsSync(file)) {
    // Not a plain copy: a shell cannot source a CRLF file, and a checkout may have one.
    const example = readFileSync(join(ROOT, ENV_EXAMPLE), "utf8");
    writeFileSync(file, example.replaceAll("\r\n", "\n"));
    console.log(`test-db: created ${ENV_FILE} from ${ENV_EXAMPLE}`);
  }
  const reason = unsafeReason(parseEnv(readFileSync(file, "utf8")));
  if (reason) fail(`refusing to use ${ENV_FILE}: ${reason}.`);
}

function dockerRunning() {
  return run("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/** Without this, a stopped database only shows up as a confusing failure further on. */
function requirePostgres(env) {
  const { hostname, port } = new URL(env.DATABASE_URL);
  const host = hostname.replace(/^\[|\]$/g, "");
  return new Promise((done) => {
    const socket = connect({ host, port: Number(port) || 5432, timeout: CONNECT_TIMEOUT_MS });
    const refuse = () => {
      socket.destroy();
      fail(`Postgres is not answering on ${host}:${port}. Start it with: pnpm test:db:up`);
    };
    socket.once("connect", () => {
      socket.destroy();
      done();
    });
    socket.once("timeout", refuse);
    socket.once("error", refuse);
  });
}

function migrate(env) {
  // --no-env-file: bun would otherwise add apps/api/.env, which is not for tests.
  const { status } = run("bun", ["--no-env-file", "run", "scripts/migrate.ts"], { cwd: API, env });
  if (status === 0) return;
  fail(
    "the migrations did not apply; the reason is above. If it says «password authentication " +
      `failed», the test volume was created with other credentials than ${ENV_FILE}. It only ` +
      "holds test data: run pnpm test:db:down --nuke, then pnpm test:db:up."
  );
}

function up() {
  prepareComposeEnv();
  if (!dockerRunning()) fail("Docker is not running.");
  if (run("docker", [...COMPOSE, "up", "-d"]).status !== 0)
    fail("could not start the test containers.");

  const deadline = Date.now() + HEALTH_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const health = run("docker", ["inspect", "--format={{.State.Health.Status}}", CONTAINER], {
      stdio: "pipe",
    });
    if (health.stdout.trim() === "healthy") {
      const migrated = testEnvironment({ KITSUDEN_TEST_DB: "postgres" });
      migrate(migrated);
      const { username, host, pathname } = new URL(migrated.DATABASE_URL);
      console.log(`test-db: ready and migrated at postgres://${username}:***@${host}${pathname}`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  fail(
    `Postgres did not become healthy in ${HEALTH_TIMEOUT_SECONDS} s. Logs: docker ${COMPOSE.join(" ")} logs`
  );
}

function down(nuke) {
  prepareComposeEnv();
  const args = [...COMPOSE, "down", ...(nuke ? ["-v"] : [])];
  if (run("docker", args).status !== 0) fail("could not stop the test containers.");
}

async function migrateCommand() {
  const env = testEnvironment({ KITSUDEN_TEST_DB: "postgres" });
  await requirePostgres(env);
  migrate(env);
}

async function api() {
  const env = testEnvironment({ KITSUDEN_TEST_DB: "postgres" });
  await requirePostgres(env);
  migrate(env);
  // The academy test needs kon-academy-lms, which is not in a clean clone.
  const ignore = existsSync(join(ROOT, "packages", "kons", "kon-academy-lms"))
    ? []
    : ["--path-ignore-patterns=**/academy-supervisor-by-groups.test.ts"];
  const suite = ["--no-env-file", "test", "src/tests/", ...ignore];
  let { status } = run("bun", suite, { cwd: API, env });
  if (status === 0) ({ status } = run("node", ["scripts/isolated-test.mjs"], { cwd: API, env }));
  return status;
}

async function apiAll() {
  up();
  const status = await api();
  down(false);
  return status;
}

function exec(args) {
  const [command, ...rest] = args[0] === "--" ? args.slice(1) : args;
  if (!command) fail("usage: node scripts/test-db.mjs exec -- <command> [args]");
  const hermetic = command === "bun" ? ["--no-env-file", ...rest] : rest;
  return run(command, hermetic, { cwd: process.cwd(), env: testEnvironment() }).status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...flags] = process.argv.slice(2);
  if (command === "up") up();
  else if (command === "down") down(flags.includes("--nuke"));
  else if (command === "migrate") await migrateCommand();
  else if (command === "api") process.exit(await api());
  else if (command === "api-all") process.exit(await apiAll());
  else if (command === "exec") process.exit(exec(flags));
  else
    fail(
      "usage: node scripts/test-db.mjs up | down [--nuke] | migrate | api | api-all | exec -- <command>"
    );
}
