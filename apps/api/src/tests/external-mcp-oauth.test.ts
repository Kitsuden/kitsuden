/**
 * External MCP servers: OAuth (lib/external-mcp-oauth.ts)
 * ============================================================================
 *
 * Against the real app (test Postgres) and ONE fake server on 127.0.0.1 that is
 * both the MCP server and its authorization server (metadata, dynamic client
 * registration, token endpoint with refresh-token rotation), with
 * `KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL=true`. What has to hold:
 *
 *   · start discovers the authorization server, registers a client and answers
 *     a URL with PKCE (S256), the `state` and the `resource`;
 *   · the callback exchanges the code with the verifier of THAT start, stores
 *     the tokens encrypted and never returns them; the state is single use;
 *   · every connection then carries `Authorization: Bearer`, and a token about
 *     to end is refreshed first, once even when two callers arrive together;
 *   · a new URL, a static header or a disconnect forgets the tokens;
 *   · a server without S256, an unknown or expired state, and an agent (even
 *     with `admin`) are refused;
 *   · the callback is accepted only from the admin who started (their session)
 *     or the browser holding the binding cookie the start set; anyone else
 *     burns the state and nothing is exchanged (security hardening 2026-11-21).
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { app } from "../index";
import { oauthBearer, oauthRedirectUri } from "../lib/external-mcp-oauth";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

setDefaultTimeout(90_000);

const ORIGIN = "http://localhost:4321";
const BASE = "/api/admin/mcp-servers";
const tag = `xoauth-${generateTestId()}`;

let dbAvailable = false;
let cookie = "";
let agentToken = "";
let serverId = "";
let fake: Server;
let port = 0;

/** What the fake authorization server knows and saw. */
const as = {
  s256: true,
  registration: true,
  expiresIn: 3600,
  challenge: "",
  issued: 0,
  access: "",
  refresh: "",
  registered: [] as Array<Record<string, unknown>>,
  tokenCalls: [] as Array<Record<string, string>>,
  mcpAuth: [] as string[],
};

function issue() {
  as.issued++;
  as.access = `at-${as.issued}-${tag}`;
  as.refresh = `rt-${as.issued}-${tag}`;
  return {
    access_token: as.access,
    refresh_token: as.refresh,
    token_type: "Bearer",
    expires_in: as.expiresIn,
    scope: "tools",
  };
}

async function request(
  auth: { cookie?: string; token?: string },
  method: string,
  path: string,
  body?: unknown
) {
  const headers: Record<string, string> = { origin: ORIGIN, "Content-Type": "application/json" };
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await db.execute(query)) as unknown;
  return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Starts an authorization and plays the authorization server's part of the redirect. */
async function start(
  body?: unknown
): Promise<{ url: URL; state: string; bindingCookie: string; setCookie: string }> {
  const r = await request({ cookie }, "POST", `${BASE}/${serverId}/oauth/start`, body ?? {});
  expect(r.status).toBe(200);
  const json = (await r.json()) as Record<string, unknown>;
  // The binding travels only in the HttpOnly cookie, never in the body.
  expect(json).not.toHaveProperty("browserBinding");
  const url = new URL(json.authorizationUrl as string);
  as.challenge = url.searchParams.get("code_challenge") ?? "";
  const setCookie = r.headers.get("set-cookie") ?? "";
  const binding = /kitsuden_mcp_oauth=([^;]+)/.exec(setCookie)?.[1] ?? "";
  return {
    url,
    state: url.searchParams.get("state") ?? "",
    bindingCookie: `kitsuden_mcp_oauth=${binding}`,
    setCookie,
  };
}

/** The callback as the browser brings it; by default the admin who started, signed in. */
const callback = (query: Record<string, string>, auth: { cookie?: string } = { cookie }) =>
  request(auth, "GET", `/api/mcp-oauth/callback?${new URLSearchParams(query).toString()}`);

const serverRow = async () =>
  (
    await rows<{
      oauth_config: Record<string, unknown> | null;
      oauth_secret: Record<string, unknown> | null;
      auth_header_name: string | null;
    }>(
      sql`SELECT oauth_config, oauth_secret, auth_header_name FROM external_mcp_servers WHERE id = ${serverId}::uuid`
    )
  )[0]!;

