/**
 * `GET /api/system/grimoires` returns from `config` only what the panel uses
 * (`config.theme`), field by field. The rest of the manifest does not go out.
 */
import { describe, it, expect } from "bun:test";

import { grimoirePublicConfig } from "../routes/system";

describe("grimoirePublicConfig", () => {
  it("copies the colors and the --kitsuden-* css_vars", () => {
    expect(
      grimoirePublicConfig({
        theme: {
          primary_color: "#00e5ff",
          accent_color: "#ff2a6d",
          css_vars: { "--kitsuden-bg": "9 9 11", "--other": "x", "--kitsuden-n": 3 },
        },
      })
    ).toEqual({
      theme: {
        primary_color: "#00e5ff",
        accent_color: "#ff2a6d",
        css_vars: { "--kitsuden-bg": "9 9 11" },
      },
    });
  });

  it("lets nothing out outside theme nor unknown keys inside it", () => {
    const output = grimoirePublicConfig({
      apiKey: "must-not-leak",
      webhooks: { url: "https://x" },
      theme: { primary_color: "#fff", token: "must-not-leak", css_entry: "variables.css" },
    });
    expect(output).toEqual({ theme: { primary_color: "#fff" } });
    expect(JSON.stringify(output)).not.toContain("must-not-leak");
  });

  it("without config or without theme it returns an empty object", () => {
    expect(grimoirePublicConfig(undefined)).toEqual({});
    expect(grimoirePublicConfig({ other: 1 })).toEqual({});
    expect(grimoirePublicConfig({ theme: "red" })).toEqual({});
  });
});
