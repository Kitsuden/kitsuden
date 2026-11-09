/**
 * The verification link returns to the panel and never to a foreign domain
 * ============================================================================
 *
 * better-auth sets `callbackURL=/` when the sign-up has no destination, and `/`
 * was resolved against the API: whoever confirmed their email ended up at the
 * API root. See `lib/link-target.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { safeTarget, setLinkTarget } from "../lib/link-target";

const PANEL = "https://panel.example.com";
const ALLOWED = ["https://api.example.com", "https://panel.example.com", "https://www.example.com"];

const link = (callback: string | null) => {
  const base = "https://api.example.com/api/auth/verify-email?token=abc.def";
  return callback === null ? base : `${base}&callbackURL=${encodeURIComponent(callback)}`;
};
const callbackOf = (url: string) => new URL(url).searchParams.get("callbackURL");

describe("safeTarget", () => {
  it("empty or `/` → the panel root, not the API's", () => {
    expect(safeTarget(undefined, PANEL, ALLOWED)).toBe("https://panel.example.com/");
    expect(safeTarget("", PANEL, ALLOWED)).toBe("https://panel.example.com/");
    expect(safeTarget("/", PANEL, ALLOWED)).toBe("https://panel.example.com/");
  });

  it("a relative path is kept, but on the panel", () => {
    expect(safeTarget("/settings?tab=profile", PANEL, ALLOWED)).toBe(
      "https://panel.example.com/settings?tab=profile"
    );
    // ADMIN_URL with a trailing slash does not duplicate the slash
    expect(safeTarget("/x", `${PANEL}/`, ALLOWED)).toBe("https://panel.example.com/x");
  });

  it("a trusted origin is respected (a public site returns to itself)", () => {
    expect(safeTarget("https://www.example.com/thanks", PANEL, ALLOWED)).toBe(
      "https://www.example.com/thanks"
    );
    expect(safeTarget("https://panel.example.com/", PANEL, [])).toBe("https://panel.example.com/");
  });

  it("it is NOT an open redirect: a foreign domain ends up on the panel", () => {
    const attacks = [
      "https://evil.example/steal",
      "http://panel.example.com/", // same host, different protocol: a different origin
      "https://panel.example.com.evil.example/",
      "https://panel.example.com@evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "/%2fevil.example",
      "javascript:alert(1)",
      "data:text/html,hello",
      "evil.example",
    ];
    for (const a of attacks) {
      expect(safeTarget(a, PANEL, ALLOWED), a).toBe("https://panel.example.com/");
    }
  });

  it("a wildcard in ALLOWED_ORIGINS authorizes nothing", () => {
    expect(safeTarget("https://x.example.com/", PANEL, ["*.example.com"])).toBe(
      "https://panel.example.com/"
    );
  });
});

describe("setLinkTarget", () => {
  it("rewrites the `callbackURL=/` that better-auth sets", () => {
    const pinnedItem = setLinkTarget(link("/"), PANEL, ALLOWED);
    expect(callbackOf(pinnedItem)).toBe("https://panel.example.com/");
    // the rest of the link does not change
    expect(new URL(pinnedItem).searchParams.get("token")).toBe("abc.def");
    expect(new URL(pinnedItem).origin + new URL(pinnedItem).pathname).toBe(
      "https://api.example.com/api/auth/verify-email"
    );
  });

  it("adds the destination if the link does not have one", () => {
    expect(callbackOf(setLinkTarget(link(null), PANEL, ALLOWED))).toBe(
      "https://panel.example.com/"
    );
  });

  it("replaces a foreign destination", () => {
    expect(callbackOf(setLinkTarget(link("https://evil.example/"), PANEL, ALLOWED))).toBe(
      "https://panel.example.com/"
    );
  });

  it("also applies to the password reset link (empty callbackURL)", () => {
    const reset = "https://api.example.com/api/auth/reset-password/tok123?callbackURL=";
    const pinnedItem = setLinkTarget(reset, PANEL, ALLOWED);
    expect(callbackOf(pinnedItem)).toBe("https://panel.example.com/");
    expect(new URL(pinnedItem).pathname).toBe("/api/auth/reset-password/tok123");
  });

  it("an unreadable link comes out untouched", () => {
    expect(setLinkTarget("not a url", PANEL, ALLOWED)).toBe("not a url");
  });
});

describe("auth.ts uses it in both emails", () => {
  const AUTH = readFileSync(join(import.meta.dir, "..", "lib", "auth.ts"), "utf8");

  it("verification and reset go through setLinkTarget", () => {
    expect(AUTH).toMatch(/verifyUrl:\s*setLinkTarget\(url, PANEL_URL, TRUSTED_ORIGINS\)/);
    expect(AUTH).toMatch(/resetUrl:\s*setLinkTarget\(url, PANEL_URL, TRUSTED_ORIGINS\)/);
  });

  it("the trust list is the same as better-auth's", () => {
    expect(AUTH).toMatch(/trustedOrigins:\s*TRUSTED_ORIGINS/);
  });
});
