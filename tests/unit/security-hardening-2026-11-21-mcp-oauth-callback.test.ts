/**
 * Security hardening 2026-11-21: the external MCP OAuth callback is bound to its starter
 * ============================================================================
 *
 * `GET /api/mcp-oauth/callback` was authorized by the single-use `state` alone. An admin's
 * authorization link, opened by another person (sent by mistake, or on purpose), connected
 * the server to that person's account at the authorization server. Like the connections
 * OAuth (PR #44), the callback now has to come from whoever started it: a session of the
 * same admin (never an agent), or the browser that holds the HttpOnly binding cookie the
 * start set. Otherwise the state is burnt before any token exchange and the panel gets an
 * error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../apps/api/src/db", () => ({ db: { execute } }));

import {
  bindingCookie,
  browserBindingOf,
  completeOAuth,
  finishedByStarter,
  OAUTH_BINDING_COOKIE,
  OAUTH_CALLBACK_PATH,
  OAuthProblem,
} from "../../apps/api/src/lib/external-mcp-oauth";

const STATE = "s".repeat(43);
const ADMIN = "admin-user-1";

/** The row the callback's DELETE … RETURNING finds: live, started by ADMIN. */
const pendingRow = () => [
  {
    server_id: "00000000-0000-0000-0000-000000000001",
    code_verifier: { valueEncrypted: "x" },
    pending: { resource: "https://mcp.example.com/mcp", tokenEndpoint: "https://as/token" },
    started_by: ADMIN,
    live: true,
  },
];

describe("finishedByStarter", () => {
  it("accepts the same admin's session or this round trip's binding, and nothing else", () => {
    const binding = browserBindingOf(STATE);
    expect(finishedByStarter(STATE, ADMIN, { userId: ADMIN, browserBinding: null })).toBe(true);
    expect(finishedByStarter(STATE, ADMIN, { userId: null, browserBinding: binding })).toBe(true);
    // Another person's session, no cookie at all, or the binding of another round trip.
    expect(finishedByStarter(STATE, ADMIN, { userId: "someone-else", browserBinding: null })).toBe(
      false
    );
    expect(finishedByStarter(STATE, ADMIN, { userId: null, browserBinding: null })).toBe(false);
    expect(
      finishedByStarter(STATE, ADMIN, {
        userId: null,
        browserBinding: browserBindingOf("another-state"),
      })
    ).toBe(false);
    expect(finishedByStarter(STATE, ADMIN, { userId: null, browserBinding: "short" })).toBe(false);
    // A start with no recorded admin is never matched by "no user".
    expect(finishedByStarter(STATE, null, { userId: null, browserBinding: null })).toBe(false);
  });

  it("the binding is derived from the state, and differs from the connections binding", () => {
    expect(browserBindingOf(STATE)).toMatch(/^[\w-]{43}$/);
    expect(browserBindingOf(STATE)).not.toBe(browserBindingOf(`${STATE}x`));
    const connections = readFileSync(
      resolve(__dirname, "../../apps/api/src/lib/connections/service.ts"),
      "utf8"
    );
    expect(connections).toContain("kitsuden-connections:browser:");
    const own = readFileSync(
      resolve(__dirname, "../../apps/api/src/lib/external-mcp-oauth.ts"),
      "utf8"
    );
    expect(own).toContain("kitsuden-external-mcp:browser:");
  });

  it("the cookie is HttpOnly, SameSite=Lax, scoped to the callback and as short as the state", () => {
    const cookie = bindingCookie("v");
    expect(cookie.startsWith(`${OAUTH_BINDING_COOKIE}=v;`)).toBe(true);
    expect(cookie).toContain(`Path=${OAUTH_CALLBACK_PATH}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
  });
});

describe("completeOAuth", () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it("refuses a callback nobody bound, after burning the state and before any exchange", async () => {
    execute.mockResolvedValueOnce(pendingRow());
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      completeOAuth(STATE, "code", { userId: null, browserBinding: null })
    ).rejects.toThrow(OAuthProblem);
    await expect(
      (async () => {
        execute.mockResolvedValueOnce(pendingRow());
        return completeOAuth(STATE, "code", { userId: "another-admin", browserBinding: null });
      })()
    ).rejects.toThrow(/another browser or by another person/);
    // Only the DELETE … RETURNING ran (one per call): the state is gone, nothing else was read
    // or exchanged.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("goes on with the starter's session or binding cookie", async () => {
    // The second query (the server's URL) answers nothing: the flow stopped AFTER the binding
    // check, at the URL check.
    for (const completedBy of [
      { userId: ADMIN, browserBinding: null },
      { userId: null, browserBinding: browserBindingOf(STATE) },
    ]) {
      execute.mockResolvedValueOnce(pendingRow()).mockResolvedValueOnce([]);
      await expect(completeOAuth(STATE, "code", completedBy)).rejects.toThrow(/URL changed/);
    }
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("an unknown state is still refused first", async () => {
    execute.mockResolvedValueOnce([]);
    await expect(
      completeOAuth(STATE, "code", { userId: ADMIN, browserBinding: browserBindingOf(STATE) })
    ).rejects.toThrow(/unknown or has expired/);
  });
});

describe("the routes", () => {
  const routes = readFileSync(
    resolve(__dirname, "../../apps/api/src/routes/mcp-servers.ts"),
    "utf8"
  );
  const callback = routes.slice(routes.indexOf('id: "mcp-server-oauth-callback"'));

  it("the start sets the binding cookie and does not return it in the body", () => {
    expect(routes).toContain("bindingCookie(browserBinding)");
    expect(routes).toMatch(/const \{ browserBinding, \.\.\.data \} = await startOAuth/);
  });

  it("the callback reads an optional session, never an agent, plus the cookie, and clears it", () => {
    expect(callback).toContain('access: "optional"');
    expect(callback).not.toContain('access: "public"');
    expect(callback).toContain("getCookie(c, OAUTH_BINDING_COOKIE)");
    expect(callback).toContain('person?.role === "agent"');
    expect(callback).toContain("clearedBindingCookie()");
  });
});
