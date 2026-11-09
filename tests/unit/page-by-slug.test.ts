/**
 * `GET /api/page-builder/pages/:id` accepts uuid OR slug (Inti uses it with
 * `@inti/adapter-kitsuden`). Comparing a slug («home») with the uuid column
 * made the cast fail in Postgres and the route answered 500 instead of 404.
 * Seen against a production API.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROUTES = readFileSync(
  resolve(__dirname, "../../packages/core/blocks/blocks.routes.ts"),
  "utf8"
);
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("a page is requested by uuid or by slug", () => {
  it("only a uuid is compared with the `id` column", () => {
    // No spaces: Prettier splits the expression into several lines depending on its length
    const compact = ROUTES.replace(/\s+/g, "");
    expect(compact).toContain(
      "IS_UUID.test(id)?sql`${pages.id}=${id}OR${pages.slug}=${id}`:sql`${pages.slug}=${id}`"
    );
    expect(compact).not.toContain(".where(sql`${pages.id}=${id}OR${pages.slug}=${id}`)");
  });

  it("the expression tells a uuid from a slug", () => {
    expect(IS_UUID.test("11111111-2222-3333-4444-555555555555")).toBe(true);
    for (const slug of ["home", "about", "11111111-2222-3333-4444", "x".repeat(36)]) {
      expect(IS_UUID.test(slug)).toBe(false);
    }
  });
});

describe("creating a page requires a title", () => {
  it("without `title` it responds 400 instead of blowing up with 500", () => {
    expect(ROUTES).toContain('return c.json({ error: "Missing `title`" }, 400);');
  });
});
