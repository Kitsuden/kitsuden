/**
 * `npm create kitsuden` (packages/create-kitsuden): scaffolds into a temp folder,
 * offline, and checks the files, the secrets and that the production `.env` is the
 * one install.sh would write.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  composeForImages,
  INSTALL_MARKER,
  instanceFromName,
  renderProductionEnv,
  scaffold,
  secret,
  TEMPLATE_FILES,
  VERSION,
} from "../../packages/create-kitsuden/src/index.mjs";

const ROOT = resolve(__dirname, "../..");
const PKG = join(ROOT, "packages/create-kitsuden");
const BIN = join(PKG, "bin/create-kitsuden.mjs");
const tmp = mkdtempSync(join(tmpdir(), "create-kitsuden-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PORTS = { api: 13000, admin: 13001, db: 15432, valkey: 16379 };
const HEX64 = /^[0-9a-f]{64}$/;
const EXAMPLE = readFileSync(join(ROOT, ".env.production.example"), "utf8");
const INSTALL_SH = readFileSync(join(ROOT, "install.sh"), "utf8");

function envOf(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const hit = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (hit) m.set(hit[1]!, hit[2]!);
  }
  return m;
}

/** The keys install.sh generates (`=<openssl rand -hex 32>` in the example). */
const SECRET_KEYS = [...EXAMPLE.matchAll(/^([A-Z_]+)=<openssl rand -hex 32>\s*$/gm)].map(
  (m) => m[1]!
);

describe("secrets", () => {
  it("are 32 random bytes in hex and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const s = secret();
      expect(s).toMatch(HEX64);
      seen.add(s);
    }
    expect(seen.size).toBe(1000);
  });
});

describe("the production .env is the one install.sh writes", () => {
  const text = renderProductionEnv(EXAMPLE, {
    instance: "demo",
    ports: PORTS,
    apiImage: "r/api:1",
    adminImage: "r/admin:1",
  });
  const env = envOf(text);

  it("carries install.sh's marker, so install.sh accepts it", () => {
    const marker = INSTALL_SH.match(/^MARKER="(.+)"$/m)?.[1];
    expect(marker).toBe(INSTALL_MARKER);
    expect(text.split("\n")[0]).toContain(marker!);
    expect(readFileSync(join(ROOT, "install.ps1"), "utf8")).toContain(`'${INSTALL_MARKER}'`);
  });

  it("generates every secret the example asks for, each different", () => {
    expect(SECRET_KEYS.length).toBeGreaterThanOrEqual(6);
    const values = SECRET_KEYS.map((k) => env.get(k));
    for (const v of values) expect(v).toMatch(HEX64);
    expect(new Set(values).size).toBe(values.length);
    expect(text).not.toMatch(/^[A-Z_]+=</m);
  });

  it("empties the site fields and names the instance", () => {
    for (const k of ["SITE_DOMAIN", "ACME_EMAIL", "MAIL_FROM"]) expect(env.get(k)).toBe("");
    expect(env.get("COMPOSE_PROJECT_NAME")).toBe("demo");
    expect(env.get("KITSUDEN_INSTANCE")).toBe("demo");
    expect(env.get("KITSUDEN_API_IMAGE")).toBe("r/api:1");
    expect(env.get("ALLOWED_ORIGINS")).toBe(
      "http://localhost:13001,http://127.0.0.1:13001,http://localhost:13000,http://127.0.0.1:13000"
    );
  });

  it("appends the same 'this machine' keys as install.sh, in the same order", () => {
    const block = INSTALL_SH.split("# --- This machine (install.sh) ---")[1]!.split("\nEOF")[0]!;
    const fromSh = [...block.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
    const ours = text.split("# --- This machine (install.sh) ---")[1]!;
    expect([...ours.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1])).toEqual(fromSh);
  });

  it("keeps every line of the example (CRLF too)", () => {
    const crlf = renderProductionEnv(EXAMPLE.replaceAll("\n", "\r\n"), {
      instance: "demo",
      ports: PORTS,
      apiImage: "a",
      adminImage: "b",
    });
    expect(crlf).not.toContain("\r");
    const lines = EXAMPLE.split("\n").filter(Boolean).length;
    // The marker line, then the "this machine" header and its 11 keys.
    expect(text.split("\n").filter(Boolean).length).toBe(lines + 1 + 12);
  });

  it("refuses a placeholder it does not know", () => {
    expect(() =>
      renderProductionEnv(`${EXAMPLE}NEW_THING=<fill me>\n`, {
        instance: "d",
        ports: PORTS,
        apiImage: "a",
        adminImage: "b",
      })
    ).toThrow(/placeholder/);
  });
});

