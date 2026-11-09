/**
 * A dataset serves all its readers, whatever `schema` it has
 * ============================================================================
 *
 * ── WHAT THERE WAS ─────────────────────────────────────────────────────────
 *
 * `data_sets.schema` was written in two forms —a list of fields and an
 * object `{fields}`— and each reader expected only one. With a list, bulk
 * import blew up on `schema.fields.map` and the public grid painted zero
 * columns; with `{fields}`, validation and the kons' catalogs saw no
 * fields. No dataset worked for everything.
 *
 * And an `image` field only validated a media library uuid, while all
 * those that paint it (tier lists, catalogs, the grid) only knew how to paint
 * URLs: a catalog with external images could not even be saved.
 */

import { buildFieldValidator } from "@kitsuden/engine";
import { schemaFields, readDatasetCatalog } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

const FIELDS = [
  { key: "name", type: "text", isRequired: true },
  { key: "hp", type: "number" },
  { key: "portrait", type: "image" },
];

describe("the two forms of `schema`", () => {
  it("a list and a `{fields}` give the same fields", () => {
    expect(schemaFields(FIELDS)).toEqual(FIELDS);
    expect(schemaFields({ fields: FIELDS })).toEqual(FIELDS);
  });

  it("what is not a schema gives zero fields, not an exception", () => {
    for (const rare of [null, undefined, "text", 42, {}, { fields: "no" }]) {
      expect(schemaFields(rare)).toEqual([]);
    }
    expect(schemaFields([null, "x", { key: "ok" }])).toEqual([{ key: "ok" }]);
  });

  it("validation requires the same with either one", () => {
    for (const schema of [FIELDS, { fields: FIELDS }]) {
      const v = buildFieldValidator(schema);
      expect(v.safeParse({ name: "Ignis", hp: 90 }).success).toBe(true);
      // If `{fields}` were not unwrapped, the required would not be enforced
      expect(v.safeParse({ hp: 90 }).success).toBe(false);
      expect(v.safeParse({ name: "Ignis", hp: "90" }).success).toBe(false);
    }
  });

  it("the kons' catalog finds the image field with `{fields}`", async () => {
    const rows = [
      [
        {
          id: "ds",
          name: "Aniidex",
          schema: { fields: FIELDS },
          policy_json: { readAccess: "public" },
        },
      ],
      [{ id: "e1", title: "Ignis", data: { portrait: "https://cdn.example/ignis.png" } }],
    ];
    const db = { execute: async () => rows.shift() };

    const catalog = await readDatasetCatalog(db, "ds", null as never);

    expect(catalog?.fields.map((f) => f.key)).toEqual(["name", "hp", "portrait"]);
    expect(catalog?.imageField).toBe("portrait");
    expect(catalog?.fieldOfType("number")).toBe("hp");
  });
});

describe("an image field accepts a medium or a URL", () => {
  const v = buildFieldValidator([{ key: "portrait", type: "image" }]);
  const accepts = (value: unknown) => v.safeParse({ portrait: value }).success;

  it("the media library id is still valid", () => {
    expect(accepts("3f1c1d7e-2b8a-4c55-9d0e-6a7b8c9d0e1f")).toBe(true);
  });

  it("an http(s) URL too", () => {
    expect(accepts("https://worldx-website-cdn.aniimo.com/a/ignis.png")).toBe(true);
    expect(accepts("http://localhost:3000/api/media/x")).toBe(true);
  });

  it("but not anything that looks like a URL", () => {
    // This value ends up in a `src` or an `href`
    expect(accepts("javascript:alert(1)")).toBe(false);
    expect(accepts("data:image/svg+xml,<svg onload=alert(1)>")).toBe(false);
    expect(accepts("ignis.png")).toBe(false);
    expect(accepts(42)).toBe(false);
  });

  it("`media` follows the same rule", () => {
    const m = buildFieldValidator([{ key: "sheet", type: "media" }]);
    expect(m.safeParse({ sheet: "https://example.com/sheet.pdf" }).success).toBe(true);
    expect(m.safeParse({ sheet: "javascript:alert(1)" }).success).toBe(false);
  });

  it("a `url` field does not accept `javascript:` either", () => {
    // It is painted as a link in the public grid
    const u = buildFieldValidator([{ key: "web", type: "url" }]);
    expect(u.safeParse({ web: "https://wiki.aniimo.com" }).success).toBe(true);
    expect(u.safeParse({ web: "javascript:alert(1)" }).success).toBe(false);
  });

  it("a relation still requires a uuid", () => {
    // `mediaRef` is a NEW family precisely so as not to relax `uuid`
    const r = buildFieldValidator([{ key: "parent", type: "relation" }]);
    expect(r.safeParse({ parent: "https://example.com" }).success).toBe(false);
  });
});
