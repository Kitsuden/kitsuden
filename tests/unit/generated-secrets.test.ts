/**
 * Secrets generated on the first start (docker/generate-secrets.sh, docker-compose.yml)
 *
 * A new install needs no hand-made passwords; an old one keeps its own. Three rules make it safe:
 *   · every secret the stack needs is generated, and a value in .env wins and is copied;
 *   · the files are root's, and the API serves as `bun`: it cannot read the superuser's password;
 *   · the raw passwords never reach the running API's environment.
 * The script itself is run on a temporary folder: generate, keep on a second run, copy from .env.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { SECRET_VARIABLES } from "../../apps/api/src/lib/placeholder-secrets";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const script = read("docker/generate-secrets.sh");
const start = read("docker/start-with-check.sh");
const env = read("docker/kitsuden-env.sh");
const compose = read("docker-compose.yml");

describe("generated secrets: what is wired", () => {
  it("generates every secret the API checks for placeholders, plus the database and Valkey ones", () => {
    for (const name of [
      ...SECRET_VARIABLES,
      "POSTGRES_PASSWORD",
      "DDL_DB_PASSWORD",
      "VALKEY_PASSWORD",
    ]) {
      expect(script).toMatch(new RegExp(`^generate \\S+ +${name} +04[04]{2}$`, "m"));
    }
  });

  it("root-only files; only the web's site key is readable by others", () => {
    const modes = [...script.matchAll(/^generate (\S+) +\S+ +(\d{4})$/gm)].map((m) => [m[1], m[2]]);
    for (const [file, mode] of modes) expect(mode).toBe(file === "site_api_key" ? "0444" : "0400");
  });

  it("the API container starts as root only to read them, then serves as bun", () => {
    expect(compose).toMatch(/kitsuden_api:[\s\S]*?user: "0:0"/);
    expect(read("docker/Dockerfile.prod")).toMatch(/apk add --no-cache [^\n]*su-exec/);
    expect(start).toContain('exec su-exec bun:bun sh "$0" "$@"');
    // Never serve as root: without su-exec it refuses instead of carrying on
    expect(start).toContain("started as root and su-exec is missing");
  });

  it("drops the raw passwords once the URLs are built, and the admin URL before serving", () => {
    expect(env).toContain(
      "unset _at POSTGRES_PASSWORD APP_DB_PASSWORD DDL_DB_PASSWORD VALKEY_PASSWORD"
    );
    // Loaded as root, built as bun: the order in the start script
    expect(start.indexOf("kitsuden_load_secrets")).toBeLessThan(start.indexOf("exec su-exec"));
    expect(start.indexOf("exec su-exec")).toBeLessThan(start.indexOf("kitsuden_build_urls"));
    expect(start).toMatch(/unset DATABASE_ADMIN_URL/);
  });

  it("maintenance commands get the admin account the same way, and run as bun", () => {
    const admin = read("docker/as-admin.sh");
    expect(admin).toContain('. "$(dirname "$0")/kitsuden-env.sh"');
    expect(admin).toContain('exec su-exec bun:bun "$@"');
    expect(read("docs/install/upgrade-and-backups.md")).toContain(
      "sh /app/docker/as-admin.sh bun run scripts/rekey-secrets.ts"
    );
  });

  it("no compose file of the stack requires a secret in .env any more", () => {
    for (const f of ["docker-compose.yml", "docker-compose.public.yml", "docker-compose.tls.yml"]) {
      const text = read(f);
      for (const name of [...SECRET_VARIABLES, "POSTGRES_PASSWORD", "VALKEY_PASSWORD"]) {
        expect(text, `${f} requires ${name}`).not.toContain(`\${${name}:?`);
      }
    }
  });

  it("Postgres, Valkey and the API wait for the generator", () => {
    const after = compose.match(/condition: service_completed_successfully/g) ?? [];
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(compose).toContain('entrypoint: ["sh", "/app/docker/generate-secrets.sh"]');
  });
});

// The script is POSIX sh; the CI runners and the image have it. Skipped where there is no `sh`.
const sh = (() => {
  try {
    execFileSync("sh", ["-c", "true"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!sh)("generated secrets: the script", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitsuden-secrets-"));
  const run = (env: Record<string, string> = {}) =>
    execFileSync("sh", [join(root, "docker/generate-secrets.sh")], {
      env: { PATH: process.env.PATH ?? "", KITSUDEN_SECRETS_DIR: dir, ...env },
      encoding: "utf8",
    });
  const file = (name: string) => readFileSync(join(dir, name), "utf8");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("generates 64 hex characters, copies a value from .env, ignores a placeholder", () => {
    run({ POSTGRES_PASSWORD: "kept-from-env", VALKEY_PASSWORD: "<openssl rand -hex 32>" });
    expect(file("postgres_password")).toBe("kept-from-env");
    expect(file("valkey_password")).toMatch(/^[0-9a-f]{64}$/);
    expect(file("kitsuden_secrets_key")).toMatch(/^[0-9a-f]{64}$/);
    expect(file("app_db_password")).not.toBe(file("ddl_db_password"));
  });

  it("never rotates: a second run keeps every file", () => {
    const before = file("better_auth_secret");
    const out = run({ BETTER_AUTH_SECRET: "something-else" });
    expect(file("better_auth_secret")).toBe(before);
    // and says the variable differs, without printing either value
    expect(out).toContain("BETTER_AUTH_SECRET in .env differs");
    expect(out).not.toContain(before);
  });

  it.skipIf(process.platform === "win32")("writes the modes it promises", () => {
    expect(statSync(join(dir, "postgres_password")).mode & 0o777).toBe(0o400);
    expect(statSync(join(dir, "site_api_key")).mode & 0o777).toBe(0o444);
  });

  it("an empty file is generated again (a crash mid-write leaves none behind)", () => {
    chmodSync(join(dir, "site_api_key"), 0o644);
    writeFileSync(join(dir, "site_api_key"), "");
    run();
    expect(file("site_api_key")).toMatch(/^[0-9a-f]{64}$/);
  });
});
