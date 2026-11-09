/**
 * The block contract in English (0.9) and the bridge from the 0.8 Spanish keys
 * ============================================================================
 *
 * - `@kitsuden/shared` block-keys.ts: the table of renames, the one-version read compatibility
 *   (`readBlockData`, `readEditorial`) and the write check (`findSpanishBlockKeys`).
 * - `kon-blocks/0010_english_block_keys.sql` on PGlite: rows in the 0.8 shape, in the 0.9 shape and
 *   with both keys; the result must be exactly what `readBlockData` reads, and a second run must
 *   change nothing.
 * - The page builder: a write with a 0.8 key is a 422 whose hint names the English key; a stored
 *   0.8 block is served in English.
 * - `renderBlocks`: a 0.8 block still renders.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { resetAuthz } from "@kitsuden/engine";
import {
  findSpanishBlockKeys,
  findSpanishEditorialKeys,
  readBlockData,
  readEditorial,
  renderBlocks,
  spanishKeysError,
} from "@kitsuden/shared";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { readSqlFile } from "../../apps/api/src/lib/sql-file";
import { createTestKonContext } from "../../apps/api/src/lib/test-kon-context";
import { registerBlocksPolicy } from "../../packages/core/blocks/blocks.policy";
import { createBlocksRouter } from "../../packages/core/blocks/blocks.routes";

const MIGRATION = resolve(
  __dirname,
  "../../packages/core/blocks/migrations/0010_english_block_keys.sql"
);

/** Block data in every shape the migration and the reader must handle. */
export const FIXTURES: Array<{ type: string; data: unknown }> = [
  // 0.8, one per block type with Spanish keys
  { type: "callout", data: { titulo: "Ojo", content: "x", variant: "info" } },
  { type: "hero", data: { titulo: "T", subtitulo: "S", descripcion: "D", imageUrl: "/a.png" } },
  { type: "comments", data: { subjectType: "blog_post", orden: "mejores", allowReplies: true } },
  { type: "comments", data: { subjectType: "blog_post", orden: "nuevos" } },
  { type: "comments", data: { subjectType: "blog_post", orden: "antiguos" } },
  {
    type: "dex",
    data: {
      datasetId: "d",
      titulo: "Aniidex",
      segmento: "aniidex",
      descripcion: "All of them",
      campos: { clave: "slug", nombre: "name", imagen: "image", numero: "entry", total: "total" },
      facetas: [{ campo: "elements", etiqueta: "Element", datasetId: "e" }, "junk"],
      stats: [{ key: "hp", label: "HP" }],
      habilidades: {
        datasetId: "s",
        clave: "slug",
        grupos: [{ campo: "skills", etiqueta: "Skills" }],
      },
      rasgo: { datasetId: "t", campo: "trait" },
      evolucion: { datasetId: "v", campo: "line" },
      chips: [{ campo: "habitats", etiqueta: "Habitats", herramienta: "map" }],
      noticias: { datasetId: "n" },
      nota: "From the client",
    },
  },
  {
    type: "affinity",
    data: {
      datasetId: "d",
      titulo: "Affinity",
      campos: { clave: "slug", nombre: "name", imagen: "image", grupos: "relations" },
      etiquetas: { child: "Trainee", progenitor: "Parent", grandparent: "Grandparent" },
      nota: "",
    },
  },
  {
    type: "event-search",
    data: {
      datasetId: "d",
      titulo: "Events",
      campos: { nombre: "name", opciones: "options", kind: "kind" },
    },
  },
  {
    type: "race-planner",
    data: {
      datasetId: "d",
      titulo: "Races",
      campos: { nombre: "name", turns: "turns", hq: "venue" },
    },
  },
  {
    type: "card-browser",
    data: { juegoDeCartas: "op", titulo: "Cards", facetas: [{ campo: "cost", etiqueta: "Cost" }] },
  },
  { type: "deck-builder", data: { juegoDeCartas: "op", titulo: "Builder", nota: "n" } },
  { type: "deck-showcase", data: { juegoDeCartas: "op", titulo: "Showcase" } },
  {
    type: "deck",
    data: { juego: "op", arquetipo: "red", mazo: "", vista: "resumen", titulo: "Meta" },
  },
  { type: "deck", data: { juego: "op", vista: "lista" } },
  { type: "set-searcher", data: { titulo: "Sets", descripcion: "d", gameSlug: "mhw" } },
  // Both keys: the English one wins
  {
    type: "dex",
    data: { titulo: "old", title: "new", campos: { nombre: "a" }, fields: { name: "b" } },
  },
  { type: "comments", data: { orden: "mejores", order: "newest" } },
  // 0.9 already: untouched
  {
    type: "dex",
    data: { datasetId: "d", title: "T", fields: { key: "slug", name: "name" }, facets: [] },
  },
  { type: "deck", data: { game: "op", view: "summary" } },
  // Keys that are only renamed for their own type are left alone elsewhere
  { type: "smart-grid", data: { datasetId: "d", campos: ["a"], juego: "x", orden: 3 } },
  // Not objects
  { type: "dex", data: null },
  { type: "dex", data: ["titulo"] },
  { type: "dex", data: "titulo" },
];

