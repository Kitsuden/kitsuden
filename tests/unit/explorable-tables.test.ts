/**
 * The generic explorer does not reach platform tables
 * ============================================================================
 *
 * `/api/explorer/*` was protected only with `requireAuth` —which checks that
 * there is a session and nothing else; the roles are `admin`, `editor` and `user`— and its
 * `resolveTable()` fell back to dynamic introspection, so it resolved ANY
 * table. Measured on the real installation before closing it:
 *
 *     kitsuden_secrets      resolves (13 columns)
 *     auth_accounts         resolves (13 columns)   ← credentials
 *     api_keys              resolves (8 columns)
 *     kitsuden_migrations   resolves (5 columns)
 *
 * With `PATCH`, `POST` and `DELETE` on the same router. An `editor` could read and
 * write the secrets, the credentials and the migration history —and
 * editing `kitsuden_migrations` from the browser silently desyncs history and
 * schema, which is the failure that cost an entire day of diagnosis.
 *
 * ── WHAT THIS TEST GUARDS ──────────────────────────────────────────────────
 *
 * Three things, and none is the symptom:
 *
 *   1. That the blocklist keeps covering what must never get out.
 *   2. That the policy is applied where the table is RESOLVED, which is the point
 *      every route goes through. Checking handler by handler would miss
 *      the one added tomorrow.
 *   3. That no route enumerates tables again without filtering them: a 404 that
 *      lists what exists is an index of the database.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const POLICY = join(ROOT, "apps", "api", "src", "lib", "explorable-tables.ts");
const EXPLORER = join(ROOT, "apps", "api", "src", "routes", "data-explorer.ts");

/** What can never be reached through the generic explorer. */
const MUST_BE_FORBIDDEN = [
  "kitsuden_secrets",
  "auth_accounts",
  "auth_sessions",
  "auth_verifications",
  "api_keys",
  "agent_api_keys",
  "kitsuden_migrations",
  "rate_limit_logs",
];

describe("tables reachable by the explorer", () => {
  const policy = readFileSync(POLICY, "utf-8");
  const explorer = withoutComments(readFileSync(EXPLORER, "utf-8"));

  it("the blocklist covers credentials, secrets and history", () => {
    const absent = MUST_BE_FORBIDDEN.filter((t) => !policy.includes(`"${t}"`));

    expect(
      absent,
      `These tables are no longer in FORBIDDEN_TABLES:\n\n${absent.join("\n")}\n\n` +
        `None makes sense behind a generic grid: they are either secrets, ` +
        `or the internal record of something that is managed through its own ` +
        `screen. Editing kitsuden_migrations from the browser desyncs ` +
        `history and schema without anything warning about it.`
    ).toEqual([]);
  });

  it("resolveTable consults the policy before introspecting", () => {
    /**
     * Order matters: the check has to come BEFORE
     * `introspectTable`. Afterwards it would still filter the result, but the
     * work would already be done and the next person to reorder the block would open the
     * hole without realizing it.
     */
    const body = explorer.slice(
      explorer.indexOf("async function resolveTable"),
      explorer.indexOf("function humanizeTableNameLocal")
    );

    expect(body.length, "resolveTable was not found").toBeGreaterThan(0);

    const iPolicy = body.indexOf("tableIsExplorable");
    const iIntrospect = body.indexOf("introspectTable");

    expect(iPolicy, "resolveTable no longer consults tableIsExplorable").toBeGreaterThan(-1);
    expect(
      iIntrospect === -1 || iPolicy < iIntrospect,
      "the policy check has to come BEFORE introspecting the table"
    ).toBe(true);
  });

  it("sensitive writes require the admin role", () => {
    // The three mutation routes have to go through the guard. They are counted
    // because there are exactly three: PATCH, POST and DELETE.
    const usages = [...explorer.matchAll(/denySensitiveWrite\(/g)].length;

    expect(
      usages,
      "every write route of the explorer (PATCH, POST, DELETE) has to " +
        "call `denySensitiveWrite`: modifying auth_users changes roles " +
        "and modifying modules installs kons."
    ).toBeGreaterThanOrEqual(4); // 3 calls + the definition
  });

  it("no response enumerates tables without filtering", () => {
    /**
     * `getAllTables()` returns the whole database. It appeared raw in the `available`
     * list of a 404 and in `/tables`, so a «not
     * found» message was an index of everything there is, secrets included.
     */
    for (const m of explorer.matchAll(/getAllTables\(\)/g)) {
      // We look FORWARD to the end of the handler: the filtering happens
      // after fetching the list, sometimes dozens of lines further down (in
      // `/discover/:konId` three sources are crossed before filtering).
      const from = m.index!;
      const finHandler = explorer.indexOf("\nexplorerRoutes.", from);
      const context = explorer.slice(from, finHandler === -1 ? undefined : finHandler);

      const line = explorer.slice(0, from).split("\n").length;
      expect(
        context.includes("tableIsExplorable"),
        `This use of getAllTables() in data-explorer.ts:${line} is not filtered by ` +
          `the policy before responding. Listing the whole database turns ` +
          `any response into an index of the tables that exist, secrets ` +
          `incluidos.`
      ).toBe(true);
    }
  });
});
