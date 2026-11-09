/**
 * `docker/start-with-check.sh`: a missing database is NOT a failing user.
 *
 * The credentials check was done against the application's database.
 * If what was missing was the DATABASE (new volume with another POSTGRES_DB, or a URL
 * that points to a database nobody has created), Postgres answered
 * `database "..." does not exist` and the script said it did not accept
 * the user, with instructions to recreate the role — which was not the problem.
 *
 * Here the real script is run with fake `psql`, `pg_isready` and `bun` on the
 * PATH. It stops only at step [4/6] (`cd /app/apps/api` does not exist), so
 * what matters is what it says up to there.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../docker/start-with-check.sh");
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

let dir: string;

function stub(name: string, body: string) {
  const route = join(dir, name);
  writeFileSync(route, `#!/bin/sh\n${body}\n`);
  chmodSync(route, 0o755);
}

beforeAll(() => {
  if (!hasSh) return;
  dir = mkdtempSync(join(tmpdir(), "kitsuden-startup-"));
  stub("bun", "exit 0");
  stub("pg_isready", "exit 0");
  // SCENARIO=no-database: the user gets into `postgres`, but `appdb` does not exist.
  // SCENARIO=no-user: the password is not valid in any database.
  // CREATE=no: the CREATE DATABASE fails because of permissions.
  stub(
    "psql",
    `all="$*"
if [ "$SCENARIO" = "no-user" ]; then
  echo 'psql: error: FATAL:  password authentication failed for user "kit"' >&2; exit 2
fi
case "$all" in
  *"CREATE DATABASE"*)
    if [ "$CREATE" = "no" ]; then echo 'ERROR:  permission denied to create database' >&2; exit 1; fi
    echo CREATE DATABASE; exit 0 ;;
  *pg_database*) exit 0 ;;
  */postgres*) echo 1; exit 0 ;;
  *) echo 'psql: error: FATAL:  database "appdb" does not exist' >&2; exit 2 ;;
esac`
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function start(env: Record<string, string>) {
  const r = spawnSync("sh", [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      DATABASE_URL: "postgresql://kit:xx@db:5432/appdb",
      DATABASE_ADMIN_URL: "",
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!hasSh)("start-with-check.sh: database vs user", () => {
  it("if the database is missing, it does NOT blame the user and moves on to create it", () => {
    const { output } = start({ SCENARIO: "no-database" });
    expect(output).not.toContain("does not accept the user");
    expect(output).toContain("OK - authentication successful (kit)");
    expect(output).toContain("Creating database...");
  });

  it("if the database is missing and cannot be created, it says so about the DATABASE and stops", () => {
    const { code, output } = start({ SCENARIO: "no-database", CREATE: "no" });
    expect(code).toBe(1);
    expect(output).toContain("the database 'appdb' does not exist");
    expect(output).not.toContain("does not accept the user");
  });

  it("if the password is not valid, it still blames the user", () => {
    const { code, output } = start({ SCENARIO: "no-user" });
    expect(code).toBe(1);
    expect(output).toContain("does not accept the user 'kit'");
  });
});
