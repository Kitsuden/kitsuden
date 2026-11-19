/**
 * Pushed Authorization Requests (RFC 9126) on the MCP authorization server
 * ============================================================================
 *
 *   · metadata advertises the endpoint;
 *   · PAR → /authorize with only client_id + request_uri → consent → token;
 *   · a request_uri is single use, expires, and belongs to its client;
 *   · query parameters next to a request_uri are ignored;
 *   · OAUTH_REQUIRE_PAR and the per-client `require_pushed_authorization_requests`.
 */

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities } from "../db/schema";
import { oauthAuthorizationRequests } from "../db/schema-oauth";
import { app } from "../index";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

setDefaultTimeout(30_000);
process.env.OAUTH_REGISTER_LIMIT = "100000";
process.env.OAUTH_TOKEN_LIMIT = "100000";

const BASE = "http://localhost:3000";
const ISSUER = (process.env.OAUTH_ISSUER_URL || process.env.BETTER_AUTH_URL || BASE).replace(
  /\/+$/,
  ""
);
const RESOURCE = `${ISSUER}/api/mcp`;
const PANEL = process.env.ADMIN_URL || "http://localhost:5173";
const REDIRECT_URI = "http://127.0.0.1/callback";
const IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

let dbAvailable = false;
let admin = { cookie: "", userId: "" };
const agents: string[] = [];

const request = (route: string, init: RequestInit = {}) =>
  app.request(new Request(`${BASE}${route}`, init), undefined, {
    ip: { address: IP, family: "IPv4", port: 0 },
  });

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request("/api/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `PAR client ${generateTestId()}`,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      ...extra,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizationParams(clientId: string, challenge: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-par",
    scope: "mcp:connect mcp:read",
    resource: RESOURCE,
  };
}

async function push(params: Record<string, string>) {
  const res = await request("/api/oauth/par", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const authorize = (q: Record<string, string>) =>
  request(`/api/oauth/authorize?${new URLSearchParams(q)}`);

function consentRequestId(res: Response): string {
  expect(res.status).toBe(302);
  const target = new URL(res.headers.get("location")!);
  expect(`${target.origin}${target.pathname}`).toBe(`${PANEL.replace(/\/+$/, "")}/oauth/consent`);
  return target.searchParams.get("request")!;
}

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  admin = await enterAs(app, {
    email: `par-admin-${generateTestId()}@test.local`,
    password: "Test-password-123!",
    name: "PAR admin",
    role: "admin",
  });
});

afterAll(async () => {
  delete process.env.OAUTH_REQUIRE_PAR;
  if (dbAvailable && agents.length)
    await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
});

describe("PAR", () => {
  it("metadata advertises the endpoint", async () => {
    const res = await request("/.well-known/oauth-authorization-server");
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.pushed_authorization_request_endpoint).toBe(`${ISSUER}/api/oauth/par`);
    expect(m.require_pushed_authorization_requests).toBe(false);
  });

  it("push → authorize with request_uri → consent → token", async () => {
    if (!dbAvailable) return;
    const { agent } = await createAgent({
      name: `par-${generateTestId()}`,
      scopes: ["mcp:connect", "mcp:read"],
    });
    agents.push(agent.id);
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const pushed = await push(authorizationParams(clientId, challenge));
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
    expect(pushed.body.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    expect(pushed.body.expires_in).toBe(60);

    // Only client_id + request_uri count: a different redirect in the query is ignored.
    const id = consentRequestId(
      await authorize({
        client_id: clientId,
        request_uri: pushed.body.request_uri,
        redirect_uri: "http://127.0.0.1/evil",
      })
    );
    const decision = await request(`/api/oauth/consent/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie, Origin: PANEL },
      body: JSON.stringify({
        decision: "approve",
        agentId: agent.id,
        scopes: ["mcp:connect", "mcp:read"],
      }),
    });
    expect(decision.status, await decision.clone().text()).toBe(200);
    const back = new URL(((await decision.json()) as { redirectTo: string }).redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    const code = back.searchParams.get("code")!;

    const t = await request("/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
      }).toString(),
    });
    expect(t.status, await t.clone().text()).toBe(200);

    // single use
    const again = await authorize({ client_id: clientId, request_uri: pushed.body.request_uri });
    expect(again.status).toBe(400);
  });

  it("refuses another client's request_uri, an expired one, and a request_uri inside a push", async () => {
    if (!dbAvailable) return;
    const a = await register();
    const b = await register();
    const pushed = await push(authorizationParams(a, pkce().challenge));
    expect((await authorize({ client_id: b, request_uri: pushed.body.request_uri })).status).toBe(
      400
    );

    const expiring = await push(authorizationParams(a, pkce().challenge));
    const hash = createHash("sha256")
      .update(String(expiring.body.request_uri).split(":").pop()!)
      .digest("hex");
    await db
      .update(oauthAuthorizationRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthAuthorizationRequests.requestUriHash, hash));
    expect((await authorize({ client_id: a, request_uri: expiring.body.request_uri })).status).toBe(
      400
    );

    const nested = await push({
      ...authorizationParams(a, pkce().challenge),
      request_uri: "urn:x",
    });
    expect(nested.status).toBe(400);
  });

  it("OAUTH_REQUIRE_PAR and the per-client flag refuse a plain /authorize", async () => {
    if (!dbAvailable) return;
    const strict = await register({ require_pushed_authorization_requests: true });
    expect((await authorize(authorizationParams(strict, pkce().challenge))).status).toBe(400);

    const relaxed = await register();
    expect((await authorize(authorizationParams(relaxed, pkce().challenge))).status).toBe(302);
    process.env.OAUTH_REQUIRE_PAR = "true";
    try {
      expect((await authorize(authorizationParams(relaxed, pkce().challenge))).status).toBe(400);
      const pushed = await push(authorizationParams(relaxed, pkce().challenge));
      expect(
        (await authorize({ client_id: relaxed, request_uri: pushed.body.request_uri })).status
      ).toBe(302);
    } finally {
      delete process.env.OAUTH_REQUIRE_PAR;
    }
  });
});
