/**
 * OAuth 2.1 for MCP (MCP Authorization 2026-07-28) — against the real app and Postgres
 * ============================================================================
 *
 * The whole flow: discovery → registration (DCR and CIMD) → authorization with
 * PKCE → consent in the panel → token → `tools/list` and `tools/call` →
 * refresh rotation → revocation. And what has to fail: wrong PKCE,
 * mismatched redirect, foreign audience, reused refresh (the whole
 * family falls), scope escalations, expired token, and a token of
 * agent A that does not see agent B's things (RLS). See docs/agents/oauth.md.
 */

import { createHash, randomBytes } from "crypto";

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import { agentApiKeys, agentAuditLogs, agentIdentities, brainNotes } from "../db/schema";
import { oauthClients, oauthGrants, oauthTokens } from "../db/schema-oauth";
import { app } from "../index";
import { nonPublicAddress, setMetadataFinder, readClientDocument } from "../lib/oauth/cimd";
import { sweepOAuth } from "../lib/oauth/service";
import { agentContextForApproval, createAgent } from "../services/agent-auth";

import { ensureAppRole, enterAs, generateTestId, isDatabaseAvailable } from "./setup";

// Each test walks the whole flow (several requests and SSE sessions): with
// a loaded machine, the default 5 s falls short.
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

let dbAvailable = false;
let admin = { cookie: "", userId: "" };
let editor = { cookie: "", userId: "" };

type Reader = { cancel(): Promise<void> };
const readers: Reader[] = [];
const notes: string[] = [];
const agents: string[] = [];

// A public documentation IP (RFC 5737) per run: this suite's per-IP limits
// do not add up with those of the other files (all «unknown»).
const IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
const request = (route: string, init: RequestInit = {}) =>
  app.request(new Request(`${BASE}${route}`, init), undefined, {
    ip: { address: IP, family: "IPv4", port: 0 },
  });

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(
  redirect = REDIRECT_URI,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await request("/api/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `Test client ${generateTestId()}`,
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizationUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "mcp:connect mcp:read mcp:write",
    resource: RESOURCE,
    ...extra,
  });
  return `/api/oauth/authorize?${q}`;
}

/** GET /authorize → the id of the request waiting in the panel. */
async function authorize(
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {}
): Promise<string> {
  const res = await request(authorizationUrl(clientId, challenge, extra));
  expect(res.status).toBe(302);
  const target = new URL(res.headers.get("location")!);
  expect(`${target.origin}${target.pathname}`).toBe(`${PANEL.replace(/\/+$/, "")}/oauth/consent`);
  return target.searchParams.get("request")!;
}

