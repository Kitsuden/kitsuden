/**
 * What has to stay true for `./install.sh` to work
 * ============================================================================
 *
 * A new install is exactly what nobody repeats: whoever develops already has the
 * database. Three failures only showed up by following the README on an empty
 * database: the queue without permissions, the login with «Invalid origin» on the URL
 * the README itself recommended, and the kon switch without a DDL role.
 *
 * Most of this reads the files, because the real proof is a whole install and takes
 * 15 minutes. The dry run at the end does execute install.sh, with a fake `docker` that
 * only answers questions: it never builds or starts anything.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("docker/start-with-check.sh", () => {
  const start = read("docker/start-with-check.sh");

  it("creates the app role BEFORE migrating: migrations grant it permissions only if it exists", () => {
    const create = start.indexOf('CREATE ROLE "${APP_USER}"');
    const migrate = start.indexOf('DATABASE_URL="$DB_ADMIN_URL" bun run scripts/migrate.ts');
    expect(create).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(-1);
    expect(create).toBeLessThan(migrate);
  });

  it("works out APP_USER and APP_PASS before using them", () => {
    expect(start.indexOf("APP_USER=$(")).toBeLessThan(start.indexOf('CREATE ROLE "${APP_USER}"'));
    expect(start.indexOf("APP_PASS=$(")).toBeLessThan(start.indexOf('CREATE ROLE "${APP_USER}"'));
  });
});

describe("docker-compose.yml", () => {
  const compose = read("docker-compose.yml");

  // An existing deployment does not define KITSUDEN_INSTANCE. If the default changed,
  // its volumes would stop being its own: it would start with an empty database.
  it.each(["postgres", "valkey", "backups", "seaweedfs", "net"])(
    "the default name of %s stays what it always was",
    (resource) => {
      expect(compose).toContain(`name: \${KITSUDEN_INSTANCE:-kitsuden}_${resource}_prod`);
    }
  );

  it("the media volume still has no `name:` (its name depends on the project)", () => {
    expect(compose).toMatch(/^ {2}kitsuden_uploads_prod:\r?\n {2}kitsuden_postgres_prod:/m);
  });

  it("no container has a fixed name: it would clash with another install", () => {
    const fixed = compose.match(/^\s+container_name: (?!\$\{KITSUDEN_INSTANCE:-kitsuden\}_).*$/gm);
    expect(fixed).toBeNull();
  });

  it("the default origins include 127.0.0.1, the URL the documentation uses", () => {
    expect(compose).toContain("http://127.0.0.1:3000,http://127.0.0.1:3001}");
  });

  it("passes the API the DDL role and the OAuth issuer", () => {
    expect(compose).toContain("- DATABASE_DDL_URL=${DDL_DB_PASSWORD:+postgresql://");
    expect(compose).toContain("- OAUTH_ISSUER_URL=${OAUTH_ISSUER_URL:-}");
  });

  it("keeps Valkey behind a required password", () => {
    // The password reaches valkey-server on stdin, never on argv (secrets-out-of-argv.test.ts)
    expect(compose).toContain("REDISCLI_AUTH: ${VALKEY_PASSWORD:?");
    expect(compose).toContain(`printf 'requirepass %s\\n' "$$REDISCLI_AUTH"`);
  });

  it("the database and Valkey never listen beyond this machine", () => {
    expect(compose).toContain('"127.0.0.1:${DB_PORT:-5432}:5432"');
    expect(compose).toContain('"127.0.0.1:${VALKEY_PORT:-6379}:6379"');
  });
});

describe("what reaches the API by name", () => {
  it("nginx uses the service name, which does not change with the instance", () => {
    const conf = read("docker/nginx-admin.conf");
    expect(conf).toContain("proxy_pass http://kitsuden_api:3000;");
    expect(conf).not.toContain("kitsuden_api_prod");
  });

  it("so do Caddy and the TLS overlay", () => {
    expect(read("docker/Caddyfile")).not.toMatch(/kitsuden_(api|admin|web)_prod/);
    const tls = read("docker-compose.tls.yml");
    expect(tls).toContain("KITSUDEN_API_URL=http://kitsuden_api:3000");
    expect(tls.match(/^\s+container_name: (?!\$\{KITSUDEN_INSTANCE:-kitsuden\}_).*$/gm)).toBeNull();
  });
});

describe("creating an agent from the panel", () => {
  it("gives it permissions that allow using the tools: read only by default", () => {
    const view = read("packages/admin/src/views/system-tools/AgentsView.svelte");
    expect(view).toContain('let access = $state("read-only");');
    expect(view).toContain("scopes: [...(ACCESS_PRESETS.find(");
    expect(view).not.toContain('"full-admin"');
  });

  it("the API validates those permissions instead of ignoring them", () => {
    const route = read("apps/api/src/routes/agents-v1.ts");
    expect(route).toContain('validScopes = normalizeScopes(scopes ?? ["mcp:connect"]);');
    expect(route).toContain("scopes: validScopes,");
  });
});

describe("enabling a kon that is not installed", () => {
  it("answers 409 and says how, not 500 «migrations failed»", () => {
    const modules = read("apps/api/src/routes/modules.ts");
    expect(modules).toContain("if (!manifest && !konRoute(key))");
    expect(modules).toContain('error: "Kon not installed"');
  });
});

describe(".env.production.example", () => {
  const example = read(".env.production.example");

  it("has the DDL role to fill in: without it a kon cannot be enabled from the panel", () => {
    expect(example).toMatch(/^DDL_DB_PASSWORD=<openssl rand -hex 32>/m);
  });

  it("does not leave an example OAuth issuer active", () => {
    expect(example).not.toMatch(/^OAUTH_ISSUER_URL=/m);
  });

  it("every secret the installer has to fill in is one it knows how to generate", () => {
    for (const key of [
      "POSTGRES_PASSWORD",
      "APP_DB_PASSWORD",
      "DDL_DB_PASSWORD",
      "VALKEY_PASSWORD",
      "BETTER_AUTH_SECRET",
      "KITSUDEN_SECRETS_KEY",
      "SITE_API_KEY",
    ]) {
      expect(example, key).toMatch(new RegExp(`^${key}=<openssl rand -hex 32>`, "m"));
    }
  });
});

describe.each(["install.sh", "install.ps1"])("%s", (file) => {
  const script = read(file);

  it("does not start in a folder with its own deployment or someone else's .env", () => {
    expect(script).toContain("docker-compose.override.yml");
    expect(script).toContain("# Created by install.sh");
    expect(script).toContain("scripts/deploy.sh");
  });

  it("picks its own instance and images: it does not reuse another install's", () => {
    expect(script).toContain("KITSUDEN_INSTANCE=$instance");
    expect(script).toContain("KITSUDEN_API_IMAGE=$instance/api:latest");
    expect(script).toContain("KITSUDEN_ADMIN_IMAGE=$instance/admin:latest");
    expect(script).toContain("_postgres_prod");
  });

  it("always uses -f docker-compose.yml: an override must not slip in", () => {
    expect(script).toContain("docker compose -f docker-compose.yml");
  });

  it("builds locally, because nothing is published to a registry yet", () => {
    expect(script).toMatch(/build kitsuden_api/);
    expect(script).toMatch(/build kitsuden_admin/);
    expect(script).not.toMatch(/docker (compose .* )?pull/);
  });

  it("tells the user where the setup token is", () => {
    expect(script).toContain("one-time setup token");
    expect(script).toContain("/api/system/init-check");
    expect(script).toContain("No administrator");
  });

  it("is in English and ASCII: Windows PowerShell reads it in the system code page", () => {
    expect([...script].filter((c) => c.charCodeAt(0) > 126)).toEqual([]);
  });
});

describe("install.sh in the repository", () => {
  it("has no CRLF: bash would read the CR as part of each command", () => {
    expect(readFileSync(join(root, "install.sh")).indexOf("\r\n")).toBe(-1);
  });

  it.skipIf(!existsSync(join(root, ".git")))(
    "is executable, so ./install.sh works on Linux",
    () => {
      const entry = execFileSync("git", ["ls-files", "-s", "install.sh"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(entry).toMatch(/^100755 /);
    }
  );
});

// `bash` on Windows may be WSL's, which does not understand these paths: only Git Bash.
const bashKind = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8" }).stdout ?? "";
const hasBash = process.platform === "win32" ? /MINGW|MSYS/.test(bashKind) : bashKind !== "";

// Each one spawns bash and probes ports, which is slow on a loaded Windows machine.
const DRY_RUN_TIMEOUT_MS = 90_000;

describe.skipIf(!hasBash)("install.sh --dry-run, with a fake docker", () => {
  /** Answers questions and refuses anything that would build or start. */
  const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1 $2" in
  "compose version" | "info "*) exit 0 ;;
  "ps -a") printf '%s\\n' kitsuden_db_prod other_container; exit 0 ;;
  "volume inspect") [ "$3" = kitsuden_postgres_prod ] && exit 0; exit 1 ;;
