/**
 * GraphQL — Route security (regression of the auth gap)
 * ============================================================================
 * Before this fix, POST /api/graphql had NO auth middleware at all and
 * the resolvers used the global db (bypassing RLS).
 *
 * STATIC guards on the source code: deterministic and immune to
 * mock.module leakage between files of the bun suite (the runtime 401 checks
 * live in src/tests/graphql-security-http.test.ts, which
 * requires a real server + DB).
 */

import { describe, expect, test } from "bun:test";

const source = await Bun.file(`${import.meta.dir}/../routes/graphql.ts`).text();

describe("GraphQL route security (static guards)", () => {
  test("POST / carries protectRoute + withTransactionalRLS", () => {
    expect(source).toMatch(
      /graphqlRoutes\.post\(\s*"\/",\s*protectRoute,\s*withTransactionalRLS\(\)/
    );
  });

  test("GET /schema carries protectRoute", () => {
    expect(source).toMatch(/graphqlRoutes\.get\("\/schema",\s*protectRoute/);
  });

  test("POST /invalidate carries protectRoute + requireAdmin", () => {
    expect(source).toMatch(/graphqlRoutes\.post\("\/invalidate",\s*protectRoute,\s*requireAdmin/);
  });

  test("resolvers do not reference the global db directly", () => {
    // All data access in resolvers must go through exec() (request-scope →
    // RLS tx). Only the schema build (listing dataSets to generate
    // types) may use the global `db.`, marked with the comment.
    const rawDbUses = source
      .split("\n")
      .filter((line) =>
        /\bawait db\.|^\s+db\s*$|^\s+db\.(select|insert|update|delete)\(/.test(line)
      )
      .filter((line) => !line.includes("schema build"));
    expect(rawDbUses).toEqual([]);
  });

  test("the exec() helper uses resolveExecutor (RLS by request-scope)", () => {
    expect(source).toContain("resolveExecutor(db)");
  });
});
