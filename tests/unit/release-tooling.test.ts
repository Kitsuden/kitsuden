/**
 * What a public repository must not drift back to: images and actions under names
 * nobody here owns, services open on the host, a panel without a CSP, publishing
 * without tests, and scripts that only run on one operating system.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseEnv, unsafeReason } from "../../scripts/test-db.mjs";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  description: string;
  repository: { url: string };
};

const IMAGES = "ghcr.io/kitsuden/kitsuden";

describe("root docker-compose.yml", () => {
  const compose = read("docker-compose.yml");

  it("Postgres and Valkey are on 127.0.0.1 whatever BIND_ADDRESS says", () => {
    expect(compose).toContain('"127.0.0.1:${DB_PORT:-5432}:5432"');
    expect(compose).toContain('"127.0.0.1:${VALKEY_PORT:-6379}:6379"');
  });

  it("Valkey requires a password, and the API uses it", () => {
    // On stdin, not on argv (`ps` shows argv): see secrets-out-of-argv.test.ts
    expect(compose).toContain(`printf 'requirepass %s\\n' "$$REDISCLI_AUTH"`);
    expect(compose).toContain("REDISCLI_AUTH: ${VALKEY_PASSWORD:?");
    expect(compose).toContain("REDIS_URL=redis://:${VALKEY_PASSWORD:?");
  });

  it("the images are ours and are never pulled", () => {
    expect(compose).not.toMatch(/:-kitsuden\/(api|admin|mcp):/);
    expect(compose).toContain(`${IMAGES}/api:latest`);
    expect(compose.match(/pull_policy: never/g)?.length).toBe(3);
  });

  it("no mention of the owner's setup or of removed services", () => {
    for (const file of ["docker-compose.yml", ".dockerignore", "docker/Dockerfile.prod"]) {
      const text = read(file);
      expect(text, file).not.toMatch(
        /propietario|auditor[ií]a|sitios privados|kitsuden_mcp|docs\/instalacion/i
      );
    }
  });
});

describe("panel", () => {
  const nginx = read("docker/nginx-admin.conf");
  const caddy = read("docker/Caddyfile");
  const csp = (text: string) => text.match(/default-src 'self'[^"]*/)?.[0];

  it("nginx and Caddy send the same Content-Security-Policy", () => {
    expect(csp(nginx)).toContain("object-src 'none'");
    expect(csp(nginx)).toContain("frame-ancestors 'self'");
    expect(csp(nginx)).toBe(csp(caddy));
  });

  it("'unsafe-eval' is there only while calculated fields use new Function", () => {
    const usesFunction = read(
      "packages/admin/src/lib/components/calculated-fields/index.ts"
    ).includes("new Function");
    expect(csp(nginx)!.includes("'unsafe-eval'")).toBe(usesFunction);
  });

  // Security review 2026-11-03: 'unsafe-eval', any inline script and
  // `connect-src https:` (any host) were allowed.
  it("no eval, connections to its own origin, and the inline script pinned by hash", () => {
    expect(csp(nginx)).not.toContain("'unsafe-eval'");
    expect(csp(nginx)).toMatch(/connect-src 'self';/);
    const svelteConfig = read("packages/admin/svelte.config.js");
    expect(svelteConfig).toMatch(/csp:\s*\{\s*mode:\s*"hash"/);
    expect(svelteConfig).toMatch(/"script-src":\s*\["self"/);
    // style-src must stay out of kit.csp: its hashes would switch off 'unsafe-inline'
    expect(svelteConfig).not.toMatch(/"style-src"/);
    expect(
      read("packages/admin/src/lib/components/calculated-fields/FormulaBuilder.svelte")
    ).not.toContain("new Function");
  });

  it("the image runs nginx without root, on the port everything else expects", () => {
    const dockerfile = read("docker/Dockerfile.prod");
    expect(dockerfile).toContain("FROM nginxinc/nginx-unprivileged:");
    expect(nginx).toContain("listen 8080;");
    expect(read("docker-compose.yml")).toContain(":${ADMIN_PORT:-3001}:8080");
    expect(caddy).toContain("kitsuden_admin:8080");
  });

  it("nginx keeps the port in Host, so the panel on 127.0.0.1:3001 passes the origin check", () => {
    expect(nginx).toContain("proxy_set_header Host $http_host;");
    expect(read("docker-compose.yml")).toContain("http://127.0.0.1:3001}");
  });
});

describe("compose files for development and tests", () => {
  it.each(["docker-compose.dev.yml", "docker-compose.test.yml"])(
    "%s pins every image by digest",
    (file) => {
      const images = [...read(file).matchAll(/^\s+image: (.+)$/gm)].map((m) => m[1]!);
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) expect(image, image).toMatch(/:[\w.-]+@sha256:[0-9a-f]{64}$/);
    }
  );
});

