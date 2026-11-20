/**
 * Connections (docs/connections.md): connect, keep people apart, hand kons a client, refresh, revoke
 * ============================================================================
 *
 * The whole API on real Postgres, as the app role, with real sessions. The providers are a `fetch` double
 * that answers like Google's token, userinfo, revoke and Gmail endpoints; the credentials are sealed with
 * the installation's real secrets key.
 *
 * What these tests hold:
 *   - OAuth uses PKCE S256; the state is stored hashed and works once; the credential is stored sealed and
 *     its every opening is in `secret_access_log`, naming the kon that asked;
 *   - a person lists only their own connections; an admin the organization's and NOT a person's;
 *   - a kon gets a client bound to its id, which sends the credential only to the provider's hosts and
 *     cannot act as another kon;
 *   - a kon owns the providers it registers; Google and Microsoft cannot be replaced;
 *   - `invalid_grant` expires a connection and announces it once; revoking deletes the credential.
 */

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { connConnections } from "../db/schema-core";
import { app } from "../index";
import { konConnections, refreshTick, resetProviderOwners } from "../lib/connections";
import { setConnectionNetworkForTests } from "../lib/connections/network";
import { events } from "../lib/events";
import { bindKonContext } from "../lib/kon-setup";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

const id = generateTestId()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
let dbAvailable = false;
let admin = "";
let ana = "";
let anaId = "";
let beto = "";

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
let tokenAnswer: () => Response;
let counter = 0;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const provider = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  calls.push({ url, init });
  if (url === "https://oauth2.googleapis.com/token") return tokenAnswer();
  if (url === "https://openidconnect.googleapis.com/v1/userinfo")
    return json({ sub: `g-${id}`, email: `Ana.${id}@Gmail.example` });
  if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
  if (url.startsWith("https://gmail.googleapis.com/")) return json({ ok: true });
  return realFetch(input as never, init);
};
const issued =
  (over: Record<string, unknown> = {}) =>
  () =>
    json({
      access_token: `access-${++counter}`,
      refresh_token: "refresh-original",
      expires_in: 3600,
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
      token_type: "Bearer",
      ...over,
    });

function req(path: string, opts: RequestInit = {}, cookie?: string): Request {
  const headers = new Headers(opts.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...opts, headers });
}

async function call(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await app.request(
    req(
      path,
      { method, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" },
      cookie
    )
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, json: parsed, location: res.headers.get("location") };
}

async function rows(query: ReturnType<typeof sql>): Promise<any[]> {
  const result = (await db.execute(query)) as any;
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function connectAna(): Promise<string> {
  const started = await call(
    "POST",
    "/api/connections/oauth/start",
    { provider: "google", scopeSets: ["mail.read"], returnTo: "https://site.example/settings" },
    ana
  );
  expect(started.status).toBe(200);
  const state = new URL(started.json.data.url).searchParams.get("state")!;
  const back = await call(
    "GET",
    `/api/connections/oauth/callback?state=${state}&code=the-code`,
    undefined,
    ana
  );
  expect(back.status).toBe(302);
  return new URL(back.location!).searchParams.get("connection")!;
}

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  // The secrets key is cached the first time something is sealed. This file seals before the other
  // suites that set it, so without this the cache would hold the BETTER_AUTH_SECRET-derived key and
  // the rotation test (kon-foundations) would seal with one key and read another.
  process.env.KITSUDEN_SECRETS_KEY ??= "test-suite-secrets-key-0123456789abcdef-0123456789";
  process.env.CONNECTIONS_GOOGLE_CLIENT_ID = "client-id.apps.example";
  process.env.CONNECTIONS_GOOGLE_CLIENT_SECRET = "client-secret-value";
  process.env.CONNECTIONS_RETURN_ORIGINS = "https://site.example";
  globalThis.fetch = provider as typeof fetch;
  // The connections' calls are pinned (lib/connections/network.ts): they do not go through global fetch.
  setConnectionNetworkForTests(provider as never);
  tokenAnswer = issued();
  ({ cookie: admin } = await enterAs(app, {
    email: `conn-admin-${id}@example.com`,
    password: "TestPassword123!",
    name: "Conn Admin",
    role: "admin",
  }));
  ({ cookie: ana, userId: anaId } = await enterAs(app, {
    email: `conn-ana-${id}@example.com`,
    password: "TestPassword123!",
    name: "Ana",
  }));
  ({ cookie: beto } = await enterAs(app, {
    email: `conn-beto-${id}@example.com`,
    password: "TestPassword123!",
    name: "Beto",
  }));
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setConnectionNetworkForTests(null);
  resetProviderOwners();
  if (dbAvailable) {
    await db.execute(
      sql`DELETE FROM conn_connections WHERE owner_id = ${anaId} OR label LIKE ${`%${id}%`}`
    );
  }
});

