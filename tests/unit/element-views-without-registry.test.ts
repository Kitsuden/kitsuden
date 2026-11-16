/**
 * A booth that needs a record has to know how to pick it
 * ============================================================================
 *
 * ── WHAT WAS SEEN ──────────────────────────────────────────────────────────
 *
 * The esports TO panel, opened on a real tournament:
 *
 *     CHECK-IN     —/—        (empty counter)
 *     PHASES       (none)
 *     SETS         (none)   «Click the winner's name»
 *
 * with eight normal-looking buttons. None did anything.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The tournament id was read like this:
 *
 *     this.#ctx?.params?.tournamentId ?? this.#ctx?.recordId ?? null
 *
 * and `AdminViewContext` —what `CustomViewHost` actually injects— is:
 *
 *     { version, konId, viewId, apiBase, theme, locale }
 *
 * Neither `params` nor `recordId`. The view is registered as a kon TAB, not
 * as a record view, so there is never one selected. The id was always
 * `null` and `#load()` opened with `if (!id) return;`: it exited silently.
 *
 * The screen was not broken on the outside. It was dead on the inside, with the
 * only possible clue —the counter at «—/—»— which reads as «no data
 * yet» and not as «this is never going to work».
 *
 * The same bug, with the same `??` and the same `return`, was in the MOBA
 * booth (`params.gameId`). That is why this guard looks at ALL views of type
 * `element`, not just the one that was fixed: it is the lesson left by the
 * four drafts that kept leaking after «fixing the leak».
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * If a view needs a record to exist and the host does not pass it, it has
 * to ask for it itself. `params` may keep priority —in case the view is ever
 * opened from a record— but it cannot be the ONLY source.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./helpers/comments";

const ROOT = join(__dirname, "..", "..");
const CONTRACT = join(ROOT, "packages", "shared", "src", "admin-view.ts");
const KONS = join(ROOT, "packages", "kons");

/**
 * Reads packages/kons/kon-esports, packages/kons/kon-broadcast and packages/kons/kon-tierlist
 * (named here so tests/unit/vitest.config.ts excludes this file when they are not installed).
 *
 * The views are Svelte now: `admin-src/` is the source and `admin/*.js` the compiled,
 * minified bundle (kitsuden-kons `pnpm build:admin`). The guards read the SOURCE: a string
 * search in a bundle says nothing about the code.
 */
function adminSource(kon: string, files: string[]): string {
  return files
    .map((f) => withoutComments(readFileSync(join(KONS, kon, "admin-src", f), "utf-8")))
    .join("\n");
}

/** Every .svelte/.ts file of a kon's admin views, without the vendored tallao kit. */
function adminSourceFiles(kon: string): string[] {
  const base = join(KONS, kon, "admin-src");
  return (readdirSync(base, { recursive: true }) as string[])
    .filter((f) => /\.(svelte|ts)$/.test(f) && !/^tallao[\\/]/.test(f))
    .map((f) => join(base, f));
}

/** The booths: `type: "element"` views that operate on a record. */
const BOOTHS = [
  {
    name: "TO panel (esports)",
    kon: "kon-esports",
    files: ["ToPanel.svelte", "store.svelte.ts", "sections/TournamentPick.svelte"],
    listing: '"/tournaments"',
    param: "params?.tournamentId",
    emptyTitle: 'emptyTitle="No tournaments yet"',
  },
  {
    name: "Broadcast live booth",
    kon: "kon-broadcast",
    files: ["LiveControl.svelte"],
    listing: '"/matches"',
    param: "params?.gameId",
    emptyTitle: '"No matchups yet"',
  },
];

describe("the host contract carries no record", () => {
  const contract = withoutComments(readFileSync(CONTRACT, "utf-8"));

  it("`AdminViewContext` has no `params` or `recordId`", () => {
    const iface = contract.slice(
      contract.indexOf("export interface AdminViewContext"),
      contract.indexOf("export function createViewContext")
    );

    expect(iface.length, "`AdminViewContext` was not found").toBeGreaterThan(0);

    /**
     * This is the fact everything else hangs on. If the contract ever
     * DOES include the record, this test fails and the booths need review —
     * which is exactly what should be done, rather than keeping a redundant selector.
     */
    for (const field of ["params", "recordId"]) {
      expect(
        new RegExp(`^\\s*${field}[?]?:`, "m").test(iface),
        `\`AdminViewContext\` declares \`${field}\`. The booths were written ` +
          `assuming it existed; if it now really exists, check whether the ` +
          `selector is still needed instead of leaving both paths.`
      ).toBe(false);
    }
  });

  it("`createViewContext` does not add it by hand either", () => {
    const fn = contract.slice(contract.indexOf("export function createViewContext"));
    expect(fn).not.toContain("recordId");
  });
});

