/**
 * A malformed id cannot return 500
 * ============================================================================
 *
 * When a `/:id` route passes the parameter straight to a query against a
 * `uuid` column, a value that is not one makes Postgres answer
 *
 *     invalid input syntax for type uuid
 *
 * and the error handler turns it into a **500**. That is: a mistyped URL
 * is reported as a server failure.
 *
 * ── HOW IT SURFACED ────────────────────────────────────────────────────────
 *
 * Sweeping the API looking for 500s. `GET /api/media/upload` gave a server
 * error, and the log explained it: `"route":"/api/media/:id"`. The URL matched
 * the detail route and `id` was `"upload"` — there is no upload endpoint via GET,
 * so anyone who tried it generated a 500.
 *
 * That means a broken link, a crawler or someone probing the API
 * fill the log with 500 errors on a perfectly healthy database. And when
 * 500s are background noise, they stop being looked at: the day one is real, it will go
 * unnoticed among the false ones.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * If a handler uses `c.req.param("id")` in a comparison against a uuid column,
 * it has to check the shape first with `isUuid` and answer 404. 404 is
 * chosen over 400 because it is what really happens —that id cannot
 * exist— and because it does not reveal what type of key the table uses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isUuid } from "../../packages/engine/src/validation";

const ROOT = join(__dirname, "..", "..");

/**
 * Routes that have already bitten. They are checked per file, not by sweeping the whole
 * repo, because not every `id` column is a uuid: `auth_users.id` is text,
 * and requiring uuid there would be wrong.
 */
const WATCHED = [
  { file: "packages/core/media/media.routes.ts", table: "media" },
  { file: "packages/kons/kon-blog/src/routes.ts", table: "blog_posts" },
];

describe("isUuid", () => {
  it("accepts a real uuid v4", () => {
    expect(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
  });

  it("rejects what arrives through a mistyped URL", () => {
    // `upload` is the literal case that produced the 500.
    for (const bad of ["upload", "", "123", "not-a-uuid", "../etc/passwd"]) {
      expect(isUuid(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("rejects null and undefined without throwing", () => {
    // A missing parameter arrives as undefined; blowing up here would turn the
    // 404 we are after into the same 500 we are trying to avoid.
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it("rejects a uuid with garbage attached", () => {
    // Without anchors in the regular expression, this would pass — and the 500 would come back.
    expect(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301x")).toBe(false);
    expect(isUuid(" 3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(false);
  });
});

describe("the :id handlers check the shape before querying", () => {
  for (const { file: file, table: table } of WATCHED) {
    it(file, () => {
      const source = readFileSync(join(ROOT, file), "utf-8");

      // If the file queries by id, it has to use the validator.
      const queryById = source.includes(".id,") || source.includes("eq(");
      if (!queryById) return;

      expect(
        source.includes("isUuid("),
        `${file} serves /:id routes against '${table}' and does not check the shape ` +
          `of the id with isUuid. An id that is not a uuid makes Postgres throw ` +
          `"invalid input syntax for type uuid", and that comes out as a 500 instead of the ` +
          `proper 404.`
      ).toBe(true);
    });
  }
});
