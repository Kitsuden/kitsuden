/**
 * Authorization matrix: no route is born open unless someone decides so.
 * ============================================================================
 *
 * Two parts:
 *
 *  1. ALWAYS: the `MATRIX` table (apps/api/src/middleware/authorization-matrix.ts)
 *     is well formed and the comparator fails in the three cases that matter
 *     (unclassified route, identity that gets in where it should not, stale entry).
 *
 *  2. With a test database (`KITSUDEN_MATRIX_DB`): mounts the REAL app with all
 *     the kons (`scripts/authorization-matrix.ts --check`), requests it with
 *     six real identities and requires every route to match its level. It creates
 *     users and agents and runs routes: ONLY against a database whose name
 *     contains `test`, migrated with `migrate.ts --all-kons`.
 *
 *       KITSUDEN_MATRIX_DB=postgres://<app role>@host/kitsuden_matrix_test
 *       KITSUDEN_MATRIX_ADMIN_DB=postgres://<superuser>@host/kitsuden_matrix_test
 *
 *     CI does not run this part: it checks only the table and its comparator. Run
 *     the full matrix yourself after changing a gate (`.claude/skills/authorization-change`).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareWithMatrix,
  EXPECTATION,
  MATRIX,
  type Level,
} from "../../apps/api/src/middleware/authorization-matrix";

const LEVELS: Level[] = [
  "public",
  "user",
  "staff",
  "content",
  "admin",
  "restricted",
  "custom",
  "middleware",
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"];

describe("the MATRIX table", () => {
  it("each entry is `METHOD /api…` with a known level", () => {
    const keys = Object.keys(MATRIX);
    expect(keys.length).toBeGreaterThan(400);
    for (const [key, level] of Object.entries(MATRIX)) {
      const [method, path] = key.split(" ");
      expect(METHODS, key).toContain(method);
      expect(path?.startsWith("/"), key).toBe(true);
      expect(LEVELS, key).toContain(level);
      if (level === "middleware") expect(method, key).toBe("ALL");
    }
  });

  it("the number of public writes does not go up without deciding it", () => {
    // Public writes are counted: if it goes up, someone opened one on purpose
    const publicWrites = Object.entries(MATRIX).filter(
      ([k, n]) => n === "public" && !k.startsWith("GET ") && !k.startsWith("ALL ")
    );
    expect(publicWrites.length).toBeLessThanOrEqual(PUBLIC_WRITES_LIMIT);
  });
});

/**
 * Public writes reviewed one by one in an earlier audit (sign-up and signed
 * webhooks, stateless calculators, newsletter subscribe/unsubscribe, members'
 * magic link, guest registration with their token, search…).
 * Raising this number is a DECISION: write the reason in the review.
 *
 * +3 (OAuth for MCP, docs/agents/oauth.md): `POST /api/oauth/register`,
 * `/token` and `/revoke`. The MCP specification 2026-07-28 wants them without a
 * session: they authenticate the OAuth CLIENT (PKCE, refresh, secret), not an
 * account; registration and token are limited by IP and fail closed.
 */
const PUBLIC_WRITES_LIMIT = 31;

describe("compareWithMatrix", () => {
  const matrix: Record<string, Level> = {
    "GET /api/blog": "public",
    "POST /api/items": "admin",
    "PATCH /api/blog/:id": "staff",
  };
  const closed = {
    anonymous: 401,
    user: 403,
    editor: 403,
    admin: 200,
    agent: 403,
    contentAgent: 403,
  };

  it("all in order: no failures", () => {
    expect(
      compareWithMatrix(
        [
          { key: "GET /api/blog", statuses: { anonymous: 200, user: 200, admin: 200 } },
          { key: "POST /api/items", statuses: closed },
          { key: "PATCH /api/blog/:id", statuses: { ...closed, editor: 404 } },
        ],
        matrix
      )
    ).toEqual([]);
  });

  it("a new unclassified route FAILS", () => {
    const f = compareWithMatrix(
      [
        { key: "GET /api/blog", statuses: { anonymous: 200, user: 200, admin: 200 } },
        { key: "POST /api/items", statuses: closed },
        { key: "PATCH /api/blog/:id", statuses: { ...closed, editor: 404 } },
        { key: "POST /api/new-route", statuses: { anonymous: 200 } },
      ],
      matrix
    );
    expect(f.join("\n")).toContain("POST /api/new-route: UNCLASSIFIED route");
  });

  it("an admin route that lets a user in FAILS", () => {
    const f = compareWithMatrix(
      [
        { key: "GET /api/blog", statuses: { anonymous: 200, user: 200, admin: 200 } },
        { key: "POST /api/items", statuses: { ...closed, user: 200 } },
        { key: "PATCH /api/blog/:id", statuses: { ...closed, editor: 404 } },
      ],
      matrix
    );
    expect(f.join("\n")).toContain("POST /api/items [admin]: user → 200");
  });

  it("an entry that is no longer mounted FAILS (the table does not go stale)", () => {
    const f = compareWithMatrix([{ key: "GET /api/blog", statuses: { anonymous: 200 } }], matrix);
    expect(f.join("\n")).toContain("POST /api/items: it is in MATRIX but is no longer mounted");
  });

  it("the levels require what they say", () => {
    expect(EXPECTATION.admin.editor).toBe(false);
    expect(EXPECTATION.staff.editor).toBe(true);
    expect(EXPECTATION.content.contentAgent).toBe(true);
    expect(EXPECTATION.user.anonymous).toBe(false);
  });
});

const BASE = process.env.KITSUDEN_MATRIX_DB;

describe.runIf(Boolean(BASE))("the real app against the table (KITSUDEN_MATRIX_DB)", () => {
  it(
    "every mounted route matches its level for the six identities",
    () => {
      const r = spawnSync("bun", ["run", "scripts/authorization-matrix.ts", "--check"], {
        cwd: resolve(__dirname, "../../apps/api"),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          KITSUDEN_TEST_DB: "postgres",
          LOG_LEVEL: "error",
          DATABASE_URL: BASE,
          DATABASE_ADMIN_URL: process.env.KITSUDEN_MATRIX_ADMIN_DB ?? BASE,
          // The script measures without Valkey (it counts in memory and empties it). Before, this
          // value fell to 127.0.0.1:6379, which on a developer machine can be the
          // PRODUCTION Valkey.
          REDIS_URL: "",
          VALKEY_URL: "",
        },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 3 * 60 * 60 * 1000,
      });
      const discrepancies = (r.stdout ?? "").split("\n").filter((l) => l.includes("✗"));
      expect(discrepancies, discrepancies.join("\n")).toEqual([]);
      expect(r.status, r.stderr?.slice(-2000)).toBe(0);
    },
    3 * 60 * 60 * 1000
  );
});