async function allow(cookie: string, requestId: string, body: Record<string, unknown>) {
  const res = await request(`/api/oauth/consent/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: PANEL },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Consent and extract the code from the redirect. */
async function codeOf(cookie: string, requestId: string, body: Record<string, unknown>) {
  const r = await allow(cookie, requestId, { decision: "approve", ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const round = new URL(r.body.redirectTo as string);
  expect(round.searchParams.get("state")).toBe("state-123");
  expect(round.searchParams.get("iss")).toBe(ISSUER);
  return round.searchParams.get("code")!;
}

async function token(params: Record<string, string>) {
  const res = await request("/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, string>,
    headers: res.headers,
  };
}

/** The whole flow for an agent: returns the tokens. */
async function connect(agentId: string, scopes: string[], cookie = admin.cookie) {
  const clientId = await register();
  const { verifier, challenge: challenge } = pkce();
  const id = await authorize(clientId, challenge);
  const code = await codeOf(cookie, id, { agentId, scopes });
  const t = await token({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: clientId,
    resource: RESOURCE,
  });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  return {
    clientId,
    ...(t.body as { access_token: string; refresh_token: string; scope: string }),
  };
}

async function newAgent(scopes: string[]): Promise<string> {
  const { agent } = await createAgent({
    name: `oauth-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  agents.push(agent.id);
  return agent.id;
}

async function openSession(
  bearer: string
): Promise<{ status: number; sessionId?: string; headers: Headers }> {
  const res = await request("/api/mcp", { headers: { Authorization: `Bearer ${bearer}` } });
  if (res.status !== 200) return { status: res.status, headers: res.headers };
  const reader = res.body!.getReader();
  readers.push(reader);
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return {
    status: 200,
    sessionId: text.match(/sessionId=([a-zA-Z0-9-]+)/)![1]!,
    headers: res.headers,
  };
}

let idRpc = 1;

async function rpc(
  session: string,
  bearer: string,
  method: string,
  params: unknown = {}
): Promise<{ status: number; body: any }> {
  const res = await request(`/api/mcp?sessionId=${session}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: idRpc++, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) await ensureAppRole();
  if (!dbAvailable) return;
  admin = await enterAs(app, {
    email: `oauth-admin-${generateTestId()}@example.com`,
    password: "TestPassword123!",
    name: "OAuth Admin",
    role: "admin",
  });
  editor = await enterAs(app, {
    email: `oauth-editor-${generateTestId()}@example.com`,
    password: "TestPassword123!",
    name: "OAuth Editor",
    role: "editor",
  });
});

afterAll(async () => {
  for (const l of readers) await l.cancel().catch(() => {});
  setMetadataFinder(null);
  if (!dbAvailable) return;
  if (notes.length) await db.delete(brainNotes).where(inArray(brainNotes.id, notes));
  if (agents.length) await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
});

describe("OAuth for MCP: discovery", () => {
  it("401 on /api/mcp with WWW-Authenticate → resource metadata → server metadata", async () => {
    if (!dbAvailable) return;
    const without = await request("/api/mcp");
    expect(without.status).toBe(401);
    const challenge = without.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`
    );
    expect(challenge).toContain('scope="mcp:connect mcp:read mcp:write"');
    expect(challenge).not.toContain("invalid_token");

    for (const route of [
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const prm = await request(route);
      expect(prm.status).toBe(200);
      const m = (await prm.json()) as Record<string, unknown>;
      expect(m.resource).toBe(RESOURCE);
      expect(m.authorization_servers).toEqual([ISSUER]);
      expect(m.scopes_supported).toEqual(["mcp:connect", "mcp:read", "mcp:write"]);
    }
    const as = await request("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    expect(as.headers.get("access-control-allow-origin")).toBe("*");
    const m = (await as.json()) as Record<string, unknown>;
    expect(m.issuer).toBe(ISSUER);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.registration_endpoint).toBe(`${ISSUER}/api/oauth/register`);
    expect(m.revocation_endpoint).toBe(`${ISSUER}/api/oauth/revoke`);
  });

  it("a garbage token on /api/mcp: 401 with error=invalid_token", async () => {
    if (!dbAvailable) return;
    const r = await request("/api/mcp", {
      headers: { Authorization: "Bearer kitsuden_oat_missing" },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("OAuth for MCP: the whole flow", () => {
  it("DCR → PKCE → consent → token → tools/list + tools/call → rotation → revocation", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read", "brain:read", "brain:write"]);

    // The screen sees the client, the redirect and the agent
    const clientId = await register();
    const { verifier, challenge: challenge } = pkce();
    const id = await authorize(clientId, challenge);
    const view = await request(`/api/oauth/consent/${id}`, { headers: { Cookie: admin.cookie } });
    expect(view.status).toBe(200);
    const v = (await view.json()) as {
      client: { id: string; redirectHost: string; localhostRedirect: boolean };
      agents: { id: string; grantable: string[] }[];
    };
    expect(v.client.id).toBe(clientId);
    expect(v.client.redirectHost).toBe("127.0.0.1");
    expect(v.client.localhostRedirect).toBe(true);
    expect(v.agents.find((a) => a.id === agentId)?.grantable).toEqual([
      "mcp:connect",
      "mcp:read",
      "brain:read",
      "brain:write",
    ]);

    const code = await codeOf(admin.cookie, id, {
      agentId,
      scopes: ["mcp:connect", "mcp:read", "brain:read", "brain:write"],
    });
    // The human moves on to sign for the agent
    const [a] = await db.select().from(agentIdentities).where(eq(agentIdentities.id, agentId));
    expect(a!.sponsorUserId).toBe(admin.userId);

    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    expect(t.body.token_type).toBe("Bearer");
    expect(t.body.access_token.startsWith("kitsuden_oat_")).toBe(true);
    expect(t.body.refresh_token.startsWith("kitsuden_ort_")).toBe(true);
    expect(Number(t.body.expires_in)).toBeLessThanOrEqual(3600);
    expect(t.body.scope).toBe("mcp:connect mcp:read brain:read brain:write");

    // In the database, only hashes
    const inDb = await db.select().from(oauthTokens).where(eq(oauthTokens.clientId, clientId));
    expect(inDb.length).toBe(2);
    for (const row of inDb) {
      expect(row.tokenHash).not.toContain("kitsuden_");
      expect(JSON.stringify(row)).not.toContain(t.body.access_token);
      expect(JSON.stringify(row)).not.toContain(t.body.refresh_token);
    }

    // MCP with the token
    const s = await openSession(t.body.access_token);
    expect(s.status).toBe(200);
    const list = await rpc(s.sessionId!, t.body.access_token, "tools/list");
    const names = (list.body.result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toContain("brain_note_write");
    const mark = `oauth${generateTestId()
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()}`;
    const written = await rpc(s.sessionId!, t.body.access_token, "tools/call", {
      name: "brain_note_write",
      arguments: { body: { key: `o/${mark}`, title: mark, content: `note ${mark}` } },
    });
    expect(written.body.result.isError, JSON.stringify(written.body).slice(0, 500)).toBeUndefined();
    const note = written.body.result.structuredContent.data.note;
    notes.push(note.id);
    expect(note.owner.agentId).toBe(agentId);

    // Audit: with the connection's key
    const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.clientId, clientId));
    await new Promise((r) => setTimeout(r, 150));
    const auditLog = await db
      .select()
      .from(agentAuditLogs)
      .where(and(eq(agentAuditLogs.agentId, agentId), eq(agentAuditLogs.keyId, g!.keyId)));
    expect(auditLog.some((x) => x.action === "auth_success")).toBe(true);
    expect(auditLog.some((x) => x.action === "tool_call")).toBe(true);

    // Rotation: the old refresh is no longer valid and the new one is
    const r1 = await token({
      grant_type: "refresh_token",
      refresh_token: t.body.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.body.refresh_token);
    const s2 = await openSession(r1.body.access_token);
    expect(s2.status).toBe(200);
    const call = await rpc(s2.sessionId!, r1.body.access_token, "tools/call", {
      name: "brain_read",
      arguments: { id: note.id },
    });
    expect(call.body.result.isError).toBeUndefined();

    // Revoking the refresh (RFC 7009) takes down the family: the new access token too
    const rev = await request("/api/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: r1.body.refresh_token, client_id: clientId }).toString(),
    });
    expect(rev.status).toBe(200);
    expect((await openSession(r1.body.access_token)).status).toBe(401);
    const r2 = await token({
      grant_type: "refresh_token",
      refresh_token: r1.body.refresh_token,
      client_id: clientId,
    });
    expect(r2.body.error).toBe("invalid_grant");
  });

  it("CIMD: client_id = https URL with its document; the document has to match", async () => {
    if (!dbAvailable) return;
    const url = `https://client.example/oauth/${generateTestId()}.json`;
    setMetadataFinder(
      async (requested) =>
        new Response(
          JSON.stringify({
            client_id: requested,
            client_name: "CIMD client",
            redirect_uris: [REDIRECT_URI],
            grant_types: ["authorization_code", "refresh_token"],
            token_endpoint_auth_method: "none",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "max-age=600" },
          }
        )
    );
    const agentId = await newAgent(["mcp:connect", "mcp:read"]);
    const { verifier, challenge: challenge } = pkce();
    const id = await authorize(url, challenge);
    const code = await codeOf(admin.cookie, id, { agentId, scopes: ["mcp:connect", "mcp:read"] });
    const t = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: url,
    });
    expect(t.status).toBe(200);
    const [c] = await db.select().from(oauthClients).where(eq(oauthClients.id, url));
    expect(c!.kind).toBe("cimd");

    // Document whose client_id is not the URL → rejected, without redirecting
    const other = `https://client.example/oauth/${generateTestId()}-b.json`;
    setMetadataFinder(
      async () =>
        new Response(
          JSON.stringify({
            client_id: "https://other.example/x.json",
            client_name: "x",
            redirect_uris: [REDIRECT_URI],
          }),
          { status: 200 }
        )
    );
    const badClient = await request(authorizationUrl(other, challenge));
    expect(badClient.status).toBe(400);
    expect(((await badClient.json()) as { error: string }).error).toBe("invalid_client");
    setMetadataFinder(null);
  });

  it("CIMD against SSRF: non-public addresses and invalid documents are not read", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ]) {
      expect(nonPublicAddress(ip)).toBe(true);
    }
    expect(nonPublicAddress("8.8.8.8")).toBe(false);
    setMetadataFinder(null);
    const local = await readClientDocument("https://127.0.0.1/client.json");
    expect(local.ok).toBe(false);
    const port = await readClientDocument("https://client.example:8443/c.json");
    expect(port.ok).toBe(false);
    const withoutRoute = await readClientDocument("https://client.example/");
    expect(withoutRoute.ok).toBe(false);
  });
});

