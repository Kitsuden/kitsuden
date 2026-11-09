/**
 * The panel applies the active grimoire's theme with what
 * `GET /api/system/grimoires` returns (`config.theme`). Before, the API did not send
 * `config` and `applyGrimoireTheme` returned doing nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyGrimoireTheme, resetGrimoireTheme } from "./theme.svelte";

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
