/**
 * The test commands find their settings, and never a database they should not use
 * ============================================================================
 *
 * In a fresh clone `pnpm test:api` died with «DATABASE_URL: expected string», because
 * nothing loaded `.env.test`. And `scripts/migrate.ts` with NODE_ENV=test, when
 * Postgres refused the password, fell back to pg-mem without saying so and died in
 * its parser: «A "codeblock" token», which says nothing about the password.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv, unsafeReason } from "../../scripts/test-db.mjs";

const root = join(__dirname, "..", "..");
const SAFE_URL = "postgres://u:p@127.0.0.1:5434/kitsuden_test_env";

/** The process environment without anything that would decide the outcome by accident. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["DATABASE_URL", "NODE_ENV", "KITSUDEN_TEST_DB", "BETTER_AUTH_SECRET", "CI"])
    delete env[key];
  return { ...env, ...extra };
}

/** A file, because `node -e` does not survive `shell: true` on Windows intact. */
function exec(extra: Record<string, string>) {
  const script = join(root, "tests", "unit", "fixtures", "show-test-env.mjs");
  return spawnSync("node", ["scripts/test-db.mjs", "exec", "--", "node", script], {
    cwd: root,
    env: cleanEnv(extra),
    encoding: "utf8",
  });
}

describe("node scripts/test-db.mjs exec", () => {
  it("reads the settings when the environment has none", () => {
    const r = exec({});
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout);
    expect(seen.env).toBe("test");
    expect(seen.mode).toBe("postgres");
    expect(seen.secret).toBe(true);
    expect(unsafeReason({ DATABASE_URL: seen.url })).toBeNull();
  });

  it("what is already in the environment wins: that is how CI passes its own", () => {
    const r = exec({ DATABASE_URL: SAFE_URL, KITSUDEN_TEST_DB: "memory" });
    expect(r.status, r.stderr).toBe(0);
    const seen = JSON.parse(r.stdout);
    expect(seen.url).toBe(SAFE_URL);
    expect(seen.mode).toBe("memory");
  });

  it.each([
    ["a name without test", "postgres://u:p@127.0.0.1:5434/kitsuden_dev"],
    ["a name with prod", "postgres://u:p@127.0.0.1:5434/kitsuden_prod_test"],
    ["the regular port", "postgres://u:p@127.0.0.1:5432/kitsuden_test"],
  ])("refuses %s left over in the environment, and does not print it", (_label, url) => {
    const r = exec({ DATABASE_URL: url });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("refusing");
    expect(r.stderr).not.toContain("u:p@");
  });

  it("CI's throwaway service on the regular port is accepted only under CI", () => {
    const url = "postgres://u:p@localhost:5432/kitsuden_test";
    expect(unsafeReason({ DATABASE_URL: url })).toMatch(/test port/);
    expect(unsafeReason({ DATABASE_URL: url, CI: "true" })).toBeNull();
    expect(
      unsafeReason({ DATABASE_URL: "postgres://u:p@localhost:5432/kitsuden_dev", CI: "true" })
    ).toMatch(/test database/);
  });
});

describe(".env.test.example", () => {
  const example = parseEnv(readFileSync(join(root, ".env.test.example"), "utf8"));

  it.each([
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "REDIS_URL",
    "KITSUDEN_TEST_DB",
  ])("has %s", (key) => {
    expect(example[key]).toBeTruthy();
  });

  it("its secret is long enough for the API to start", () => {
    expect(example.BETTER_AUTH_SECRET!.length).toBeGreaterThanOrEqual(32);
  });

  it("its URL matches the container it describes", () => {
    const url = new URL(example.DATABASE_URL!);
    expect(url.username).toBe(example.POSTGRES_USER);
    expect(url.password).toBe(example.POSTGRES_PASSWORD);
    expect(url.port).toBe(example.POSTGRES_PORT);
    expect(url.pathname.slice(1)).toBe(example.POSTGRES_DB);
  });
});

describe("migrations and pg-mem", () => {
  const migrate = (extra: Record<string, string>) =>
    spawnSync("bun", ["--no-env-file", "run", "scripts/migrate.ts", "--status"], {
      cwd: join(root, "apps", "api"),
      env: cleanEnv(extra),
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 60_000,
    });
  // Nothing listens on port 1, so this never reaches a database.
  const unreachable = "postgres://u:p@127.0.0.1:1/kitsuden_test";

  it.each([
    ["with no KITSUDEN_TEST_DB", {}],
    ["with a CR left by sourcing a CRLF file", { KITSUDEN_TEST_DB: "postgres\r" }],
  ])(
    "NODE_ENV=test %s: the real error, not pg-mem",
    (_label, extra) => {
      const r = migrate({ NODE_ENV: "test", DATABASE_URL: unreachable, ...extra });
      const output = `${r.stdout}${r.stderr}`;
      expect(r.status).not.toBe(0);
      expect(output).toContain("KITSUDEN_TEST_DB=postgres");
      expect(output).not.toMatch(/pg-mem\]|using pg-mem|codeblock/);
      expect(output, "a password must never reach the output").not.toContain("u:p@");
    },
    60_000
  );

  it("KITSUDEN_TEST_DB=memory is refused with a clear message", () => {
    const r = migrate({ NODE_ENV: "test", DATABASE_URL: unreachable, KITSUDEN_TEST_DB: "memory" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("pg-mem is not one");
  }, 60_000);

  it("a typo in KITSUDEN_TEST_DB is an error, not a silent pg-mem", () => {
    const r = migrate({
      NODE_ENV: "test",
      DATABASE_URL: unreachable,
      KITSUDEN_TEST_DB: "postgress",
    });
    expect(r.status).not.toBe(0);
  }, 60_000);
});
