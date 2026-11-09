/**
 * The editor cannot offer blocks that the page does not know how to save
 * ============================================================================
 *
 * ── THE FAILURE, MEASURED ──────────────────────────────────────────────────
 *
 * There were THREE block vocabularies and they did not match:
 *
 *   1. The `block_content_type` enum — what `block_contents` could store:
 *        hero, text, image, video, grid, cards, quote, cta, embed, divider,
 *        spacer, custom
 *   2. The panel's `BLOCK_REGISTRY` — what the editor OFFERS:
 *        hero, richtext, image-gallery, game-map, tier-list,
 *        character-builder, comments, streamer-widget, embed, callout,
 *        divider, dynamic-carousel, smart-filter, comparison-slider,
 *        smart-grid
 *   3. `render-blocks.ts` — what it knows how to RENDER: the same set as 2.
 *
 * The intersection of 1 and 2 was THREE types. Of the fifteen the builder
 * offers, **twelve could not be saved in a page**: the INSERT fails with an
 * invalid enum value.
 *
 * ── WHY NOBODY HAD SEEN IT ─────────────────────────────────────────────────
 *
 * Because the blocks of an ARTICLE do not go through the enum: `blog_posts.blocks`
 * is unconstrained jsonb, so there all fifteen work and everything looks
 * fine. Only the builder's pages have the constraint — and none had been
 * created. The failure was waiting for the first page.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * Everything the editor offers has to be savable AND renderable. Not the other
 * way round: the list may carry old values nobody offers any more, and there
 * may be saved pages with them.
 *
 * ── WHERE THE CONSTRAINT LIVES TODAY ───────────────────────────────────────
 *
 * No longer in the database. Migration 0009 turned the column into text: the
 * enum cost a PRODUCTION migration for every new block (seven in a row,
 * from 0002 to 0008) and only guarded the pages, because articles go in a
 * jsonb without constraint.
 *
 * The authority is now `TIPOS_DE_BLOQUE` in `blocks.schema.ts`, and the route that
 * publishes validates against it. That is: THIS test is what remains of the
 * guardian Postgres used to be. If it is relaxed, the failure comes back silently.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const REGISTRY = readFileSync(
  join(ROOT, "packages", "admin", "src", "types", "blocks.ts"),
  "utf-8"
);
const SCHEMA = readFileSync(join(ROOT, "packages", "core", "blocks", "blocks.schema.ts"), "utf-8");
const RENDER = readFileSync(join(ROOT, "packages", "shared", "src", "render-blocks.ts"), "utf-8");
const ROUTES = readFileSync(join(ROOT, "packages", "core", "blocks", "blocks.routes.ts"), "utf-8");

/** The types the editor offers: the top-level `type:` entries of the registry. */
function offered(): string[] {
  const body = REGISTRY.slice(REGISTRY.indexOf("export const BLOCK_REGISTRY"));
  return [...body.matchAll(/^\s{4}type:\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]);
}