esac
echo "fake docker: refused: $*" >&2
exit 99
`;

  function dryRun(extraEnv: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "kitsuden-install-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "docker"), FAKE_DOCKER);
      chmodSync(join(bin, "docker"), 0o755);
      copyFileSync(join(root, "install.sh"), join(dir, "install.sh"));
      copyFileSync(join(root, ".env.production.example"), join(dir, ".env.production.example"));
      const { DATABASE_URL: _unused, ...env } = process.env;
      const r = spawnSync("bash", ["./install.sh", "--dry-run"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...extraEnv },
      });
      const envFile = existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : "";
      return { ...r, envFile };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it(
    "avoids an instance that exists, fills in every secret and leaves no placeholder",
    { timeout: DRY_RUN_TIMEOUT_MS },
    () => {
      const { status, stdout, stderr, envFile } = dryRun();
      expect(stderr).toBe("");
      expect(status).toBe(0);
      expect(stdout).toContain("kitsuden2");
      expect(envFile).toMatch(/^KITSUDEN_INSTANCE=kitsuden2$/m);
      expect(envFile).toMatch(/^COMPOSE_PROJECT_NAME=kitsuden2$/m);
      expect(envFile).toMatch(/^KITSUDEN_API_IMAGE=kitsuden2\/api:latest$/m);
      expect(envFile).not.toMatch(/^[A-Z_]+=</m);
      for (const key of [
        "POSTGRES_PASSWORD",
        "APP_DB_PASSWORD",
        "DDL_DB_PASSWORD",
        "VALKEY_PASSWORD",
      ]) {
        expect(envFile, key).toMatch(new RegExp(`^${key}=[0-9a-f]{64}$`, "m"));
      }
      expect(envFile).toMatch(/^KITSUDEN_SIGNUP=closed$/m);
      expect(envFile.includes("\r")).toBe(false);
    }
  );

  it("uses KITSUDEN_INSTANCE when it is given", { timeout: DRY_RUN_TIMEOUT_MS }, () => {
    const given = dryRun({ KITSUDEN_INSTANCE: "second" });
    expect(given.status).toBe(0);
    expect(given.envFile).toMatch(/^KITSUDEN_INSTANCE=second$/m);
  });

  it("refuses an instance that exists", { timeout: DRY_RUN_TIMEOUT_MS }, () => {
    const taken = dryRun({ KITSUDEN_INSTANCE: "kitsuden" });
    expect(taken.status).not.toBe(0);
    expect(taken.stderr).toContain("already exists");
    expect(taken.envFile).toBe("");
  });

  it("refuses an instance name compose would not accept", { timeout: DRY_RUN_TIMEOUT_MS }, () => {
    const { status, stderr } = dryRun({ KITSUDEN_INSTANCE: "Has Spaces" });
    expect(status).not.toBe(0);
    expect(stderr).toContain("KITSUDEN_INSTANCE");
  });
});