describe.each(BOOTHS)("$name", ({ kon, files, listing, param, emptyTitle }) => {
  const code = adminSource(kon, files);

  it("does not depend only on a `params` that never arrives", () => {
    /**
     * The broken pattern was the id taken from the host and nothing else. `params` may stay
     * as priority (in case the view is ever opened from a record), but the booth also has
     * to load the list itself.
     */
    expect(code, "the record from the host is still honoured when present").toContain(param);
    expect(
      code,
      `the booth loads its own list (\`${listing}\`): the host contract carries no record`
    ).toContain(listing);
  });

  it("offers choosing the record", () => {
    expect(
      code.includes("<Select"),
      "the booth must have its own selector: it is the only way for it to " +
        "know which record it is working on."
    ).toBe(true);
  });

  it("when there is nothing to choose, it says so and says where to create one", () => {
    /**
     * An empty dropdown does not distinguish «there are none» from «it did not load». It is
     * the lesson of the tier list editor: the empty state is exactly when someone
     * needs to know what to do.
     */
    expect(code, "the empty state has to be named in text, not left blank").toContain(emptyTitle);
    expect(code, "and say where to create one").toMatch(/Create one in the \w+ tab/);
  });
});

describe("theme colors are channels, not colors", () => {
  /**
   * ── WHAT WAS SEEN ─────────────────────────────────────────────────────────
   *
   * The main button of the TO panel —«FGC Template»— came out black on
   * black, unreadable.
   *
   * ── WHY ───────────────────────────────────────────────────────────────────
   *
   * The theme defines its variables as bare CHANNELS, so that opacity can be
   * modulated without duplicating the palette:
   *
   *     "--kitsuden-accent": "168 85 247"   →   rgb(var(--kitsuden-accent) / .5)
   *
   * So `background: var(--kitsuden-accent, #00d2a8)` resolves to
   * `background: 168 85 247`, which is not a color: the whole declaration is
   * dropped. And the `var()` fallback saves nothing, because it only applies when
   * the variable is not defined — not when its value is no good there.
   *
   * Measured in the real admin, with the user's theme:
   *
   *     var(--kitsuden-accent, #00d2a8)        → rgba(0, 0, 0, 0)     ← nothing
   *     rgb(var(--kitsuden-accent, 0 210 168)) → rgb(168, 85, 247)
   *
   * With no background and `color: #04120f` on top, the button disappeared. And since it is
   * a silent failure —no console, no error— it survives any review that does not
   * look at the computed color.
   *
   * The `kon-broadcast` views did it right from the start; the esports,
   * MOBA and tier list ones did not. Three out of five.
   */
  // The views' Svelte sources (the vendored tallao kit has its own tokens and tests)
  const VIEWS = ["kon-esports", "kon-broadcast", "kon-tierlist"].flatMap(adminSourceFiles);

  /** The ones the theme defines as channels. `radius` and `font` are not colors. */
  const HEX_COLOR =
    "accent|accent-2|accent-dim|accent-hover|border|bg|surface|surface-2|card|muted|" +
    "fg|text|text-dim|subtle|danger|amber|yellow|green|cyan|pink|purple|primary|secondary";

  const DECLARATION = new RegExp(
    `(?:background|background-color|color|border|border-[a-z]+|outline|fill|stroke|box-shadow)` +
      `\\s*:[^;{}]*?var\\(\\s*--kitsuden-(?:${HEX_COLOR})\\b[^;{}]*`,
    "g"
  );

  it.each(VIEWS)("%s wraps the color in rgb()", (file) => {
    // Comments excluded: these files DOCUMENT the broken pattern to explain
    // why it is not used. A guard that punishes the note explaining its own
    // rule teaches people to ignore it.
    const code = withoutComments(readFileSync(file, "utf-8"));

    const rawOnes = [...code.matchAll(DECLARATION)]
      .map((m) => m[0].trim())
      .filter((d) => !d.includes("rgb("));

    expect(
      rawOnes,
      `These declarations use a theme variable as if it were a color:\n` +
        rawOnes.map((d) => `    ${d}`).join("\n") +
        `\n\nThe theme defines them as channels ("168 85 247"), so the ` +
        `declaration is invalid and gets dropped, with no error. Wrap them: ` +
        `\`rgb(var(--kitsuden-accent, 0 210 168) / 1)\`.`
    ).toEqual([]);
  });

  it("the fallback is in channels too", () => {
    /**
     * `rgb(var(--x, #00d2a8))` is just as invalid when the variable is not
     * defined: the fallback is substituted as-is inside the `rgb()`.
     */
    for (const file of VIEWS) {
      const code = withoutComments(readFileSync(file, "utf-8"));
      const badOnes = [
        ...code.matchAll(/rgb\(\s*var\(\s*--kitsuden-[a-z0-9-]+\s*,\s*(#[0-9a-fA-F]+)/g),
      ];

      expect(
        badOnes.map((m) => m[0]),
        `in ${file} the fallback inside \`rgb()\` is a hex; it has to be ` +
          `"r g b" so the result is still a valid color.`
      ).toEqual([]);
    }
  });
});

describe("the TO panel does not work for just one format", () => {
  /**
   * ── WHAT HAPPENED ─────────────────────────────────────────────────────────
   *
   * The panel always requested `GET /matches/tournament/:id/bracket`. And that route
   * THROWS when the tournament is not elimination:
   *
   *     if (tournament.bracketFormat === "swiss") {
   *       throw new Error("[bracket] this tournament is Swiss; use swiss.persistence");
   *
   * So opening a Swiss tournament left that message —true, and useless to whoever
   * is running a tournament— in the error box, and not a single set in view.
   *
   * ── AND WHAT IT COULD NOT DO ──────────────────────────────────────────────
   *
   * In Swiss there was no safe route to report. `applyResult` goes through
   * `loadBracket` (throws), and the generic `PUT /matches/:id` marked the TOURNAMENT as
   * finished when the set has no `nextMatchId` —in Swiss, always—.
   * Reporting the first set of round 1 closed the tournament, so the panel
   * showed those sets read-only.
   *
   * Not anymore: `POST /matches/tournament/:id/report` has its Swiss branch, and
   * `PUT` rejects Swiss and round robin with 409 saying which route to use.
   */
  const ROUTES = join(KONS, "kon-esports", "esports.routes.ts");
  // The panel's logic is in its store; the Swiss table is its own section.
  const panel = adminSource("kon-esports", ["store.svelte.ts", "ToPanel.svelte"]);
  const swissSection = adminSource("kon-esports", ["sections/Swiss.svelte"]);

  it("the premise is still true: the bracket throws outside elimination", () => {
    /**
     * If `loadBracket` ever stops throwing, this test fails and it is time to
     * check whether the per-format split is still needed — instead of
     * carrying it along without knowing why it is there.
     */
    const persistence = readFileSync(
      join(ROOT, "packages", "kons", "kon-esports", "bracket.persistence.ts"),
      "utf-8"
    );
    expect(persistence).toContain("this tournament is Swiss");
    expect(persistence).toContain("this tournament is round robin");
  });

  it("`PUT /matches/:id` can no longer close a Swiss or round robin tournament", () => {
    /**
     * That route marks the tournament as finished when the set does not chain into another.
     * In elimination that is the grand final; in Swiss and round robin it is every
     * set. It has to look at the format BEFORE writing anything.
     */
    const routes = readFileSync(ROUTES, "utf-8");
    const from = routes.indexOf('id: "report-set-manual"');
    expect(from, "the manual report route was not found").toBeGreaterThan(-1);
    const put = routes.slice(from);
    const body = put.slice(0, put.indexOf(".update(matches)"));

    expect(body, "the PUT has to look at the format before touching the row").toContain('"swiss"');
    expect(body).toContain('"round_robin"');
    expect(body, "and respond 409 with the right route").toContain("409");
    expect(body).toContain("/report");
  });

  it("the report route has its Swiss branch", () => {
    const routes = readFileSync(ROUTES, "utf-8");
    const start = routes.indexOf('"/tournament/:tournamentId/report"');
    expect(start, "the report route was not found").toBeGreaterThan(-1);

    const body = routes.slice(start, routes.indexOf("// ── Round robin", start));
    expect(body).toContain('tournament.bracketFormat === "swiss"');
    expect(body, "the table is recomputed from the rows, not made up").toContain("loadSwissState");
    // SDK operation of kons: the schema is declared and the SDK enforces it
    expect(body, "the body goes through a schema: a misnamed field cannot be lost").toContain(
      "body: ReportResult"
    );
  });

  it("the panel splits by format instead of always requesting the bracket", () => {
    expect(panel).toContain("bracketFormat");
    expect(panel, "there has to be a branch for Swiss").toContain('=== "swiss"');
    expect(panel, "and another for round robin").toContain('=== "round_robin"');
  });

  it("a Swiss tournament is reported from the panel, by row", () => {
    /**
     * With the Swiss branch, its sets are clicked like any other. `matchId`
     * —the row— is sent because with phases the engine id can repeat.
     */
    expect(panel).toContain(
      'if (this.format === "swiss" || this.format === "round_robin") return this.setsFromRows()'
    );
    expect(panel).toContain("matchId: set.rowId");
  });

  it("Swiss can advance a round and show its cut", () => {
    // What is safe: pairing and querying. Those are Swiss's own routes.
    expect(panel).toContain("swiss/next-round");
    expect(panel).toContain("swiss/cut");
    expect(
      swissSection,
      "the Swiss tiebreak is OMW; without it the table looks arbitrary"
    ).toContain("OMW");
  });
});