/** The types the schema list accepts. */
function almacenables(): string[] {
  const i = SCHEMA.indexOf("export const TIPOS_DE_BLOQUE = [");
  expect(i, "the block types list was not found").toBeGreaterThan(-1);
  /**
   * It is cut from the `[`, not from the `export const`. Cutting earlier, the
   * constant's name enters the list and has to be removed with a
   * `slice(1)` — which is what was done first, with the enum, and it took
   * the FIRST real value, `hero`, along with it. An eyeballed adjustment to
   * compensate for a badly placed cut: that is how you build a guardian that
   * reports what is correct.
   */
  const block = SCHEMA.slice(SCHEMA.indexOf("[", i), SCHEMA.indexOf("] as const;", i));
  return [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
}

/** The ones the renderer knows how to render: static `case`s + map of interactive ones. */
function pintables(): string[] {
  const cases = [...RENDER.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]);

  const i = RENDER.indexOf("const INTERACTIVOS");
  const map = RENDER.slice(i, RENDER.indexOf("\n};", i));
  const interactive = [...map.matchAll(/^\s{2}"?([a-z0-9-]+)"?:\s*\{/gm)].map((m) => m[1]);

  return [...new Set([...cases, ...interactive])];
}

describe("the three block vocabularies", () => {
  const offers = offered();
  const saves = almacenables();
  const renders = pintables();

  it("all three were read, and they are not empty", () => {
    /**
     * Without this, changing the shape of any of the three files would leave the
     * test comparing empty lists and passing green.
     */
    expect(offers.length, `registro: ${offers.join(", ")}`).toBeGreaterThan(10);
    expect(saves.length, `lista: ${saves.join(", ")}`).toBeGreaterThan(10);
    expect(renders.length, `renderizador: ${renders.join(", ")}`).toBeGreaterThan(10);
  });

  it("everything the editor offers can be SAVED", () => {
    const doNotFit = offers.filter((t) => !saves.includes(t));

    expect(
      doNotFit,
      `The editor offers ${doNotFit.map((t) => `«${t}»`).join(", ")} y ` +
        `\`TIPOS_DE_BLOQUE\` does not admit them: when the page is published, the route ` +
        `responds 422 «Tipo de bloque desconocido». Add them to the list in ` +
        `\`blocks.schema.ts\` — no migration is needed any more.`
    ).toEqual([]);
  });

  it("everything the editor offers can be RENDERED", () => {
    const invisibles = offers.filter((t) => !renders.includes(t));

    expect(
      invisibles,
      `The editor offers ${invisibles.map((t) => `«${t}»`).join(", ")} y ` +
        `\`render-blocks.ts\` does not know how to render them: they are saved and the page comes out without ` +
        `them, without any error.`
    ).toEqual([]);
  });
});

describe("publish as a page", () => {
  it("the route is generic and lives where the pages live", () => {
    /**
     * The alternative was for `kon-tierlist` to write to `block_pages`, which would
     * tie it to `kon-blocks` and would have to be repeated for every kon that wants to
     * publish something. Here the pages' owner offers the service.
     */
    // From the kon SDK the route is a declared operation (`defineOperation`).
    expect(ROUTES).toContain('ruta: "/pages/from-block"');

    const route = ROUTES.slice(
      ROUTES.indexOf('id: "publish-block-as-page"'),
      ROUTES.indexOf('id: "update-page"')
    );

    expect(route.length, "the route was not found").toBeGreaterThan(0);
    expect(route, "publishing is writing: it requires a session").toMatch(
      /(acceso|access): "(sesion|session)"/
    );
    expect(route, "and the permission to create pages").toMatch(/(accion|action): "create"/);
  });

  it("the type is validated against the schema's list, not against a parallel one", () => {
    const route = ROUTES.slice(
      ROUTES.indexOf('id: "publish-block-as-page"'),
      ROUTES.indexOf('id: "update-page"')
    );

    /**
     * A hand-written list in the route is exactly how we ended up with
     * three vocabularies that did not match.
     */
    expect(route).toContain("TIPOS_DE_BLOQUE");
  });

  it("the block type does NOT become a Postgres enum again", () => {
    /**
     * An enum here means a migration against production for every new
     * block. It already cost seven in a row (0002-0008) and left `deck` unable to be
     * saved in a page. If someone restores it, let it fail here and not in
     * the deployment.
     */
    expect(
      SCHEMA.includes('pgEnum("block_content_type"'),
      "the block type would again require a production migration for every " +
        "new block; the TIPOS_DE_BLOQUE list exists precisely to avoid that."
    ).toBe(false);
  });

  it("republishing updates the same page, it does not create another", () => {
    const route = ROUTES.slice(
      ROUTES.indexOf('id: "publish-block-as-page"'),
      ROUTES.indexOf('id: "update-page"')
    );

    /**
     * Republishing every patch is the normal operation of a tier list, not
     * the exception. Without this, the second time fails with "that slug already
     * exists" or leaves stray pages.
     */
    expect(route).toContain("existente");
    expect(
      route.includes("delete(blocks)"),
      "when updating, the previous blocks must be cleaned: otherwise the page " +
        "accumulates one copy per republish."
    ).toBe(true);
  });

  it("the tier lists kon does not import the pages one", () => {
    /**
     * The whole point of the route being generic: it is ASKED, not imported.
     */
    const kon = readFileSync(join(ROOT, "packages", "kons", "kon-tierlist", "index.ts"), "utf-8");

    expect(
      /from ["'].*kon-blocks/.test(kon) || /from ["'].*core\/blocks/.test(kon),
      "kon-tierlist cannot depend on kon-blocks: publishing is an HTTP " +
        "request to a generic route, not an import."
    ).toBe(false);
  });
});

describe("an interactive block's gap does not publish internal jargon", () => {
  /**
   * ── THE FAILURE ────────────────────────────────────────────────────────────
   *
   * The fallback content —what the reader sees if the site does not hydrate— was
   * the programmer's note, with the block identifier in bold:
   *
   *     tier-list — References a kon-tierlist template; its rows live
   *     in that table.
   *
   * That came out in the middle of a published article. The note is useful, but for
   * whoever implements the frontend, not for whoever reads the article.
   */
  it("each interactive block declares label and reason separately", () => {
    const i = RENDER.indexOf("const INTERACTIVOS");
    const map = RENDER.slice(i, RENDER.indexOf("\n};", i));

    const inputs = [...map.matchAll(/^\s{2}"?([a-z0-9-]+)"?:\s*\{/gm)].map((m) => m[1]);
    expect(inputs.length, "no interactive block was read").toBeGreaterThan(5);

    expect(
      (map.match(/etiqueta:/g) ?? []).length,
      "each interactive block needs a human label"
    ).toBe(inputs.length);
  });

  it("what gets rendered is the label, not the reason", () => {
    const i = RENDER.indexOf("const reserva =");
    const chunk = RENDER.slice(i, i + 400);

    expect(chunk.length, "the fallback content was not found").toBeGreaterThan(0);
    expect(chunk).toContain(".etiqueta");

    expect(
      /\$\{escapeHtml\(tipo\)\}<\/strong>/.test(chunk),
      "the block identifier is not text for a reader."
    ).toBe(false);
  });
});
