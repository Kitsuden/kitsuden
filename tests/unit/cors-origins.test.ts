/**
 * CORS: only the fixed list
 *
 * Until 2026-09-21 the site's subdomains were accepted by rule (each wiki and
 * esports lived on its own). There are no subdomains any more, and what is
 * guarded is that the wildcard does not come back: it would widen, for no
 * reason, who can call the API with the session cookie.
 */

import { describe, expect, it } from "vitest";

import { incompleteCorsWarning, allowedOrigin } from "../../apps/api/src/lib/cors-origins";

const FIXED = ["https://example.com", "https://cms.example.com"];

describe("allowedOrigin", () => {
  it("accepts the fixed list as is", () => {
    const f = allowedOrigin(FIXED);
    expect(f("https://cms.example.com")).toBe("https://cms.example.com");
    expect(f("https://example.com")).toBe("https://example.com");
  });

  it("no longer accepts the site's subdomains: wikis and esports go by path", () => {
    const f = allowedOrigin(FIXED);
    expect(f("https://aniimo.example.com")).toBeNull();
    expect(f("https://esports.example.com")).toBeNull();
    expect(f("http://aniimo.localhost:4321")).toBeNull();
  });

  it("rejects what is not exactly an origin in the list", () => {
    const f = allowedOrigin(FIXED);
    expect(f("")).toBeNull();
    expect(f("null")).toBeNull();
    expect(f("https://example.com/")).toBeNull();
    expect(f("http://example.com")).toBeNull();
    expect(f("https://example.com.evil.com")).toBeNull();
  });
});

describe("the startup warning", () => {
  it("warns when the public site is NOT in the fixed list", () => {
    // The real case: the wildcard covers `aniimo.example.com` but not
    // `example.com`, so login and comments fail ON THE WEB
    const warning = incompleteCorsWarning(["https://cms.example.com"], "https://example.com");
    expect(warning).toMatch(/ALLOWED_ORIGINS/);
    expect(warning).toContain("https://example.com");
    expect(warning).toMatch(/Sister sites/);
  });

  it("stays quiet when it is set up right", () => {
    expect(
      incompleteCorsWarning(
        ["https://example.com", "https://cms.example.com"],
        "https://example.com"
      )
    ).toBeNull();
  });

  it("scheme and port count: they are different origins", () => {
    expect(incompleteCorsWarning(["http://example.com"], "https://example.com")).not.toBeNull();
    expect(
      incompleteCorsWarning(["http://localhost:4351"], "http://localhost:4321")
    ).not.toBeNull();
    expect(incompleteCorsWarning(["http://localhost:4321"], "http://localhost:4321")).toBeNull();
  });

  it("without a site URL it does not invent a warning", () => {
    expect(incompleteCorsWarning([], "not a url")).toBeNull();
  });
});
