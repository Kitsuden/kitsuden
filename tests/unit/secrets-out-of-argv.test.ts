/**
 * Secrets stay out of command lines, and CI runs only pinned actions
 * ============================================================================
 *
 * Security review 2026-11-03:
 *
 * - `valkey-server --requirepass <secret>` and `psql "postgresql://u:<secret>@…"`
 *   put the password in the process's argv, which any user on the host reads
 *   with `ps`. Valkey now reads `requirepass` on stdin; psql gets PGPASSWORD
 *   and a URL without a password.
 * - `ci.yml` used actions pinned by tag in jobs that receive secrets. A tag can
 *   be moved by whoever controls the action's repository; a commit SHA cannot.
 *
 * Checked by reading the files: running them would need Docker or GitHub.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("passwords never reach argv", () => {
  it("Valkey in the production compose reads requirepass on stdin", () => {
    const compose = read("docker-compose.yml");
    expect(compose).not.toMatch(/--requirepass\s+\$/);
    expect(compose).toContain(`printf 'requirepass %s\\n' "$$REDISCLI_AUTH"`);
    // `-` must be the LAST argument: valkey only reads stdin there (or first).
    expect(compose).toMatch(/--appendonly yes -\n/);
  });

  it("start-with-check.sh never passes a URL with a password to psql", () => {
    const script = read("docker/start-with-check.sh");
    const calls = script
      .split("\n")
      .filter((l) => /\bpsql\s+"\$/.test(l) && !/^\s*(#|echo)/.test(l));
    // The only direct psql is the wrapper, which forwards its arguments.
    expect(calls.map((l) => l.trim())).toEqual(['PGPASSWORD="$DB_PASS_PLAIN" psql "$@"']);
    expect(script).toMatch(/ADMIN_DB_URL="postgresql:\/\/\$\{DB_USER\}@/);
    expect(script).not.toMatch(/pg_admin "\$DB_ADMIN_URL"/);
    // PGPASSWORD is set per call, never exported to the API started at the end.
    expect(script).not.toMatch(/export\s+PGPASSWORD/);
  });
});

describe("GitHub Actions are pinned to a commit", () => {
  const dir = join(ROOT, ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it.each(files)("%s", (file) => {
    const text = readFileSync(join(dir, file), "utf8");
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    const unpinned = uses.filter((u) => !u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u));
    expect(unpinned).toEqual([]);
  });
});