describe("readBlockData (0.8 → 0.9, until 0.10)", () => {
  it("renames the keys of every block type, nested ones included", () => {
    expect(readBlockData("dex", FIXTURES[5]!.data)).toEqual({
      datasetId: "d",
      title: "Aniidex",
      segment: "aniidex",
      description: "All of them",
      fields: { key: "slug", name: "name", image: "image", number: "entry", total: "total" },
      facets: [{ field: "elements", label: "Element", datasetId: "e" }, "junk"],
      stats: [{ key: "hp", label: "HP" }],
      skills: { datasetId: "s", key: "slug", groups: [{ field: "skills", label: "Skills" }] },
      trait: { datasetId: "t", field: "trait" },
      evolution: { datasetId: "v", field: "line" },
      chips: [{ field: "habitats", label: "Habitats", tool: "map" }],
      news: { datasetId: "n" },
      note: "From the client",
    });
    expect(readBlockData("affinity", FIXTURES[6]!.data)).toMatchObject({
      fields: { key: "slug", name: "name", image: "image", groups: "relations" },
      labels: { child: "Trainee", parent: "Parent", grandparent: "Grandparent" },
    });
    expect(readBlockData("card-browser", FIXTURES[9]!.data)).toEqual({
      cardGame: "op",
      title: "Cards",
      facets: [{ field: "cost", label: "Cost" }],
    });
  });

  it("translates the values of a closed list with their key", () => {
    expect(readBlockData("comments", { orden: "mejores" })).toEqual({ order: "best" });
    expect(readBlockData("comments", { orden: "nuevos" })).toEqual({ order: "newest" });
    expect(readBlockData("comments", { orden: "antiguos" })).toEqual({ order: "oldest" });
    expect(readBlockData("deck", { juego: "op", vista: "resumen" })).toEqual({
      game: "op",
      view: "summary",
    });
    expect(readBlockData("deck", { vista: "lista" })).toEqual({ view: "list" });
    // A value outside the list moves as it is; a prototype key is not a translation
    expect(readBlockData("deck", { vista: "constructor" })).toEqual({ view: "constructor" });
  });

  it("the English key wins when both are there; English data is returned as the same object", () => {
    expect(readBlockData("dex", { titulo: "old", title: "new" })).toEqual({ title: "new" });
    expect(readBlockData("comments", { orden: "mejores", order: "newest" })).toEqual({
      order: "newest",
    });
    const english = { datasetId: "d", title: "T", fields: { key: "k" }, facets: [{ field: "f" }] };
    expect(readBlockData("dex", english)).toBe(english);
    for (const v of [null, undefined, "x", 3, ["titulo"]]) expect(readBlockData("dex", v)).toBe(v);
  });

  it("type-specific keys are not touched on other types; the input is never mutated", () => {
    const grid = { campos: ["a"], juego: "x", orden: 3, titulo: "T" };
    const copy = structuredClone(grid);
    expect(readBlockData("smart-grid", grid)).toEqual({
      campos: ["a"],
      juego: "x",
      orden: 3,
      title: "T",
    });
    expect(grid).toEqual(copy);
  });

  it("readEditorial: titulo/descripcion/oculto/orden → title/description/hidden/order", () => {
    expect(readEditorial({ titulo: "T", descripcion: "D", oculto: true, orden: 2 })).toEqual({
      title: "T",
      description: "D",
      hidden: true,
      order: 2,
    });
    expect(readEditorial({ titulo: "old", title: "new" })).toEqual({ title: "new" });
    const english = { title: "T" };
    expect(readEditorial(english)).toBe(english);
    expect(readEditorial(undefined)).toBeUndefined();
  });
});