describe("docker mode", () => {
  const dir = join(tmp, "My App");

  it("writes the project offline, with the published images and no build", async () => {
    const r = await scaffold({ dir, ports: PORTS, probe: false });
    expect(r.instance).toBe("my-app");
    for (const f of ["docker-compose.yml", ".env", ".env.production.example", ".gitignore"])
      expect(existsSync(join(dir, f)), f).toBe(true);
    for (const f of TEMPLATE_FILES.filter((f) => f.startsWith("docker/")))
      expect(readFileSync(join(dir, f), "utf8")).toBe(readFileSync(join(ROOT, f), "utf8"));

    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf8");
    expect(compose).not.toMatch(/^ {4}build:/m);
    expect(compose).not.toMatch(/dockerfile:/);
    // Our images come from our registry, pinned to this release: compose pulls them.
    expect(compose).not.toMatch(/pull_policy: never/);
    expect(compose.match(/pull_policy: missing/g)).toHaveLength(3);
    expect(compose).not.toContain("kitsuden/api:latest");
    expect(compose).toContain(
      "${KITSUDEN_API_IMAGE:-ghcr.io/kitsuden/kitsuden/api:" + VERSION + "}"
    );
    expect(compose).toContain("container_name: ${KITSUDEN_INSTANCE:-kitsuden}_api_prod");
    expect(compose).toContain("container_name: ${KITSUDEN_INSTANCE:-kitsuden}_admin_prod");

    const env = envOf(readFileSync(join(dir, ".env"), "utf8"));
    expect(env.get("KITSUDEN_API_IMAGE")).toBe(`ghcr.io/kitsuden/kitsuden/api:${VERSION}`);
    expect(env.get("KITSUDEN_ADMIN_IMAGE")).toBe(`ghcr.io/kitsuden/kitsuden/admin:${VERSION}`);
    expect(env.get("API_PORT")).toBe("13000");
    for (const k of SECRET_KEYS) expect(env.get(k)).toMatch(HEX64);
    if (process.platform !== "win32") expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".env");
    expect(r.next.join("\n")).toContain("downloads ghcr.io/kitsuden/kitsuden/api:");
    expect(r.next.join("\n")).not.toContain("docker pull");
  });

  it("two projects never share a secret", async () => {
    const other = join(tmp, "second");
    await scaffold({ dir: other, ports: PORTS, probe: false });
    const a = envOf(readFileSync(join(dir, ".env"), "utf8"));
    const b = envOf(readFileSync(join(other, ".env"), "utf8"));
    for (const k of SECRET_KEYS) expect(a.get(k)).not.toBe(b.get(k));
  });

  it("overwrites nothing", async () => {
    await expect(scaffold({ dir, ports: PORTS, probe: false })).rejects.toThrow(/not empty/);
  });

  it("removes only the build sections", () => {
    const src = [
      "services:",
      "  api:",
      "    image: x",
      "    build:",
      "      context: .",
      "      # comment",
      "",
      "      args:",
      "        A: b",
      "    container_name: c",
      "  admin:",
      "    build:",
      "      context: .",
      "    ports: []",
      "",
    ].join("\n");
    const out = composeForImages(src, "1");
    expect(out).toContain("    image: x\n    container_name: c\n  admin:\n    ports: []");
    expect(out).not.toContain("context");
  });

  it("pulls only our own images; any other service keeps never", () => {
    const src = [
      "services:",
      "  api:",
      "    image: ${KITSUDEN_API_IMAGE:-ghcr.io/kitsuden/kitsuden/api:latest}",
      "    pull_policy: never",
      "  other:",
      "    image: someone/else:latest",
      "    pull_policy: never",
      "",
    ].join("\n");
    const out = composeForImages(src, "2.0.0");
    expect(out).toContain(
      [
        "    image: ${KITSUDEN_API_IMAGE:-ghcr.io/kitsuden/kitsuden/api:2.0.0}",
        "    pull_policy: missing",
        "  other:",
        "    image: someone/else:latest",
        "    pull_policy: never",
      ].join("\n")
    );
  });

  it("names the instance like install.sh allows", () => {
    expect(instanceFromName("My App!")).toBe("my-app");
    expect(instanceFromName("--x")).toBe("x");
    expect(instanceFromName("***")).toBe("kitsuden");
  });
});