describe("OAuth", () => {
  it("connects with PKCE, stores the credential sealed, and logs each opening with its purpose", async () => {
    if (!dbAvailable) return;
    calls.length = 0;
    const started = await call(
      "POST",
      "/api/connections/oauth/start",
      { provider: "google", scopeSets: ["mail.read"] },
      ana
    );
    expect(started.status).toBe(200);
    const url = new URL(started.json.data.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const [stored] = await rows(
      sql`SELECT verifier FROM conn_oauth_states WHERE state_hash = ${createHash("sha256").update(state).digest("hex")}`
    );
    expect(stored.verifier).toMatchObject({ v: 1, kon: "kitsuden-connections" });

    const back = await call(
      "GET",
      `/api/connections/oauth/callback?state=${state}&code=the-code`,
      undefined,
      ana
    );
    expect(back.status).toBe(200);
    const exchange = new URLSearchParams(
      String(calls.find((c) => c.url.endsWith("/token"))!.init!.body)
    );
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(
      url.searchParams.get("code_challenge") ?? ""
    );
    expect(back.json.data).toMatchObject({
      provider: "google",
      scope: "user",
      ownerId: anaId,
      status: "active",
    });
    const raw = JSON.stringify(
      await rows(sql`SELECT * FROM conn_connections WHERE id = ${back.json.data.id}`)
    );
    expect(raw).not.toContain("access-");
    expect(raw).not.toContain("refresh-original");
    const log = await rows(
      sql`SELECT kon_id, outcome, purpose FROM secret_access_log WHERE kon_id = 'kitsuden-connections' AND purpose = 'oauth-callback' ORDER BY created_at DESC LIMIT 1`
    );
    expect(log[0]).toMatchObject({ kon_id: "kitsuden-connections", outcome: "opened" });

    // The same state does not work twice.
    expect(
      (
        await call(
          "GET",
          `/api/connections/oauth/callback?state=${state}&code=the-code`,
          undefined,
          ana
        )
      ).status
    ).toBe(400);
  });

  it("sends the person back to the site, and refuses a return address outside it", async () => {
    if (!dbAvailable) return;
    const connectionId = await connectAna();
    expect(connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (
        await call(
          "POST",
          "/api/connections/oauth/start",
          { provider: "google", returnTo: "https://evil.example/" },
          ana
        )
      ).status
    ).toBe(422);
    expect(
      (
        await call(
          "POST",
          "/api/connections/oauth/start",
          { provider: "google", scope: "organization" },
          ana
        )
      ).status
    ).toBe(403);
  });
});

describe("the callback belongs to whoever started it (security audit 2026-11-19)", () => {
  async function startAsAna(): Promise<{ state: string; setCookie: string | null }> {
    const res = await app.request(
      req(
        "/api/connections/oauth/start",
        { method: "POST", body: JSON.stringify({ provider: "google", scopeSets: ["mail.read"] }) },
        ana
      )
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { url: string } };
    return {
      state: new URL(body.data.url).searchParams.get("state")!,
      setCookie: res.headers.get("set-cookie"),
    };
  }

  it("refuses a consent link completed with no session and no binding cookie, and burns it", async () => {
    if (!dbAvailable) return;
    const { state } = await startAsAna();
    const back = await call("GET", `/api/connections/oauth/callback?state=${state}&code=the-code`);
    expect(back.status).toBe(403);
    const again = await call(
      "GET",
      `/api/connections/oauth/callback?state=${state}&code=the-code`,
      undefined,
      ana
    );
    expect(again.status).toBe(400);
  });

  it("refuses a consent link completed by another person's session", async () => {
    if (!dbAvailable) return;
    const { state } = await startAsAna();
    const back = await call(
      "GET",
      `/api/connections/oauth/callback?state=${state}&code=the-code`,
      undefined,
      beto
    );
    expect(back.status).toBe(403);
  });

  it("accepts the starting browser by its binding cookie, without a session", async () => {
    if (!dbAvailable) return;
    const { state, setCookie } = await startAsAna();
    const binding = /kitsuden_conn_oauth=([^;]+)/.exec(setCookie ?? "")?.[1];
    expect(binding).toBeTruthy();
    const back = await call(
      "GET",
      `/api/connections/oauth/callback?state=${state}&code=the-code`,
      undefined,
      `kitsuden_conn_oauth=${binding}`
    );
    expect(back.status).toBe(200);
    expect(back.json.data.ownerId).toBe(anaId);
  });
});

describe("people are kept apart", () => {
  it("each person lists their own; an admin the organization's and nobody's personal one", async () => {
    if (!dbAvailable) return;
    await connectAna();
    const ids = (r: { json: { data: Array<{ ownerId: string | null; scope: string }> } }) =>
      r.json.data.map((c) => `${c.scope}:${c.ownerId === anaId ? "ana" : (c.ownerId ?? "-")}`);
    expect(
      ids(await call("GET", "/api/connections/connections", undefined, ana)).every(
        (x) => x === "user:ana"
      )
    ).toBe(true);
    expect(ids(await call("GET", "/api/connections/connections", undefined, beto))).toEqual([]);
    expect(
      ids(await call("GET", "/api/connections/connections", undefined, admin)).some(
        (x) => x === "user:ana"
      )
    ).toBe(false);
  });

  it("someone else's connection is a 404 for reading and revoking, an admin included", async () => {
    if (!dbAvailable) return;
    const connectionId = await connectAna();
    expect(
      (await call("GET", `/api/connections/connections/${connectionId}`, undefined, beto)).status
    ).toBe(404);
    expect(
      (await call("POST", `/api/connections/connections/${connectionId}/revoke`, undefined, admin))
        .status
    ).toBe(404);
    const [row] = await rows(sql`SELECT status FROM conn_connections WHERE id = ${connectionId}`);
    expect(row.status).toBe("active");
  });
});

describe("what a kon gets", () => {
  it("a client bound to the kon: the credential goes only to the provider's hosts", async () => {
    if (!dbAvailable) return;
    await connectAna();
    const ctx = bindKonContext({ connections: konConnections } as never, "kon-inbox");
    const gmail = await ctx.connections!.client("kon-inbox", {
      provider: "google",
      ownerId: anaId,
      scopeSets: ["mail.read"],
      purpose: "sync mail",
    });
    expect(JSON.stringify(gmail)).not.toMatch(/access-|refresh-/);
    calls.length = 0;
    const res = await gmail.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(res.status).toBe(200);
    expect(new Headers(calls.at(-1)!.init!.headers).get("authorization")).toMatch(
      /^Bearer access-\d+$/
    );
    await expect(gmail.fetch("https://evil.example/steal")).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
    });
    const [log] = await rows(
      sql`SELECT purpose FROM secret_access_log WHERE kon_id = 'kitsuden-connections' ORDER BY created_at DESC LIMIT 1`
    );
    expect(log.purpose).toBe("kon-inbox: sync mail");
    // Bound: it cannot ask as another kon.
    await expect(
      ctx.connections!.client("kon-crm", { provider: "google", ownerId: anaId, purpose: "x" })
    ).rejects.toThrow(/cannot act as "kon-crm"/);
  });

  it("a kon owns the providers it registers, and cannot replace Google", async () => {
    if (!dbAvailable) return;
    const mailer = bindKonContext(
      { connections: konConnections } as never,
      "kon-newsletter"
    ).connections!;
    const other = bindKonContext({ connections: konConnections } as never, "kon-crm").connections!;
    mailer.registerProvider("kon-newsletter", {
      id: `mailer${id}`.slice(0, 30),
      name: "Mailer",
      authTypes: ["api_key"],
      scopeSets: {},
      apiHosts: ["api.mailer.example"],
    });
    expect(() =>
      other.registerProvider("kon-crm", {
        id: `mailer${id}`.slice(0, 30),
        name: "Fake",
        authTypes: ["api_key"],
        scopeSets: {},
        apiHosts: ["evil.example"],
      })
    ).toThrow(/belongs to kon-newsletter/);
    expect(() =>
      other.registerProvider("kon-crm", {
        id: "google",
        name: "Fake",
        authTypes: ["api_key"],
        scopeSets: {},
        apiHosts: ["evil.example"],
      })
    ).toThrow(/built in/);
    // An admin stores its key for the organization; the kon's client carries it.
    const stored = await call(
      "POST",
      "/api/connections/api-keys",
      { provider: `mailer${id}`.slice(0, 30), apiKey: "mk_live_abcdefgh", label: `mailer ${id}` },
      admin
    );
    expect(stored.status).toBe(201);
    expect(JSON.stringify(stored.json)).not.toContain("mk_live");
    expect(
      (
        await call(
          "POST",
          "/api/connections/api-keys",
          { provider: `mailer${id}`.slice(0, 30), apiKey: "mk_live_abcdefgh" },
          ana
        )
      ).status
    ).toBe(403);
  });
});

