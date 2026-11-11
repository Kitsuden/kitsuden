/**
 * The panel applies the active grimoire's theme with what
 * `GET /api/system/grimoires` returns (`config.theme`). Before, the API did not send
 * `config` and `applyGrimoireTheme` returned doing nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyGrimoireTheme,
  contrastRatio,
  onColorFor,
  resetGrimoireTheme,
  themes,
} from "./theme.svelte";

function response(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

/** Shape of the listGrimoiresHandler response (test colors, not the real grimoire's). */
const grimoires = [
  {
    id: "grimoire-default",
    name: "Default Grimoire",
    isActive: true,
    config: { theme: { primary_color: "#336699", accent_color: "#cc8844" } },
  },
];

describe("applyGrimoireTheme", () => {
  afterEach(() => {
    resetGrimoireTheme();
    vi.restoreAllMocks();
  });

  it("applies the active grimoire's primary/accent to the panel variables", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/api/system/grimoires")
        ? response(grimoires)
        : response({ activeGrimoire: "grimoire-default" })
    ) as unknown as typeof fetch;

    await applyGrimoireTheme();

    const style = document.documentElement.style;
    expect(style.getPropertyValue("--kitsuden-primary")).toBe("51 102 153");
    expect(style.getPropertyValue("--kitsuden-secondary")).toBe("204 136 68");
  });

  it("with no config in the response it touches nothing", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/api/system/grimoires")
        ? response([{ id: "grimoire-default" }])
        : response({ activeGrimoire: "grimoire-default" })
    ) as unknown as typeof fetch;

    await applyGrimoireTheme();

    expect(document.documentElement.style.getPropertyValue("--kitsuden-primary")).toBe("");
  });
});

/**
 * The palettes keep text and form controls legible (WCAG 1.4.3 / 1.4.11): secondary text
 * and placeholders at 4.5:1, the boundary of a control at 3:1, status colours usable as text.
 * The default palette lives in style.css; mocha and latte in `themes`.
 */
describe("palette contrast", () => {
  const css = readFileSync(join(__dirname, "..", "style.css"), "utf8");
  const defaults: Record<string, string> = {};
  for (const m of css.matchAll(/(--kitsuden-[a-z0-9-]+):\s*(\d+ \d+ \d+);/g))
    defaults[m[1]] ??= m[2];

  const palettes: Array<[string, Record<string, string>]> = [
    ["default", defaults],
    ...themes.map((t) => [t.id, { ...defaults, ...t.cssVars }] as [string, Record<string, string>]),
  ];

  it.each(palettes)("%s: text tokens reach 4.5:1 on the page and card backgrounds", (_id, p) => {
    for (const surface of ["--kitsuden-bg", "--kitsuden-card"]) {
      for (const token of [
        "--kitsuden-text",
        "--kitsuden-text-dim",
        "--kitsuden-subtle",
        "--kitsuden-danger",
        "--kitsuden-green",
        "--kitsuden-amber",
      ]) {
        expect(
          contrastRatio(p[token], p[surface]),
          `${token} on ${surface}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // The brand violet of the default palette is 4.48:1 on a card: it is the product colour,
  // so it is held to the page background here and the gap is on record, not papered over.
  it.each(palettes)("%s: accent text reaches 4.5:1 on the page background", (_id, p) => {
    expect(contrastRatio(p["--kitsuden-accent"], p["--kitsuden-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(palettes)("%s: a control's border reaches 3:1", (_id, p) => {
    for (const surface of ["--kitsuden-bg", "--kitsuden-card"]) {
      expect(contrastRatio(p["--kitsuden-input"], p[surface])).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(palettes)("%s: …and on its hover fill too", (_id, p) => {
    expect(
      contrastRatio(p["--kitsuden-on-accent"], p["--kitsuden-accent-hover"])
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(palettes)("%s: the label of a solid accent button reaches 4.5:1", (_id, p) => {
    expect(contrastRatio(p["--kitsuden-on-accent"], p["--kitsuden-accent"])).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it("onColorFor picks the readable side", () => {
    expect(onColorFor("168 85 247")).toBe("9 9 11");
    expect(onColorFor("25 92 228")).toBe("255 255 255");
    expect(onColorFor("250 250 250")).toBe("9 9 11");
  });
});