describe("the write check: a 0.8 key is named with its English one", () => {
  it("finds top-level, nested and value renames", () => {
    expect(findSpanishBlockKeys("deck", { juego: "x", vista: "resumen" })).toEqual([
      { path: "juego", use: "game" },
      { path: "vista", use: "view" },
    ]);
    expect(findSpanishBlockKeys("comments", { order: "mejores" })).toEqual([
      { path: 'order: "mejores"', use: 'order: "best"' },
    ]);
    expect(
      findSpanishBlockKeys("dex", {
        fields: { nombre: "n" },
        facetas: [{ campo: "c" }],
        skills: { grupos: [{ etiqueta: "x" }] },
      }).map((k) => k.path)
    ).toEqual([
      "facetas",
      "fields.nombre",
      "facetas[0].campo",
      "skills.grupos",
      "skills.grupos[0].etiqueta",
    ]);
    expect(findSpanishBlockKeys("dex", FIXTURES[17]!.data)).toEqual([]);
    expect(findSpanishBlockKeys("smart-grid", { campos: [], juego: "x" })).toEqual([]);
    expect(findSpanishEditorialKeys({ oculto: true, title: "x" })).toEqual([
      { path: "oculto", use: "hidden" },
    ]);
  });

  it("the error body says what is wrong and the hint names the English key", () => {
    const body = spanishKeysError([{ path: "titulo", use: "title" }]);
    expect(body.error).toContain("«titulo»");
    expect(body.hint).toBe("Use the English names: «titulo» → «title».");
    expect(body.renamed).toEqual([{ path: "titulo", use: "title" }]);
  });
});