describe("refresh, expiry and revoke", () => {
  it("invalid_grant expires the connection, drops its credential, and is announced once", async () => {
    if (!dbAvailable) return;
    const connectionId = await connectAna();
    const announced: unknown[] = [];
    const listener = (data: unknown) => announced.push(data);
    events.on("connections:connection.expired", listener);
    tokenAnswer = () => json({ error: "invalid_grant" }, 400);
    const far = new Date(Date.now() + 2 * 3600_000);
    await refreshTick(provider as never, far);
    await refreshTick(provider as never, far);
    tokenAnswer = issued();
    const [row] = await rows(
      sql`SELECT status, credentials FROM conn_connections WHERE id = ${connectionId}`
    );
    expect(row).toEqual({ status: "expired", credentials: null });
    expect(
      announced.filter((a) => (a as { connectionId: string }).connectionId === connectionId)
    ).toHaveLength(1);
  });

  it("revoking calls the provider and deletes the credential, keeping the record", async () => {
    if (!dbAvailable) return;
    const connectionId = await connectAna();
    const r = await call(
      "POST",
      `/api/connections/connections/${connectionId}/revoke`,
      undefined,
      ana
    );
    expect(r.status).toBe(200);
    expect(r.json.atProvider).toBe(true);
    const [row] = await db
      .select()
      .from(connConnections)
      .where(eq(connConnections.id, connectionId));
    expect(row).toMatchObject({ status: "revoked", credentials: null });
  });
});