describe("OAuth for MCP: what has to fail", () => {
  it("wrong PKCE, without S256 or without a challenge", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read"]);
    const clientId = await register();
    const { challenge: challenge } = pkce();
    const id = await authorize(clientId, challenge);
    const code = await codeOf(admin.cookie, id, { agentId, scopes: ["mcp:connect"] });
    const bad = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce().verifier,
      client_id: clientId,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");

    const variants: Record<string, string>[] = [
      { code_challenge_method: "plain" },
      { code_challenge: "" },
    ];
    for (const extra of variants) {
      const res = await request(authorizationUrl(clientId, challenge, extra));
      expect(res.status).toBe(302);
      const round = new URL(res.headers.get("location")!);
      expect(round.searchParams.get("error")).toBe("invalid_request");
      expect(round.searchParams.get("iss")).toBe(ISSUER);
    }
    // Neither implicit nor password
    const implicit = await request(
      authorizationUrl(clientId, challenge, { response_type: "token" })
    );
    expect(new URL(implicit.headers.get("location")!).searchParams.get("error")).toBe(
      "unsupported_response_type"
    );
    const password = await token({
      grant_type: "password",
      username: "x",
      password: "y",
      client_id: clientId,
    });
    expect(password.body.error).toBe("unsupported_grant_type");
    const withoutImplicit = await request("/api/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        grant_types: ["implicit"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(withoutImplicit.status).toBe(400);
  });

  it("redirects: exact (except the port on loopback), never public http nor fragments", async () => {
    if (!dbAvailable) return;
    const clientId = await register();
    const { verifier, challenge: challenge } = pkce();
    // Another path → it does not redirect anywhere: 400 on screen
    const other = await request(
      authorizationUrl(clientId, challenge, { redirect_uri: "http://127.0.0.1/other" })
    );
    expect(other.status).toBe(400);
    expect(other.headers.get("location")).toBeNull();
    const foreign = await request(
      authorizationUrl(clientId, challenge, { redirect_uri: "https://evil.example/callback" })
    );
    expect(foreign.status).toBe(400);
    // Loopback with another port: valid (OAuth 2.1 §8.4.2)
    const withPort = await request(
      authorizationUrl(clientId, challenge, { redirect_uri: "http://127.0.0.1:54321/callback" })
    );
    expect(withPort.status).toBe(302);
    // The exchange requires the SAME redirect as the authorization
    const agentId = await newAgent(["mcp:connect"]);
    const id = await authorize(clientId, challenge);
    const code = await codeOf(admin.cookie, id, { agentId, scopes: ["mcp:connect"] });
    const distinct = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:9999/callback",
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(distinct.body.error).toBe("invalid_grant");

    for (const badUri of [
      "http://evil.example/cb",
      "https://x.example/cb#frag",
      "javascript:alert(1)",
      "https://u:p@x.example/cb",
    ]) {
      const res = await request("/api/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [badUri], token_endpoint_auth_method: "none" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
  });

  it("audience: another resource is not authorized; the token is not valid outside /api/mcp nor with another audience", async () => {
    if (!dbAvailable) return;
    const clientId = await register();
    const { challenge: challenge } = pkce();
    const other = await request(
      authorizationUrl(clientId, challenge, { resource: "https://evil.example/mcp" })
    );
    expect(new URL(other.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_target"
    );

    const agentId = await newAgent(["mcp:connect", "mcp:read", "datasets:*:read", "user:act"]);
    const t = await connect(agentId, ["mcp:connect", "mcp:read", "datasets:*:read", "user:act"]);
    // Outside the resource: 401 even if the agent has the scope
    const outside = await request("/api/datasets", {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    expect(outside.status).toBe(401);
    const v1 = await request("/api/v1/agents", {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    expect(v1.status).toBe(401);
    // Issued for another resource (another installation): 401 on /api/mcp too
    await db
      .update(oauthTokens)
      .set({ resource: "https://other.example/api/mcp" })
      .where(eq(oauthTokens.clientId, t.clientId));
    const s = await openSession(t.access_token);
    expect(s.status).toBe(401);
    expect(s.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("a reused refresh revokes the whole family; a reused code too", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read"]);
    const t = await connect(agentId, ["mcp:connect", "mcp:read"]);
    const r1 = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.clientId,
    });
    expect(r1.status).toBe(200);
    expect((await openSession(r1.body.access_token)).status).toBe(200);
    // The attacker (or the legitimate client, whoever arrives second) reuses the old one
    const reused = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.clientId,
    });
    expect(reused.body.error).toBe("invalid_grant");
    // Everything falls: the NEW access and refresh tokens
    expect((await openSession(r1.body.access_token)).status).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: r1.body.refresh_token,
          client_id: t.clientId,
        })
      ).body.error
    ).toBe("invalid_grant");
    // Another client does not exchange someone else's refresh tokens
    const other = await register();
    const t2 = await connect(agentId, ["mcp:connect"]);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: t2.refresh_token,
          client_id: other,
        })
      ).body.error
    ).toBe("invalid_grant");

    // Reused code → invalid_grant and the family it issued, revoked
    const clientId = await register();
    const { verifier, challenge: challenge } = pkce();
    const id = await authorize(clientId, challenge);
    const code = await codeOf(admin.cookie, id, { agentId, scopes: ["mcp:connect"] });
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    };
    const first = await token(params);
    expect(first.status).toBe(200);
    const secondItem = await token(params);
    expect(secondItem.body.error).toBe("invalid_grant");
    expect((await openSession(first.body.access_token)).status).toBe(401);
  });

  it("scope escalations: nothing that the agent or the human do not have", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent([
      "mcp:connect",
      "mcp:read",
      "brain:read",
      "brain:write",
      "!kon:crm:*",
    ]);
    // Ask for a scope the agent does not have
    let id = await authorize(await register(), pkce().challenge);
    expect(
      (
        await allow(admin.cookie, id, {
          decision: "approve",
          agentId,
          scopes: ["mcp:connect", "admin"],
        })
      ).status
    ).toBe(403);
    // Denials in the grant: no
    id = await authorize(await register(), pkce().challenge);
    expect(
      (
        await allow(admin.cookie, id, {
          decision: "approve",
          agentId,
          scopes: ["mcp:connect", "!brain:write"],
        })
      ).status
    ).toBe(422);
    // Without mcp:connect: it would not connect
    id = await authorize(await register(), pkce().challenge);
    expect(
      (await allow(admin.cookie, id, { decision: "approve", agentId, scopes: ["mcp:read"] })).status
    ).toBe(422);

    // An editor: only agents they already sign for, and no admin
    const foreign = await newAgent(["mcp:connect", "admin"]);
    id = await authorize(await register(), pkce().challenge);
    expect(
      (
        await allow(editor.cookie, id, {
          decision: "approve",
          agentId: foreign,
          scopes: ["mcp:connect"],
        })
      ).status
    ).toBe(403);
    await db
      .update(agentIdentities)
      .set({ sponsorUserId: editor.userId })
      .where(eq(agentIdentities.id, foreign));
    id = await authorize(await register(), pkce().challenge);
    expect(
      (
        await allow(editor.cookie, id, {
          decision: "approve",
          agentId: foreign,
          scopes: ["mcp:connect", "admin"],
        })
      ).status
    ).toBe(403);
    id = await authorize(await register(), pkce().challenge);
    expect(
      (
        await allow(editor.cookie, id, {
          decision: "approve",
          newAgent: { name: "x" },
          scopes: ["mcp:connect"],
        })
      ).status
    ).toBe(403);
    id = await authorize(await register(), pkce().challenge);
    expect(
      (
        await allow(editor.cookie, id, {
          decision: "approve",
          agentId: foreign,
          scopes: ["mcp:connect"],
        })
      ).status
    ).toBe(200);

    // An agent (even with admin) does not consent
    const { plainApiKey } = await createAgent({
      name: `oauth-agent-admin-${generateTestId()}`,
      scopes: ["admin"],
    });
    id = await authorize(await register(), pkce().challenge);
    const byAgent = await request(`/api/oauth/consent/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plainApiKey}` },
      body: JSON.stringify({ decision: "approve", agentId, scopes: ["mcp:connect"] }),
    });
    expect(byAgent.status).toBe(403);

    // What is granted NARROWS: without brain:write in the grant, it does not write
    const t = await connect(agentId, ["mcp:connect", "mcp:read", "brain:read"]);
    const s = await openSession(t.access_token);
    const list = await rpc(s.sessionId!, t.access_token, "tools/list");
    const names = (list.body.result.tools as { name: string }[]).map((x) => x.name);
    expect(names).toContain("brain_search");
    expect(names).not.toContain("brain_note_write");
    const writes = await rpc(s.sessionId!, t.access_token, "tools/call", {
      name: "brain_note_write",
      arguments: { body: { key: "x", title: "x", content: "x" } },
    });
    expect(writes.body.result.isError).toBe(true);
    // The refresh does not widen
    const more = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.clientId,
      scope: "mcp:connect brain:write",
    });
    expect(more.body.error).toBe("invalid_scope");
    // …but it can narrow
    const less = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.clientId,
      scope: "mcp:connect",
    });
    expect(less.status).toBe(200);
    expect(less.body.scope).toBe("mcp:connect");

    // Removing a scope from the agent applies right away on the OAuth connection; adding one does not
    const t3 = await connect(agentId, ["mcp:connect", "mcp:read", "brain:read"]);
    await db
      .update(agentIdentities)
      .set({ scopes: ["mcp:connect", "mcp:read", "brain:write", "!kon:crm:*"] })
      .where(eq(agentIdentities.id, agentId));
    const s3 = await openSession(t3.access_token);
    const list3 = await rpc(s3.sessionId!, t3.access_token, "tools/list");
    const n3 = (list3.body.result.tools as { name: string }[]).map((x) => x.name);
    expect(n3).not.toContain("brain_search"); // the agent no longer has brain:read
    expect(n3).not.toContain("brain_note_write"); // brain:write was not granted
    // Without mcp:connect on the agent: 403 with insufficient_scope
    await db
      .update(agentIdentities)
      .set({ scopes: ["mcp:read"] })
      .where(eq(agentIdentities.id, agentId));
    const withoutConnect = await openSession(t3.access_token);
    expect(withoutConnect.status).toBe(403);
    expect(withoutConnect.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("expired token: 401 invalid_token; expired refresh: invalid_grant", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read"]);
    const t = await connect(agentId, ["mcp:connect", "mcp:read"]);
    await db
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTokens.clientId, t.clientId));
    const s = await openSession(t.access_token);
    expect(s.status).toBe(401);
    expect(s.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
          client_id: t.clientId,
        })
      ).body.error
    ).toBe("invalid_grant");
  });

  it("RLS: agent A's token does not see agent B's private notes", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["mcp:connect", "brain:read", "brain:write"]);
    const b = await newAgent(["mcp:connect", "brain:read", "brain:write"]);
    const ta = await connect(a, ["mcp:connect", "brain:read", "brain:write"]);
    const tb = await connect(b, ["mcp:connect", "brain:read", "brain:write"]);
    const sa = await openSession(ta.access_token);
    const sb = await openSession(tb.access_token);
    const mark = `rlsoauth${generateTestId()
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()}`;
    const written = await rpc(sb.sessionId!, tb.access_token, "tools/call", {
      name: "brain_note_write",
      arguments: { body: { key: `b/${mark}`, title: mark, content: `secret ${mark}` } },
    });
    const note = written.body.result.structuredContent.data.note;
    notes.push(note.id);
    expect(note.visibility).toBe("private");

    const read = await rpc(sa.sessionId!, ta.access_token, "tools/call", {
      name: "brain_read",
      arguments: { id: note.id },
    });
    expect(read.body.result.isError).toBe(true);
    expect(JSON.stringify(read.body)).toContain("KITSUDEN_E_NOT_FOUND");
    const searches = await rpc(sa.sessionId!, ta.access_token, "tools/call", {
      name: "brain_search",
      arguments: { q: mark, threshold: 0 },
    });
    const views = (
      searches.body.result.structuredContent.data.hits as { note: { id: string } }[]
    ).map((h) => h.note.id);
    expect(views).not.toContain(note.id);
    // B's session cannot be used with A's token
    const crossed = await rpc(sb.sessionId!, ta.access_token, "tools/list");
    expect(crossed.status).toBe(400);

    // And the database alone (app role, without the application filter) cuts it off
    const howMany = (agentId: string) =>
      db.transaction(async (tx) => {
        const su = await tx.execute(sql`SELECT current_setting('is_superuser') AS su`);
        if ((su.rows[0] as { su: string }).su === "on")
          await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${agentId}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_role', 'agent', true)`);
        const r = await tx.execute(
          sql`SELECT count(*)::int AS n FROM brain_notes WHERE id = ${note.id}`
        );
        return (r.rows[0] as { n: number }).n;
      });
    expect(await howMany(b)).toBe(1);
    expect(await howMany(a)).toBe(0);
  });
});

