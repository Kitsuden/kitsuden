/**
 * Buttons that do nothing, and labels that say made-up words
 * ============================================================================
 *
 * Four failures reported at once on the games screen. None gave an
 * error: three did nothing and the fourth wrote a broken word. It is the worst
 * family of failures in this panel, because they leave no trace in any log.
 *
 *   1. "Add All Gam"       — a singularization by regular expression.
 *   2. "New Game"          — linked to the kon's screen and that was it.
 *   3. Create collection   — sent `name`; the column is called `title`.
 *   4. "Export"            — a mute `return` when the table is empty.
 *
 * All four look the same from the outside —"it doesn't work"— and have four
 * different causes in four different layers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const EXPLORER = join(
  ROOT,
  "packages",
  "admin",
  "src",
  "lib",
  "components",
  "admin",
  "DataExplorer.svelte"
);
const GAMES_VIEW = join(ROOT, "packages", "admin", "src", "views", "games", "GamesView.svelte");
const GAMES_SCHEMA = join(ROOT, "packages", "kons", "kon-games", "games.schema.ts");

describe("the add button's label", () => {
  const explorer = readFileSync(EXPLORER, "utf-8");

  it("the singular is not invented by trimming letters", () => {
    /**
     * The rule was `title.replace(/e?s$/i, "")`. With "Posts" → "Post" it
     * got it right, and that is why it survived. With the first view in English:
     *
     *     "All Games".replace(/e?s$/i, "")  →  "All Gam"
     *
     * A rule that is right sometimes is worse than one that always fails: nobody
     * reviews it until a broken word shows up on screen.
     */
    const tag = explorer.slice(
      explorer.indexOf("const signupTag"),
      explorer.indexOf("const columns")
    );

    expect(tag.length, "`signupTag` was not found").toBeGreaterThan(0);

    expect(
      /\.replace\(\/[^/]*s\$/.test(tag),
      "the button's name cannot come from trimming letters off the title of the " +
        "view. If the kon does not declare a name, the button says just «Add»: " +
        "it is not as pretty, but it is never a word that does not exist."
    ).toBe(false);
  });

  it("the name comes from what the kon declares", () => {
    const tag = explorer.slice(
      explorer.indexOf("const signupTag"),
      explorer.indexOf("const columns")
    );

    expect(tag).toContain("singularName");
  });
});

describe("«Export» says something when there is nothing", () => {
  const explorer = readFileSync(EXPLORER, "utf-8");

  it("it does not return silently with an empty table", () => {
    /**
     * It was `if (data.length === 0) return;`. It was pressed, nothing happened, no
     * message appeared and no file was downloaded — indistinguishable
     * from a broken button, and it is the most frequent case in a new installation.
     */
    const body = explorer.slice(
      explorer.indexOf("function handleExportCsv"),
      explorer.indexOf("async function openCreateModal")
    );

    expect(body.length, "`handleExportCsv` was not found").toBeGreaterThan(0);

    expect(
      /if \(data\.length === 0\) return;/.test(body),
      "a bare `return` leaves the user not knowing whether the button failed or there " +
        "was nothing. They have to be told."
    ).toBe(false);

    expect(body).toContain("toast");
  });
});

describe("«New Game» opens the form", () => {
  const games = readFileSync(GAMES_VIEW, "utf-8");
  const explorer = readFileSync(EXPLORER, "utf-8");

  it("the link explicitly asks for the creation form", () => {
    /**
     * It led to a bare `/g/kon-games`: you navigated to the kon's screen and that
     * was it. No form, no notice.
     */
    expect(
      games.includes("/g/kon-games?crear=1"),
      "«New Game» has to open the creation form, not leave the user on a list " +
        "hoping they guess the next click."
    ).toBe(true);
  });

  it("the explorer handles that parameter and clears it", () => {
    expect(explorer).toContain('searchParams.get("create")');

    /**
     * And it is removed from the URL: otherwise reloading or going back reopens the
     * form over and over.
     */
    expect(
      explorer.includes('searchParams.delete("create")'),
      "the parameter has to be cleared after opening the creation form."
    ).toBe(true);
  });
});

describe("collections use the field that exists", () => {
  const games = readFileSync(GAMES_VIEW, "utf-8");
  const schema = readFileSync(GAMES_SCHEMA, "utf-8");

  it("the table declares `title`, not `name`", () => {
    const table = schema.slice(
      schema.indexOf("export const gameCollections = pgTable("),
      schema.indexOf("export const gameCollectionEntries")
    );

    expect(table.length, "the `game_collections` table was not found").toBeGreaterThan(0);
    expect(table).toContain('title: varchar("title"');
    expect(
      /\bname: varchar\("name"/.test(table),
      "if the column were renamed `name`, this test has to be revisited " +
        "along with the panel: they are the two halves of the same contract."
    ).toBe(false);
  });

  it("the panel sends and reads `title`", () => {
    /**
     * It sent `name`, so on create `title: undefined` arrived against a
     * `NOT NULL` column and the request blew up with "Create failed". And on
     * reading the opposite happened: the API returns `title` and the panel painted
     * `c.name`, so collections came out nameless.
     *
     * It is the same failure as `tags` versus `tagIds` in the blog: the field's
     * name IS the contract, and getting it wrong gives no type error.
     */
    const collections = games.slice(
      games.indexOf("async function createCollection"),
      games.indexOf("async function deleteCollection") > 0
        ? games.indexOf("async function deleteCollection")
        : games.length
    );

    expect(collections.length, "`createCollection` was not found").toBeGreaterThan(0);
    expect(collections).toContain("title:");

    expect(
      /^\s*name: (new|edit)CollectionName/m.test(games),
      "the field that is sent has to be `title`: it is what the column is called " +
        "and what the endpoint reads."
    ).toBe(false);

    expect(
      /\{c\.name\}/.test(games),
      "when painting the collection, `c.title` has to be read: `c.name` does not exist in the " +
        "response and comes out blank."
    ).toBe(false);
  });
});