describe("local mode", () => {
  /** The two files of a checkout that the local mode reads. */
  function fakeCheckout(d: string) {
    mkdirSync(join(d, "apps/api"), { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "kitsuden-cms" }));
    writeFileSync(
      join(d, "apps/api/.env.example"),
      readFileSync(join(ROOT, "apps/api/.env.example"), "utf8")
    );
  }

  it("fills in apps/api/.env and the dev compose .env of a checkout, consistently", async () => {
    const d = join(tmp, "checkout");
    fakeCheckout(d);
    const r = await scaffold({ dir: d, mode: "local", ports: PORTS, probe: false });
    expect(r.cloned).toBe(false);
    expect(r.files).toEqual([".env", "apps/api/.env"]);
    const root = envOf(readFileSync(join(d, ".env"), "utf8"));
    const api = envOf(readFileSync(join(d, "apps/api/.env"), "utf8"));
    expect(root.get("POSTGRES_PASSWORD")).toMatch(HEX64);
    expect(api.get("DATABASE_URL")).toBe(
      `postgres://kitsuden:${root.get("POSTGRES_PASSWORD")}@localhost:15432/kitsuden_dev`
    );
    expect(api.get("BETTER_AUTH_SECRET")).toMatch(HEX64);
    expect(api.get("KITSUDEN_SECRETS_KEY")).toMatch(HEX64);
    expect(api.get("BETTER_AUTH_SECRET")).not.toBe(api.get("KITSUDEN_SECRETS_KEY"));
    expect(api.get("S3_SECRET_KEY")).toBe(root.get("S3_SECRET_KEY"));
    expect(api.get("PORT")).toBe("13000");
    expect(readFileSync(join(d, "apps/api/.env"), "utf8")).not.toMatch(/<[A-Z0-9_]+>/);
    // Its own dev containers and database: named after the checkout's folder.
    expect(r.instance).toBe("checkout");
    expect(root.get("KITSUDEN_INSTANCE")).toBe("checkout");

    // Run again: what exists is kept.
    const before = readFileSync(join(d, "apps/api/.env"), "utf8");
    const again = await scaffold({ dir: d, mode: "local", ports: PORTS, probe: false });
    expect(again.kept).toEqual([".env", "apps/api/.env"]);
    expect(readFileSync(join(d, "apps/api/.env"), "utf8")).toBe(before);
  });

  const git = spawnSync("git", ["--version"]).status === 0;
  it.skipIf(!git)(
    "clones from a local checkout, offline",
    async () => {
      const src = join(tmp, "source");
      fakeCheckout(src);
      const g = (...a: string[]) =>
        expect(
          spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: src }).status
        ).toBe(0);
      g("init", "-q");
      g("add", ".");
      g("commit", "-q", "-m", "x");
      const d = join(tmp, "cloned");
      const r = await scaffold({ dir: d, mode: "local", source: src, ports: PORTS, probe: false });
      expect(r.cloned).toBe(true);
      expect(existsSync(join(d, "apps/api/.env"))).toBe(true);
    },
    60_000
  );
});

describe("the command", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd: tmp, encoding: "utf8", timeout: 60_000 });

  it("scaffolds without asking with --yes, in seconds", () => {
    const started = Date.now();
    const r = run(
      "cli-app",
      "--yes",
      "--skip-checks",
      "--api-port=13000",
      "--admin-port=13001",
      "--image-tag=1.2.3"
    );
    expect(r.status, r.stderr).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.stdout).toContain("Next:");
    expect(r.stdout).toContain("downloads ghcr.io/kitsuden/kitsuden/api:1.2.3");
    expect(envOf(readFileSync(join(tmp, "cli-app/.env"), "utf8")).get("ADMIN_PORT")).toBe("13001");
  });

  it("explains itself and rejects what it does not know", () => {
    expect(run("--help").stdout).toContain("--mode <docker|local>");
    expect(run("x", "--bogus").status).toBe(2);
    const bad = run("y", "--yes", "--mode=cloud");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown mode/);
    expect(run("z", "--yes", "--api-port=99999").status).toBe(1);
  });

  it("packs its templates for the published package", () => {
    const out = join(tmp, "packed");
    const r = spawnSync(process.execPath, [join(PKG, "scripts/sync-templates.mjs"), out], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    for (const f of TEMPLATE_FILES) expect(existsSync(join(out, f)), f).toBe(true);
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    expect(pkg.bin["create-kitsuden"]).toBe("./bin/create-kitsuden.mjs");
    expect(pkg.files).toContain("templates");
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
