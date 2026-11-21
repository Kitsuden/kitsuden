/**
 * H6 (security audit 2026-11-19): production outside public mode on localhost
 * addresses is warned about at startup, never refused.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { localhostDefaultWarnings } from "../../apps/api/src/lib/localhost-defaults";

const REAL = {
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://api.example.com",
  ADMIN_URL: "https://admin.example.com",
  WEB_URL: "https://example.com",
  ALLOWED_ORIGINS: "https://example.com,https://admin.example.com",
};

describe("H6: localhost defaults in production", () => {
  it("warns about every unset URL variable and an unset origins list", () => {
    const warnings = localhostDefaultWarnings({ NODE_ENV: "production" });
    expect(warnings.join("\n")).toMatch(/BETTER_AUTH_URL is not set/);
    expect(warnings.join("\n")).toMatch(/ADMIN_URL is not set/);
    expect(warnings.join("\n")).toMatch(/WEB_URL is not set/);
    expect(warnings.join("\n")).toMatch(/ALLOWED_ORIGINS is not set/);
  });

  it("warns about a URL that points to localhost and an origins list of only localhost", () => {
    const warnings = localhostDefaultWarnings({
      ...REAL,
      BETTER_AUTH_URL: "http://127.0.0.1:3001",
      ALLOWED_ORIGINS: "http://localhost:5173, http://app.localhost",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/BETTER_AUTH_URL points to localhost/);
    expect(warnings[1]).toMatch(/ALLOWED_ORIGINS lists only localhost/);
  });

  it("says nothing when the real addresses are set", () => {
    expect(localhostDefaultWarnings(REAL)).toEqual([]);
    // A localhost origin next to real ones is a normal dev extra, not a forgotten variable.
    expect(
      localhostDefaultWarnings({
        ...REAL,
        ALLOWED_ORIGINS: `${REAL.ALLOWED_ORIGINS},http://localhost:5173`,
      })
    ).toEqual([]);
  });

  it("says nothing outside production, or in public mode (which refuses instead)", () => {
    expect(localhostDefaultWarnings({ NODE_ENV: "development" })).toEqual([]);
    expect(localhostDefaultWarnings({ NODE_ENV: "production", KITSUDEN_PUBLIC: "true" })).toEqual(
      []
    );
  });

  it("config.ts warns at startup and does not exit", () => {
    const source = readFileSync(resolve(__dirname, "../../apps/api/src/lib/config.ts"), "utf8");
    const fn = source.slice(source.indexOf("function warnLocalhostDefaults"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/console\.warn/);
    expect(body).not.toMatch(/process\.exit/);
    expect(source).toMatch(/\nwarnLocalhostDefaults\(\);/);
  });
});