describe("renderBlocks reads a 0.8 block", () => {
  it("a callout saved with `titulo` keeps its title; a dex gap carries English config", () => {
    const html = renderBlocks([
      {
        id: "1",
        type: "callout",
        order: 0,
        data: { titulo: "Watch out", content: "x", variant: "info" },
      },
      { id: "2", type: "dex", order: 1, data: { titulo: "Index", campos: { nombre: "name" } } },
    ]).html;
    expect(html).toContain("Watch out");
    expect(html).toContain("&quot;title&quot;:&quot;Index&quot;");
    expect(html).toContain("&quot;fields&quot;:{&quot;name&quot;:&quot;name&quot;}");
    expect(html).not.toContain("titulo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════

const USERS: Record<string, Record<string, unknown> | null> = {
  anonymous: null,
  editor: { id: "u-editor", role: "editor" },
};

let client: PGlite;
let app: Hono;

async function request(who: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", "x-who": who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function runMigration() {
  const file = readSqlFile(MIGRATION, "kon-blocks/0010_english_block_keys.sql");
  await client.transaction(async (tx) => {
    for (const statement of file.statements) await tx.exec(statement);
  });
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TYPE block_page_status AS ENUM ('draft','published','archived');
    CREATE TABLE block_pages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(500) NOT NULL, slug varchar(500) NOT NULL UNIQUE, description text,
      status block_page_status NOT NULL DEFAULT 'draft',
      meta_title varchar(500), meta_description text, og_image_id uuid,
      layout varchar(50) NOT NULL DEFAULT 'default', css_class varchar(200), custom_css text,
      published_at timestamptz, author_id uuid,
      is_homepage boolean NOT NULL DEFAULT false, require_auth boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE block_contents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      page_id uuid NOT NULL REFERENCES block_pages(id) ON DELETE CASCADE,
      type varchar(64) NOT NULL, name varchar(200),
      sort_order integer NOT NULL DEFAULT 0, column_span integer NOT NULL DEFAULT 12,
      content jsonb NOT NULL,
      css_class varchar(200), background_color varchar(50), text_color varchar(50), padding varchar(50),
      is_visible boolean NOT NULL DEFAULT true, visible_from timestamptz, visible_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE block_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(200) NOT NULL, description text,
      category varchar(100) NOT NULL, type varchar(64) NOT NULL, content jsonb NOT NULL,
      css_class varchar(200), background_color varchar(50), text_color varchar(50), padding varchar(50),
      is_active boolean NOT NULL DEFAULT true, usage_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- Other JSON that must not be touched, even with the same keys
    CREATE TABLE other_json (id int PRIMARY KEY, doc jsonb);
  `);

  const ctx = createTestKonContext({
    db: { instance: drizzle(client) } as any,
    auth: {
      requireAuth: async (c: any, next: any) =>
        c.get("user") ? next() : c.json({ error: "Unauthorized" }, 401),
      optionalAuth: async (_c: any, next: any) => next(),
    } as any,
    cache: {
      get: async () => null,
      set: async () => {},
      del: async () => {},
      invalidate: async () => {},
    } as any,
  });
  app = new Hono();
  app.use("*", async (c, next) => {
    const u = USERS[c.req.header("x-who") ?? "anonymous"];
    if (u) c.set("user" as never, u as never);
    await next();
  });
  app.route("/api/page-builder", createBlocksRouter(ctx) as unknown as Hono);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  resetAuthz();
  registerBlocksPolicy();
  await client.exec(
    "DELETE FROM block_contents; DELETE FROM block_pages; DELETE FROM block_templates; DELETE FROM other_json;"
  );
});

async function newPage(slug = "p"): Promise<string> {
  const r = await client.query<{ id: string }>(
    "INSERT INTO block_pages (title, slug, status) VALUES ('P', $1, 'published') RETURNING id",
    [slug]
  );
  return r.rows[0]!.id;
}

describe("kon-blocks/0010_english_block_keys.sql", () => {
  it("rewrites block_contents and block_templates exactly as readBlockData reads them", async () => {
    const pageId = await newPage();
    for (const [i, f] of FIXTURES.entries()) {
      if (f.data === null) continue; // content is NOT NULL
      await client.query(
        "INSERT INTO block_contents (page_id, type, sort_order, content) VALUES ($1, $2, $3, $4::jsonb)",
        [pageId, f.type, i, JSON.stringify(f.data)]
      );
      await client.query(
        "INSERT INTO block_templates (name, category, type, content) VALUES ($1, 'c', $2, $3::jsonb)",
        [`t${i}`, f.type, JSON.stringify(f.data)]
      );
    }
    await client.query("INSERT INTO other_json VALUES (1, $1::jsonb)", [
      JSON.stringify({ titulo: "keep", campos: { nombre: "keep" } }),
    ]);
    const stamp = await client.query<{ u: string }>(
      "SELECT max(updated_at)::text AS u FROM block_contents"
    );

    await runMigration();

    const contents = await client.query<{ type: string; content: unknown; sort_order: number }>(
      "SELECT type, content, sort_order FROM block_contents ORDER BY sort_order"
    );
    for (const row of contents.rows) {
      const f = FIXTURES[row.sort_order]!;
      expect(row.content, `${f.type} #${row.sort_order}`).toEqual(readBlockData(f.type, f.data));
    }
    const templates = await client.query<{ name: string; content: unknown }>(
      "SELECT name, content FROM block_templates"
    );
    for (const row of templates.rows) {
      const f = FIXTURES[Number(row.name.slice(1))]!;
      expect(row.content, row.name).toEqual(readBlockData(f.type, f.data));
      expect(findSpanishBlockKeys(f.type, row.content), row.name).toEqual([]);
    }
    // Other JSON and the timestamps are untouched; the helper functions are gone
    const other = await client.query<{ doc: unknown }>("SELECT doc FROM other_json");
    expect(other.rows[0]!.doc).toEqual({ titulo: "keep", campos: { nombre: "keep" } });
    expect(
      (await client.query<{ u: string }>("SELECT max(updated_at)::text AS u FROM block_contents"))
        .rows[0]!.u
    ).toBe(stamp.rows[0]!.u);
    const fns = await client.query(
      "SELECT 1 FROM pg_proc WHERE proname LIKE 'kitsuden_blocks_0010%'"
    );
    expect(fns.rows).toEqual([]);

    // Idempotent: a second run changes nothing
    const before = await client.query("SELECT id, content FROM block_contents ORDER BY id");
    await runMigration();
    const after = await client.query("SELECT id, content FROM block_contents ORDER BY id");
    expect(after.rows).toEqual(before.rows);
  });

  it("is split into statements the runner can execute (dollar-quoted bodies kept whole)", () => {
    const file = readSqlFile(MIGRATION, "kon-blocks/0010_english_block_keys.sql");
    expect(file.statements).toHaveLength(8);
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/\r\n/);
  });
});

