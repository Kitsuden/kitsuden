/**
 * OAuth: `resource` without quadratic backtracking (F16) and no open
 * redirector in /authorize errors (F68). Pure functions of lib/oauth/uris.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_RESOURCE_LENGTH,
  errorMayRedirect,
  invalidRedirectReason,
  requestedResource,
  withoutTrailingSlashes,
} from "../../apps/api/src/lib/oauth/uris";

const ISSUER = "https://api.example.test";
let previous: string | undefined;

beforeAll(() => {
  previous = process.env.OAUTH_ISSUER_URL;
  process.env.OAUTH_ISSUER_URL = ISSUER;
});
afterAll(() => {
  if (previous === undefined) delete process.env.OAUTH_ISSUER_URL;
  else process.env.OAUTH_ISSUER_URL = previous;
});

describe("requestedResource (F16)", () => {
  it("accepts the resource with or without trailing slashes and rejects another", () => {
    expect(requestedResource(`${ISSUER}/api/mcp`)).toEqual({
      ok: true,
      resource: `${ISSUER}/api/mcp`,
    });
    expect(requestedResource(`${ISSUER}/api/mcp///`)).toMatchObject({ ok: true });
    expect(requestedResource("HTTPS://API.EXAMPLE.TEST/api/mcp/")).toMatchObject({ ok: true });
    expect(requestedResource("https://evil.example/api/mcp")).toEqual({ ok: false });
    expect(requestedResource(undefined)).toBeNull();
  });

  it("thousands of slashes cost nothing and a huge resource is rejected without parsing", () => {
    const start = performance.now();
    expect(requestedResource(`${ISSUER}/${"/".repeat(15_000)}x`)).toEqual({ ok: false });
    expect(requestedResource(`${ISSUER}/${"/".repeat(1_900)}x`)).toEqual({ ok: false });
    expect(withoutTrailingSlashes(`/a${"/".repeat(100_000)}`)).toBe("/a");
    expect(performance.now() - start).toBeLessThan(50);
    expect(requestedResource(`${ISSUER}/api/mcp?${"a".repeat(MAX_RESOURCE_LENGTH)}`)).toEqual({
      ok: false,
    });
  });

  it("withoutTrailingSlashes", () => {
    expect(withoutTrailingSlashes("/api/mcp")).toBe("/api/mcp");
    expect(withoutTrailingSlashes("/api/mcp//")).toBe("/api/mcp");
    expect(withoutTrailingSlashes("///")).toBe("");
    expect(withoutTrailingSlashes("")).toBe("");
  });
});

describe("/authorize errors (F68)", () => {
  it("are only returned with a 302 to loopback or to an already approved client", () => {
    expect(errorMayRedirect("http://127.0.0.1:5000/callback", false)).toBe(true);
    expect(errorMayRedirect("http://localhost/cb", false)).toBe(true);
    expect(errorMayRedirect("https://evil.example/login", false)).toBe(false);
    expect(errorMayRedirect("cursor://anysphere.cursor-mcp/oauth/callback", false)).toBe(false);
    expect(errorMayRedirect("https://client.example/cb", true)).toBe(true);
    expect(errorMayRedirect("not a url", false)).toBe(false);
  });

  it("registration rejects dangerous system handlers and keeps those of MCP clients", () => {
    for (const bad of [
      "ms-msdt:/id PCWDiagnostic",
      "ms-officecmd:x",
      "search-ms:query=x",
      "shell:startup",
      "mailto:a@b.c",
    ]) {
      expect(invalidRedirectReason(bad), bad).not.toBeNull();
    }
    for (const good of [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "vscode://vscode.github-authentication/did-authenticate",
      "com.example.app:/cb",
      "http://127.0.0.1/callback",
      "https://client.example/cb",
    ]) {
      expect(invalidRedirectReason(good), good).toBeNull();
    }
  });
});