describe("row security as the API's role (kitsuden_app)", () => {
  /** Counts what `role`/`userId` sees, the way a request's transaction sets it. */
  async function seen(userId: string, role: string): Promise<string[]> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
      await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);
      const r = (await tx.execute(
        sql`SELECT label FROM conn_connections WHERE label LIKE ${`%rls-${id}%`} ORDER BY label`
      )) as any;
      return (Array.isArray(r) ? r : r.rows).map((x: { label: string }) => x.label);
    });
  }

  it("a person sees their own, an admin only the organization's, and nobody writes for someone else", async () => {
    if (!dbAvailable) return;
    const { ensureAppRole } = await import("./setup");
    if (!(await ensureAppRole())) return;
    await db.execute(sql`
      INSERT INTO conn_connections (provider, scope, owner_id, auth_type, label) VALUES
        ('google', 'user', 'u-ana-rls', 'oauth', ${`a rls-${id}`}),
        ('google', 'user', 'u-beto-rls', 'oauth', ${`b rls-${id}`}),
        ('google', 'organization', NULL, 'oauth', ${`c rls-${id}`})`);
    expect(await seen("u-ana-rls", "user")).toEqual([`a rls-${id}`]);
    expect(await seen("u-beto-rls", "user")).toEqual([`b rls-${id}`]);
    expect(await seen("u-admin-rls", "admin")).toEqual([`c rls-${id}`]);
    const refused = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
        await tx.execute(sql`SELECT set_config('app.current_user_id', 'u-ana-rls', true)`);
        await tx.execute(sql`SELECT set_config('app.current_user_role', 'user', true)`);
        await tx.execute(
          sql`INSERT INTO conn_connections (provider, scope, owner_id, auth_type, label) VALUES ('google', 'user', 'u-beto-rls', 'oauth', 'forged')`
        );
      })
      .then(() => "")
      .catch((err: Error) => `${err.message} ${(err as { cause?: Error }).cause?.message ?? ""}`);
    expect(refused).toMatch(/row-level security/);
    await db.execute(sql`DELETE FROM conn_connections WHERE label LIKE ${`%rls-${id}%`}`);
  });
});