describe("the page builder speaks 0.9 only", () => {
  it("POST / PATCH of a block with a 0.8 key: 422 with a hint naming the English key", async () => {
    const pageId = await newPage();
    const post = await request("editor", "POST", `/api/page-builder/pages/${pageId}/blocks`, {
      type: "deck",
      content: { juego: "op", vista: "resumen" },
    });
    expect(post.status).toBe(422);
    expect(post.body.hint).toContain("«juego» → «game»");
    expect(post.body.hint).toContain("«vista» → «view»");
    expect(post.body.renamed).toEqual([
      { path: "juego", use: "game" },
      { path: "vista", use: "view" },
    ]);

    const ok = await request("editor", "POST", `/api/page-builder/pages/${pageId}/blocks`, {
      type: "deck",
      content: { game: "op", view: "summary" },
    });
    expect(ok.status).toBe(201);
    const patch = await request("editor", "PATCH", `/api/page-builder/blocks/${ok.body.id}`, {
      content: { game: "op", titulo: "Meta" },
    });
    expect(patch.status).toBe(422);
    expect(patch.body.hint).toContain("«titulo» → «title»");

    const page = await request("editor", "POST", "/api/page-builder/pages", {
      title: "New",
      blocks: [
        { type: "hero", content: { title: "ok" } },
        { type: "comments", content: { orden: "mejores" } },
      ],
    });
    expect(page.status).toBe(422);
    expect(page.body.renamed).toEqual([
      { path: "blocks[1].content.orden", use: "blocks[1].content.order" },
    ]);
    const template = await request("editor", "POST", "/api/page-builder/templates", {
      name: "T",
      category: "c",
      type: "card-browser",
      content: { juegoDeCartas: "op" },
    });
    expect(template.status).toBe(422);
    // Nothing was saved by the rejected writes
    const rows = await client.query("SELECT content FROM block_contents");
    expect(rows.rows).toEqual([{ content: { game: "op", view: "summary" } }]);
  });

  it("a block stored with 0.8 keys is served in English (until 0.10)", async () => {
    const pageId = await newPage("old");
    await client.query(
      "INSERT INTO block_contents (page_id, type, content) VALUES ($1, 'card-browser', $2::jsonb)",
      [
        pageId,
        JSON.stringify({ juegoDeCartas: "op", titulo: "Cards", facetas: [{ campo: "cost" }] }),
      ]
    );
    const english = { cardGame: "op", title: "Cards", facets: [{ field: "cost" }] };
    const byId = await request("editor", "GET", `/api/page-builder/pages/${pageId}`);
    expect(byId.body.blocks[0].content).toEqual(english);
    const rendered = await request("anonymous", "GET", "/api/page-builder/render/old");
    expect(rendered.status).toBe(200);
    expect(rendered.body.blocks[0].content).toEqual(english);
  });
});