const expireAccessToken = () =>
  db.execute(sql`
    UPDATE external_mcp_servers
       SET oauth_config = jsonb_set(oauth_config, '{expiresAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))
     WHERE id = ${serverId}::uuid`);

describe("external MCP: OAuth", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL = "true";
    ({ cookie } = await enterAs(app, {
      email: `${tag}@example.com`,
      password: "TestPassword123!",
      name: "MCP OAuth Admin",
      role: "admin",
    }));
    ({ plainApiKey: agentToken } = await createAgent({
      name: `${tag}-agent`,
      scopes: ["admin"],
      rateLimit: 100_000,
    }));

    fake = createServer((req, res) => {
      const origin = `http://127.0.0.1:${port}`;
      const path = (req.url ?? "").split("?")[0];
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.method === "GET" && path === "/.well-known/oauth-protected-resource/mcp") {
          return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        }
        if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
          return json(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            ...(as.registration ? { registration_endpoint: `${origin}/register` } : {}),
            code_challenge_methods_supported: as.s256 ? ["S256"] : ["plain"],
          });
        }
        if (req.method === "POST" && path === "/register") {
          as.registered.push(JSON.parse(raw) as Record<string, unknown>);
          return json(201, { client_id: `dyn-${as.registered.length}` });
        }
        if (req.method === "POST" && path === "/token") {
          const form = Object.fromEntries(new URLSearchParams(raw));
          as.tokenCalls.push({ ...form, authorization: String(req.headers.authorization ?? "") });
          if (form.grant_type === "authorization_code") {
            const challenge = createHash("sha256")
              .update(form.code_verifier ?? "")
              .digest("base64url");
            if (form.code !== "good-code" || challenge !== as.challenge) {
              return json(400, { error: "invalid_grant", error_description: "secret detail" });
            }
            return json(200, issue());
          }
          if (form.grant_type === "refresh_token") {
            // Rotation: a refresh token works once.
            if (form.refresh_token !== as.refresh) return json(400, { error: "invalid_grant" });
            return json(200, issue());
          }
          return json(400, { error: "unsupported_grant_type" });
        }
        if (req.method === "POST" && path === "/mcp") {
          const auth = String(req.headers.authorization ?? "");
          as.mcpAuth.push(auth);
          if (auth !== `Bearer ${as.access}`) return json(401, { error: "unauthorized" });
          const msg = JSON.parse(raw) as {
            id?: number;
            method: string;
            params?: { protocolVersion?: string };
          };
          if (msg.id === undefined) {
            res.statusCode = 202;
            return res.end();
          }
          const result =
            msg.method === "initialize"
              ? {
                  protocolVersion: msg.params?.protocolVersion,
                  capabilities: { tools: {} },
                  serverInfo: { name: "fake", version: "1.0.0" },
                }
              : msg.method === "tools/list"
                ? {
                    tools: [
                      { name: "search", description: "Search", inputSchema: { type: "object" } },
                    ],
                  }
                : {};
          return json(200, { jsonrpc: "2.0", id: msg.id, result });
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    port = (fake.address() as { port: number }).port;

    const created = await request({ cookie }, "POST", BASE, {
      name: `${tag}-main`,
      url: `http://127.0.0.1:${port}/mcp`,
      authHeaderName: "X-Api-Key",
      authHeaderValue: "old-static-key",
    });
    serverId = ((await created.json()) as { id: string }).id;
  }, 90_000);

  afterAll(async () => {
    fake?.close();
    delete process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL;
    if (dbAvailable) {
      await db.execute(sql`DELETE FROM external_mcp_servers WHERE name LIKE ${`${tag}%`}`);
    }
  });

  it("start: discovers, registers a client and answers a URL with PKCE, state and resource", async () => {
    if (!dbAvailable) return;
    const { url, state } = await start({ scopes: "tools" });
    expect(`${url.origin}${url.pathname}`).toBe(`http://127.0.0.1:${port}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("dyn-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("resource")).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(url.searchParams.get("redirect_uri")).toBe(oauthRedirectUri());
    expect(url.searchParams.get("scope")).toBe("tools");
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(as.registered[0]).toMatchObject({
      redirect_uris: [oauthRedirectUri()],
      token_endpoint_auth_method: "none",
    });

    // Stored hashed, the verifier encrypted; nothing changed on the server yet.
    const states = await rows<{ state_hash: string; code_verifier: unknown }>(
      sql`SELECT state_hash, code_verifier FROM external_mcp_oauth_states WHERE server_id = ${serverId}::uuid`
    );
    expect(states).toHaveLength(1);
    expect(states[0]!.state_hash).not.toBe(state);
    expect(JSON.stringify(states[0]!.code_verifier)).toContain("valueEncrypted");
    const row = await serverRow();
    expect(row.oauth_config).toBeNull();
    expect(row.auth_header_name).toBe("X-Api-Key");
  });

  it("the callback refuses a wrong code and an unknown state, and the state does not survive", async () => {
    if (!dbAvailable) return;
    const { state } = await start();
    const wrong = await callback({ state, code: "bad-code" });
    expect(wrong.status).toBe(302);
    const location = new URL(wrong.headers.get("location")!);
    expect(location.pathname).toBe("/mcp-servers");
    expect(location.searchParams.get("oauth")).toBe("error");
    // The authorization server's error code, never its description.
    expect(location.searchParams.get("message")).toContain("invalid_grant");
    expect(location.searchParams.get("message")).not.toContain("secret detail");

    // Used once, even though it failed: the right code no longer works with it.
    const again = await callback({ state, code: "good-code" });
    expect(new URL(again.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    const unknown = await callback({ state: "never-issued", code: "good-code" });
    expect(new URL(unknown.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    const denied = await callback({ error: "access_denied<script>" });
    expect(new URL(denied.headers.get("location")!).searchParams.get("reason")).toBe(
      "access_deniedscript"
    );
    expect((await serverRow()).oauth_config).toBeNull();
  });

  it("an expired state is refused", async () => {
    if (!dbAvailable) return;
    const { state } = await start();
    await db.execute(
      sql`UPDATE external_mcp_oauth_states SET expires_at = now() - interval '1 minute' WHERE server_id = ${serverId}::uuid`
    );
    const r = await callback({ state, code: "good-code" });
    expect(new URL(r.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    expect((await serverRow()).oauth_config).toBeNull();
  });

  it("the callback connects: tokens encrypted, never returned, and OAuth replaces the header", async () => {
    if (!dbAvailable) return;
    const { state } = await start();
    const r = await callback({ state, code: "good-code" });
    const location = new URL(r.headers.get("location")!);
    expect(location.searchParams.get("oauth")).toBe("connected");
    expect(location.searchParams.get("server")).toBe(serverId);

    const exchange = as.tokenCalls.at(-1)!;
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: oauthRedirectUri(),
      resource: `http://127.0.0.1:${port}/mcp`,
    });

    const row = await serverRow();
    expect(row.auth_header_name).toBeNull();
    expect(row.oauth_config).toMatchObject({ issuer: `http://127.0.0.1:${port}`, scopes: "tools" });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(as.access);
    expect(stored).not.toContain(as.refresh);

    const list = await (await request({ cookie }, "GET", BASE)).text();
    expect(list).not.toContain(as.access);
    expect(list).not.toContain(as.refresh);
    const view = (JSON.parse(list) as { docs: Array<Record<string, unknown>> }).docs.find(
      (s) => s.id === serverId
    )!;
    expect(view).toMatchObject({ auth: "oauth", hasAuth: true, authHeaderName: null });
    expect(view.oauth).toMatchObject({ issuer: `http://127.0.0.1:${port}` });
  });

  it("a refresh of the tools carries the bearer token", async () => {
    if (!dbAvailable) return;
    as.mcpAuth.length = 0;
    const r = await request({ cookie }, "POST", `${BASE}/${serverId}/refresh`);
    const body = (await r.json()) as { ok: boolean; tools: number };
    expect(body).toMatchObject({ ok: true, tools: 1 });
    expect(as.mcpAuth.length).toBeGreaterThan(0);
    expect(new Set(as.mcpAuth)).toEqual(new Set([`Bearer ${as.access}`]));
  });

  it("a token about to end is refreshed first, once for two callers", async () => {
    if (!dbAvailable) return;
    const before = as.tokenCalls.length;
    const old = as.access;
    await expireAccessToken();
    const [a, b] = await Promise.all([oauthBearer(serverId), oauthBearer(serverId)]);
    expect(a).toBe(as.access);
    expect(b).toBe(as.access);
    expect(a).not.toBe(old);
    const calls = as.tokenCalls.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ grant_type: "refresh_token" });

    // The rotated refresh token was stored: the next expiry refreshes again.
    await expireAccessToken();
    expect(await oauthBearer(serverId)).toBe(as.access);
    expect(as.tokenCalls.slice(before)).toHaveLength(2);
    // And the tools still load with the new token.
    const r = await request({ cookie }, "POST", `${BASE}/${serverId}/refresh`);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("a refresh the server refuses is an error on the server, not a crash", async () => {
    if (!dbAvailable) return;
    const kept = as.refresh;
    as.refresh = "revoked-elsewhere";
    await expireAccessToken();
    const r = await request({ cookie }, "POST", `${BASE}/${serverId}/refresh`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("token refresh");
    as.refresh = kept;
  });

  it("a static header, a new URL and a disconnect each forget the tokens", async () => {
    if (!dbAvailable) return;
    const connect = async () => {
      const { state } = await start();
      await callback({ state, code: "good-code" });
      expect((await serverRow()).oauth_config).not.toBeNull();
    };

    await request({ cookie }, "PATCH", `${BASE}/${serverId}`, {
      authHeaderName: "X-Api-Key",
      authHeaderValue: "static-again",
    });
    let row = await serverRow();
    expect(row.oauth_config).toBeNull();
    expect(row.oauth_secret).toBeNull();
    expect(row.auth_header_name).toBe("X-Api-Key");

    await connect();
    await request({ cookie }, "PATCH", `${BASE}/${serverId}`, {
      url: `http://127.0.0.1:${port}/mcp?v=2`,
    });
    row = await serverRow();
    expect(row.oauth_config).toBeNull();
    expect(row.oauth_secret).toBeNull();
    await request({ cookie }, "PATCH", `${BASE}/${serverId}`, {
      url: `http://127.0.0.1:${port}/mcp`,
    });

    await connect();
    const off = await request({ cookie }, "DELETE", `${BASE}/${serverId}/oauth`);
    expect(await off.json()).toEqual({ success: true });
    row = await serverRow();
    expect(row.oauth_config).toBeNull();
    expect(row.oauth_secret).toBeNull();
    expect(await oauthBearer(serverId)).toBeNull();
    const twice = await request({ cookie }, "DELETE", `${BASE}/${serverId}/oauth`);
    expect(await twice.json()).toEqual({ success: false });
  });

  it("a state started for one URL does not connect after the URL changed", async () => {
    if (!dbAvailable) return;
    const { state } = await start();
    await request({ cookie }, "PATCH", `${BASE}/${serverId}`, {
      url: `http://127.0.0.1:${port}/mcp?moved=1`,
    });
    const r = await callback({ state, code: "good-code" });
    expect(new URL(r.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    expect((await serverRow()).oauth_config).toBeNull();
    await request({ cookie }, "PATCH", `${BASE}/${serverId}`, {
      url: `http://127.0.0.1:${port}/mcp`,
    });
  });

  it("refused: no S256, no registration without a clientId, an internal address without the opt-in", async () => {
    if (!dbAvailable) return;
    as.s256 = false;
    const noPkce = await request({ cookie }, "POST", `${BASE}/${serverId}/oauth/start`, {});
    expect(noPkce.status).toBe(400);
    expect(((await noPkce.json()) as { error: string }).error).toContain("S256");
    as.s256 = true;

    as.registration = false;
    const noDcr = await request({ cookie }, "POST", `${BASE}/${serverId}/oauth/start`, {});
    expect(noDcr.status).toBe(400);
    expect(((await noDcr.json()) as { error: string }).error).toContain("clientId");
    // With a client registered by hand it starts, and nothing is registered.
    const registered = as.registered.length;
    const { url } = await start({ clientId: "by-hand", clientSecret: "by-hand-secret" });
    expect(url.searchParams.get("client_id")).toBe("by-hand");
    expect(as.registered).toHaveLength(registered);
    // A confidential client authenticates at the token endpoint.
    await callback({ state: url.searchParams.get("state")!, code: "good-code" });
    expect(as.tokenCalls.at(-1)!.authorization).toBe(
      `Basic ${Buffer.from("by-hand:by-hand-secret").toString("base64")}`
    );
    as.registration = true;

    delete process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL;
    try {
      const internal = await request({ cookie }, "POST", `${BASE}/${serverId}/oauth/start`, {});
      expect(internal.status).toBe(400);
    } finally {
      process.env.KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL = "true";
    }
  });

  it("the start sets an HttpOnly binding cookie scoped to the callback", async () => {
    if (!dbAvailable) return;
    const { setCookie, bindingCookie } = await start();
    expect(setCookie).toContain("Path=/api/mcp-oauth/callback");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(bindingCookie).toMatch(/^kitsuden_mcp_oauth=[\w-]{43}$/);
  });

  it("a callback brought by someone else burns the state before any token exchange", async () => {
    if (!dbAvailable) return;
    // The test before connected a client registered by hand: start from nothing.
    await request({ cookie }, "DELETE", `${BASE}/${serverId}/oauth`);
    const { state, bindingCookie } = await start();
    const before = as.tokenCalls.length;
    // No session and no binding cookie: another person who got the link.
    const stranger = await callback({ state, code: "good-code" }, {});
    const location = new URL(stranger.headers.get("location")!);
    expect(location.pathname).toBe("/mcp-servers");
    expect(location.searchParams.get("oauth")).toBe("error");
    expect(location.searchParams.get("message")).toContain("another browser");
    expect(as.tokenCalls.length).toBe(before);
    expect((await serverRow()).oauth_config).toBeNull();
    // Burnt: not even the starter's own browser can finish it now.
    const late = await callback({ state, code: "good-code" }, { cookie: bindingCookie });
    expect(new URL(late.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    expect(as.tokenCalls.length).toBe(before);

    // A wrong binding value is refused too.
    const second = await start();
    const forged = await callback(
      { state: second.state, code: "good-code" },
      { cookie: "kitsuden_mcp_oauth=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
    );
    expect(new URL(forged.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    expect(as.tokenCalls.length).toBe(before);
  });

  it("an agent's credential does not count as the admin who started", async () => {
    if (!dbAvailable) return;
    const { state } = await start();
    const before = as.tokenCalls.length;
    const r = await request(
      { token: agentToken },
      "GET",
      `/api/mcp-oauth/callback?${new URLSearchParams({ state, code: "good-code" }).toString()}`
    );
    // Either refused outright or sent to the panel with an error; never connected.
    if (r.status === 302) {
      expect(new URL(r.headers.get("location")!).searchParams.get("oauth")).toBe("error");
    } else {
      expect([401, 403]).toContain(r.status);
    }
    expect(as.tokenCalls.length).toBe(before);
    expect((await serverRow()).oauth_config).toBeNull();
  });

  it("the browser that started connects with its binding cookie alone, without a session", async () => {
    if (!dbAvailable) return;
    const { state, bindingCookie } = await start();
    const r = await callback({ state, code: "good-code" }, { cookie: bindingCookie });
    const location = new URL(r.headers.get("location")!);
    expect(location.searchParams.get("oauth")).toBe("connected");
    // The binding is cleared once used.
    expect(r.headers.get("set-cookie") ?? "").toContain("kitsuden_mcp_oauth=;");
    expect((await serverRow()).oauth_config).not.toBeNull();
    await request({ cookie }, "DELETE", `${BASE}/${serverId}/oauth`);
  });

  it("an agent, even with admin, and an anonymous caller cannot start or disconnect", async () => {
    if (!dbAvailable) return;
    for (const [method, path] of [
      ["POST", `${BASE}/${serverId}/oauth/start`],
      ["DELETE", `${BASE}/${serverId}/oauth`],
    ] as Array<[string, string]>) {
      const r = await request({ token: agentToken }, method, path, {});
      expect(r.status, `${method} ${path}`).toBe(403);
      const anonymous = await request({}, method, path, {});
      expect([401, 403], `anonymous ${method} ${path}`).toContain(anonymous.status);
    }
  });
});
