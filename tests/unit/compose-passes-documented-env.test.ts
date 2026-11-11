/**
 * A variable documented for the Docker install has to reach a container
 * ============================================================================
 *
 * `docker-compose.yml` has no `env_file`: a container sees only what its
 * `environment:` lists. `.env.production.example` documented `KITSUDEN_ADMIN_MFA`,
 * `ENABLE_CODE_ACTIONS` and the sandbox, webhook, customer-data and external-MCP
 * allow-lists, and no compose file named any of them. Setting
 * `KITSUDEN_ADMIN_MFA=required` in `.env` left two-factor sign-in optional, with
 * no error anywhere: the API never saw the variable.
 *
 * So: every key of the template (and of the Docker table in variables.md) is
 * interpolated by a compose file of the production stack, or it is in the short
 * list below with the reason it is not.
 *
 * Compose passes an unset variable as an EMPTY string (`${NAME:-}`), so each
 * reader has to treat "" as unset. The readers were checked when the variables
 * were added; the one that decides a security setting is pinned here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adminMfaMode } from "../../apps/api/src/lib/admin-mfa";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

/** The compose files of the production stack: the base and its overlays. */
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.tls.yml",
  "docker-compose.replica.yml",
];
const compose = Object.fromEntries(COMPOSE_FILES.map((f) => [f, read(f)]));

/** `${NAME}`, `${NAME:-default}`, `${NAME:?message}`, `${NAME:+value}`. */
const interpolates = (text: string, name: string) =>
  new RegExp(`\\$\\{${name}(?:[:?+}-])`).test(text);
const passedBy = (name: string) => COMPOSE_FILES.filter((f) => interpolates(compose[f]!, name));

/** Documented, and on purpose not interpolated by any compose file. */
const NOT_INTERPOLATED: Record<string, string> = {
  COMPOSE_PROJECT_NAME:
    "read by `docker compose` itself: it names the project and the media volume",
  KITSUDEN_OVERLAYS: "read by scripts/deploy.sh only: the extra compose files it adds",
};

/** `NAME=value` and the commented examples (`# NAME=value`) of an env template. */
function templateKeys(file: string): string[] {
  const keys = new Set<string>();
  for (const line of read(file).split(/\r?\n/)) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return [...keys].sort();
}

/** The names in the first column of the "Docker server" table of variables.md. */
function documentedDockerKeys(): string[] {
  const text = read("docs/install/variables.md");
  const start = text.indexOf("## Docker server");
  const end = text.indexOf("\n## ", start + 1);
  expect(start).toBeGreaterThan(-1);
  const keys = new Set<string>();
  for (const line of text.slice(start, end).split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const m of firstCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) keys.add(m[1]!);
  }
  return [...keys].sort();
}

/** One service of a compose file, from its name to the next top-level key. */
function service(file: string, name: string): string {
  const lines = compose[file]!.split(/\r?\n/);
  const from = lines.indexOf(`  ${name}:`);
  expect(from, `${file} has no service ${name}`).toBeGreaterThan(-1);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^ {0,2}[A-Za-z_]/.test(l));
  return rest.slice(0, to === -1 ? undefined : to).join("\n");
}

describe("the Docker stack passes what its template documents", () => {
  it("no compose file loads .env into a container wholesale", () => {
    // If one ever does, this whole test stops meaning anything: rethink it then.
    for (const f of COMPOSE_FILES) expect(compose[f], f).not.toMatch(/^\s*env_file:/m);
  });

  it("every key of .env.production.example is interpolated by a compose file", () => {
    const keys = templateKeys(".env.production.example");
    expect(keys.length).toBeGreaterThan(40);
    const lost = keys.filter((k) => !(k in NOT_INTERPOLATED) && passedBy(k).length === 0);
    expect(
      lost,
      "documented in .env.production.example but no compose file passes them: add " +
        "`- NAME=${NAME:-}` to the service that reads each one, or list it in NOT_INTERPOLATED " +
        "with the reason"
    ).toEqual([]);
  });

  it("every variable of the Docker table in variables.md is interpolated too", () => {
    const keys = documentedDockerKeys();
    expect(keys.length).toBeGreaterThan(40);
    const lost = keys.filter((k) => !(k in NOT_INTERPOLATED) && passedBy(k).length === 0);
    expect(lost, "in the Docker table of docs/install/variables.md, in no compose file").toEqual(
      []
    );
  });

  it("the exceptions are real: documented, and still not interpolated", () => {
    const documented = new Set([
      ...templateKeys(".env.production.example"),
      ...documentedDockerKeys(),
    ]);
    for (const [name, reason] of Object.entries(NOT_INTERPOLATED)) {
      expect(documented.has(name), `${name} is no longer documented: drop it`).toBe(true);
      expect(passedBy(name), `${name} is interpolated now: drop it`).toEqual([]);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("what the API reads is in the API's environment, not just somewhere in the file", () => {
    const api = service("docker-compose.yml", "kitsuden_api");
    for (const name of [
      "KITSUDEN_ADMIN_MFA",
      "KITSUDEN_SIGNUP",
      "ENABLE_CODE_ACTIONS",
      "KITSUDEN_SANDBOX_FETCH_ALLOW",
      "KITSUDEN_SANDBOX_ALLOW_INTERNAL_FETCH",
      "KITSUDEN_WEBHOOK_ALLOW_INTERNAL",
      "KITSUDEN_CUSTOMER_DATA_HOSTS",
      "KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL",
      "PAYMENTS_ALLOWED_PLANS",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
      "AZURE_AD_CLIENT_ID",
      "AZURE_AD_CLIENT_SECRET",
      "AZURE_AD_TENANT_ID",
    ]) {
      // `:-` and nothing after it: an unset variable arrives empty, never as a placeholder.
      expect(api, name).toContain(`- ${name}=\${${name}:-}`);
    }
    // The database's own setting goes to the database.
    expect(service("docker-compose.yml", "kitsuden_db")).toContain("PG_MAX_SLOT_WAL_KEEP_SIZE:");
  });

  it("an empty KITSUDEN_ADMIN_MFA is the default, not a typo that turns it on", () => {
    // Compose passes "" when .env does not set it. Any OTHER unknown value means required.
    expect(adminMfaMode({ KITSUDEN_ADMIN_MFA: "" })).toBe("optional");
    expect(adminMfaMode({})).toBe("optional");
    expect(adminMfaMode({ KITSUDEN_ADMIN_MFA: "required" })).toBe("required");
  });
});