describe("workflows", () => {
  const publish = read(".github/workflows/publish.yml");
  const docker = read(".github/workflows/docker-publish.yml");

  it.each([
    ["publish.yml", publish],
    ["docker-publish.yml", docker],
  ])(
    "%s runs the CI and the security scans first, only on v* tags or by hand, with actions pinned by commit",
    (_name, text) => {
      expect(text).toContain("uses: ./.github/workflows/ci.yml");
      expect(text).toContain("uses: ./.github/workflows/security.yml");
      expect(text).toContain("needs: [ci, security]");
      expect(text).toMatch(/tags:\s*\[?\s*(\n\s*- )?"v\*"/);
      expect(text).not.toMatch(/branches:/);
      const external = [...text.matchAll(/uses: ([^\s]+)/g)]
        .map((m) => m[1]!)
        .filter((u) => !u.startsWith("./"));
      expect(external.length).toBeGreaterThan(0);
      for (const use of external) expect(use, use).toMatch(/@[0-9a-f]{40}$/);
      expect(text).not.toMatch(/gremius/i);
    }
  );

  it("the npm job has what pnpm publish needs", () => {
    expect(publish).toContain("oven-sh/setup-bun");
    expect(publish).toContain('NODE_VERSION: "22"');
    expect(publish).toContain("publish --access public");
    expect(publish).not.toMatch(/^s+(run: )?npm publish/m);
  });
});

describe("root package.json", () => {
  it("describes the product and points at its repository", () => {
    expect(pkg.description).not.toMatch(/gaming|cms/i);
    expect(pkg.repository.url).toContain("github.com/Kitsuden/kitsuden");
  });

  it("no script needs PowerShell or rm, or pushes to a namespace we do not own", () => {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).not.toMatch(/powershell|\brm -rf\b/);
      expect(script, name).not.toMatch(/docker push/);
      expect(script, name).not.toMatch(/(^|\s)kitsuden\/(api|admin|mcp)/);
    }
  });

  it("every file a script runs exists", () => {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      for (const m of script.matchAll(/\bnode ((?:scripts|packages)\/[\w./-]+)/g)) {
        if (m[1]!.includes("/dist/")) continue; // built output
        expect(existsSync(join(ROOT, m[1]!)), `${name}: ${m[1]}`).toBe(true);
      }
      for (const m of script.matchAll(/ -f (docker[\w./-]+)/g)) {
        expect(existsSync(join(ROOT, m[1]!)), `${name}: ${m[1]}`).toBe(true);
      }
    }
  });
});

describe("publishable packages", () => {
  function manifests(): Array<[string, Record<string, unknown>]> {
    const out: Array<[string, Record<string, unknown>]> = [];
    for (const base of ["apps", "packages", "packages/core"]) {
      for (const name of readdirSync(join(ROOT, base))) {
        const file = join(ROOT, base, name, "package.json");
        if (statSync(join(ROOT, base, name)).isDirectory() && existsSync(file)) {
          out.push([`${base}/${name}`, JSON.parse(readFileSync(file, "utf8"))]);
        }
      }
    }
    return out;
  }

  it("each has a license, a repository and a description", () => {
    const missing = manifests()
      .filter(([, p]) => !p.private)
      .filter(([, p]) => !p.license || !p.repository || !p.description)
      .map(([dir]) => dir);
    expect(missing).toEqual([]);
  });

  it("none depends on a private workspace package", () => {
    const all = manifests();
    const privateNames = new Set(all.filter(([, p]) => p.private).map(([, p]) => p.name));
    const offenders: string[] = [];
    for (const [dir, p] of all) {
      if (p.private) continue;
      for (const dep of Object.keys((p.dependencies ?? {}) as object)) {
        if (privateNames.has(dep)) offenders.push(`${dir} -> ${dep}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("scripts/test-db.mjs", () => {
  it("parses KEY=value lines without printing anything", () => {
    expect(parseEnv("# comment\nA=1\nB = 'two'\r\nC=\"3\"\n")).toEqual({
      A: "1",
      B: "two",
      C: "3",
    });
  });

  it("accepts what .env.test.example ships", () => {
    expect(unsafeReason(parseEnv(read(".env.test.example")))).toBeNull();
  });

  it.each([
    [{ POSTGRES_DB: "kitsuden_dev" }, /test/],
    [{ POSTGRES_DB: "kitsuden_prod_test" }, /prod/],
    [{ POSTGRES_PORT: "5432" }, /5432/],
    [{ DATABASE_URL: "postgres://u:p@127.0.0.1:5434/kitsuden_prod" }, /test database/],
    [{ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/kitsuden_test" }, /test port/],
    [{ DATABASE_URL: "postgres://u:p@db.example.com:5434/kitsuden_test" }, /this machine/],
    [{ DATABASE_URL: "not a url" }, /not a URL/],
  ])("refuses %j", (env, reason) => {
    expect(unsafeReason(env)).toMatch(reason);
  });
});

describe("grimoires and old names", () => {
  it("grimoire-gremius is gone", () => {
    expect(existsSync(join(ROOT, "packages/grimoires/grimoire-gremius"))).toBe(false);
  });

  it("the CLI and the scripts do not use the old brand", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/gremius|gremus|\bGREM_/i.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(ROOT, "packages/cli/src"));
    walk(join(ROOT, "packages/cli/templates"));
    walk(join(ROOT, "scripts"));
    expect(offenders).toEqual([]);
  });
});