describe("OAuth for MCP: connections, approvals, static keys and sweep", () => {
  it("the panel lists and revokes; the revocation applies on the next request", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read"]);
    const t = await connect(agentId, ["mcp:connect", "mcp:read"]);
    expect((await openSession(t.access_token)).status).toBe(200);
    const list = await request(`/api/oauth/grants?agentId=${agentId}`, {
      headers: { Cookie: admin.cookie },
    });
    const { grants } = (await list.json()) as {
      grants: { id: string; client: { id: string }; agent: { id: string } }[];
    };
    const g = grants.find((x) => x.client.id === t.clientId)!;
    expect(g.agent.id).toBe(agentId);
    // An editor does not see or revoke another's (404, not 403: it does not confirm that it exists)
    const ofTheEditor = await request(`/api/oauth/grants/${g.id}`, {
      method: "DELETE",
      headers: { Cookie: editor.cookie, Origin: PANEL },
    });
    expect(ofTheEditor.status).toBe(404);
    const deletes = await request(`/api/oauth/grants/${g.id}`, {
      method: "DELETE",
      headers: { Cookie: admin.cookie, Origin: PANEL },
    });
    expect(deletes.status).toBe(200);
    expect((await openSession(t.access_token)).status).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
          client_id: t.clientId,
        })
      ).body.error
    ).toBe("invalid_grant");
    // The connection's key is left revoked («Keys» tab)
    const [row] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, g.id));
    const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, row!.keyId));
    expect(key!.revokedAt).not.toBeNull();
    expect(key!.algorithm).toBe("oauth");
  });

  it("revoking the OAuth key from the Keys tab also cuts the connection", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read"]);
    const t = await connect(agentId, ["mcp:connect", "mcp:read"]);
    const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.clientId, t.clientId));
    await db
      .update(agentApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(agentApiKeys.id, g!.keyId));
    expect((await openSession(t.access_token)).status).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          refresh_token: t.refresh_token,
          client_id: t.clientId,
        })
      ).body.error
    ).toBe("invalid_grant");
  });

  it("approvals: a proposal from an OAuth connection runs with what was granted, and not if it was revoked", async () => {
    if (!dbAvailable) return;
    const agentId = await newAgent(["mcp:connect", "mcp:read", "mcp:write", "!datasets:secret:*"]);
    const t = await connect(agentId, ["mcp:connect", "mcp:read"]);
    const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.clientId, t.clientId));
    const ctx = await agentContextForApproval(agentId, g!.keyId);
    expect(ctx.ok).toBe(true);
    if (ctx.ok)
      expect(ctx.context.scopes).toEqual(["!datasets:secret:*", "mcp:connect", "mcp:read"]);
    await db.update(oauthGrants).set({ revokedAt: new Date() }).where(eq(oauthGrants.id, g!.id));
    const after = await agentContextForApproval(agentId, g!.keyId);
    expect(after.ok).toBe(false);
  });

  it("static keys keep working the same", async () => {
    if (!dbAvailable) return;
    const { plainApiKey } = await createAgent({
      name: `oauth-static-${generateTestId()}`,
      scopes: ["mcp:connect", "mcp:read"],
    });
    const s = await openSession(plainApiKey);
    expect(s.status).toBe(200);
    const list = await rpc(s.sessionId!, plainApiKey, "tools/list");
    expect(list.status).toBe(200);
  });

  it("denying at consent returns access_denied with state and iss", async () => {
    if (!dbAvailable) return;
    const id = await authorize(await register(), pkce().challenge);
    const r = await allow(admin.cookie, id, { decision: "deny" });
    expect(r.status).toBe(200);
    const round = new URL(r.body.redirectTo as string);
    expect(round.searchParams.get("error")).toBe("access_denied");
    expect(round.searchParams.get("state")).toBe("state-123");
    expect(round.searchParams.get("iss")).toBe(ISSUER);
    // A request is decided once
    expect((await allow(admin.cookie, id, { decision: "deny" })).status).toBe(404);
  });

  it("confidential clients authenticate with their secret", async () => {
    if (!dbAvailable) return;
    const res = await request("/api/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "Confidential" }),
    });
    const c = (await res.json()) as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(c.token_endpoint_auth_method).toBe("client_secret_basic");
    const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, c.client_id));
    expect(row!.secretHash).not.toBe(c.client_secret);
    const agentId = await newAgent(["mcp:connect"]);
    const { verifier, challenge: challenge } = pkce();
    const id = await authorize(c.client_id, challenge);
    const code = await codeOf(admin.cookie, id, { agentId, scopes: ["mcp:connect"] });
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString();
    const withoutSecret = await request("/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `${params}&client_id=${c.client_id}`,
    });
    expect(withoutSecret.status).toBe(401);
    const basic = `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`;
    const good = await request("/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic },
      body: params,
    });
    expect(good.status).toBe(200);
  });

  it("registration limit per IP (fails closed)", async () => {
    if (!dbAvailable) return;
    process.env.OAUTH_REGISTER_LIMIT = "1";
    try {
      await request("/api/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      });
      const secondItem = await request("/api/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
      });
      expect(secondItem.status).toBe(429);
    } finally {
      process.env.OAUTH_REGISTER_LIMIT = "100000";
    }
  });

  it("the sweep deletes clients that nobody consented to within 7 days", async () => {
    if (!dbAvailable) return;
    const old = await register();
    const used = await register();
    await db
      .update(oauthClients)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(inArray(oauthClients.id, [old, used]));
    const agentId = await newAgent(["mcp:connect"]);
    const { challenge: challenge } = pkce();
    const id = await authorize(used, challenge);
    await codeOf(admin.cookie, id, { agentId, scopes: ["mcp:connect"] });
    await sweepOAuth();
    expect((await db.select().from(oauthClients).where(eq(oauthClients.id, old))).length).toBe(0);
    expect((await db.select().from(oauthClients).where(eq(oauthClients.id, used))).length).toBe(1);
  });
});
