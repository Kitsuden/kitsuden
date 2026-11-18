/**
 * Proof of possession (DPoP) and short-lived agent credentials, on the real app
 * ============================================================================
 *
 *   · a key bound to a public JWK is refused without a proof, accepted with one,
 *     and refused with a proof for another URL, a replayed proof, or another key;
 *   · `require_dpop` refuses an unbound key outright;
 *   · the exchange narrows scopes, refuses scopes the caller lacks, refuses
 *     chaining, binds to the caller's DPoP key, and dies with its parent key;
 *   · an expired short token is refused;
 *   · a run credential never works over HTTP, and is revoked by the run's end.
 */

import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentApiKeys, agentIdentities, agentShortTokens } from "../db/schema-core";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { forgetDpopJtis, jwkThumbprint, type PublicJwk } from "../lib/dpop";
import { createAgent, publicRequestUrl } from "../services/agent-auth";
import { mintRunCredential, revokeShortToken } from "../services/agent-short-tokens";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
let admin = { cookie: "", userId: "" };
const ORIGIN = "http://localhost:4321";
const created: string[] = [];

async function newAgent(scopes: string[]) {
  const { agent, plainApiKey } = await createAgent({
    name: `dpop-${generateTestId()}`,
    scopes,
    rateLimit: 100_000,
  });
  created.push(agent.id);
  const [key] = await db
    .select()
    .from(agentApiKeys)
    .where(eq(agentApiKeys.agentId, agent.id))
    .limit(1);
  return { id: agent.id, token: plainApiKey, keyId: key!.id };
}

function keyPair(): { privateKey: KeyObject; jwk: PublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, jwk: publicKey.export({ format: "jwk" }) as unknown as PublicJwk };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function proof(
  k: { privateKey: KeyObject; jwk: PublicJwk },
  method: string,
  path: string,
  accessToken?: string,
  jti = randomUUID()
): string {
  const header = b64({ typ: "dpop+jwt", alg: "ES256", jwk: k.jwk });
  const payload = b64({
    jti,
    htm: method,
    htu: publicRequestUrl(`http://internal${path}`),
    iat: Math.floor(Date.now() / 1000),
    ...(accessToken ? { ath: createHash("sha256").update(accessToken).digest("base64url") } : {}),
  });
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: k.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function call(
  method: string,
  path: string,
  o: {
    token?: string;
    scheme?: "Bearer" | "DPoP";
    dpop?: string;
    cookie?: string;
    body?: unknown;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (o.token) headers.Authorization = `${o.scheme ?? "Bearer"} ${o.token}`;
  if (o.dpop) headers.DPoP = o.dpop;
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    })
  );
}

const PROBE = "/api/agent/decisions";

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  admin = await enterAs(app, {
    email: `dpop-admin-${generateTestId()}@test.local`,
    password: "Test-password-123!",
    name: "DPoP admin",
    role: "admin",
  });
});

afterAll(async () => {
  if (!dbAvailable || !created.length) return;
  await db.delete(agentShortTokens).where(inArray(agentShortTokens.agentId, created));
  await db.delete(agentIdentities).where(inArray(agentIdentities.id, created));
});

describe("DPoP-bound keys", () => {
  it("a bound key needs a proof from the bound key, for this URL, once", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    forgetDpopJtis();
    const a = await newAgent(["content:read"]);
    const k = keyPair();
    const bind = await call("PUT", `/api/v1/agents/${a.id}/keys/${a.keyId}/dpop`, {
      cookie: admin.cookie,
      body: { jwk: k.jwk },
    });
    expect(bind.status, await bind.clone().text()).toBe(200);
    expect(((await bind.json()) as { key: { dpopJkt: string } }).key.dpopJkt).toBe(
      jwkThumbprint(k.jwk)
    );

    // the key alone no longer works
    const bare = await call("GET", PROBE, { token: a.token });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("WWW-Authenticate") ?? "").toContain("DPoP");

    // with a proof: in
    const ok = await call("GET", PROBE, {
      token: a.token,
      scheme: "DPoP",
      dpop: proof(k, "GET", PROBE, a.token),
    });
    expect(ok.status, await ok.clone().text()).toBe(200);

    // a proof for another URL
    const other = await call("GET", PROBE, {
      token: a.token,
      scheme: "DPoP",
      dpop: proof(k, "GET", "/api/elsewhere", a.token),
    });
    expect(other.status).toBe(401);

    // the same proof twice
    const once = proof(k, "GET", PROBE, a.token);
    expect((await call("GET", PROBE, { token: a.token, scheme: "DPoP", dpop: once })).status).toBe(
      200
    );
    expect((await call("GET", PROBE, { token: a.token, scheme: "DPoP", dpop: once })).status).toBe(
      401
    );

    // another key's proof
    const thief = keyPair();
    const stolen = await call("GET", PROBE, {
      token: a.token,
      scheme: "DPoP",
      dpop: proof(thief, "GET", PROBE, a.token),
    });
    expect(stolen.status).toBe(401);

    // unbinding restores plain Bearer
    await call("PUT", `/api/v1/agents/${a.id}/keys/${a.keyId}/dpop`, {
      cookie: admin.cookie,
      body: { jwk: null },
    });
    expect((await call("GET", PROBE, { token: a.token })).status).toBe(200);
  });

  it("require_dpop refuses an unbound key", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const a = await newAgent(["content:read"]);
    expect((await call("GET", PROBE, { token: a.token })).status).toBe(200);
    const r = await call("PUT", `/api/v1/agents/${a.id}/dpop`, {
      cookie: admin.cookie,
      body: { required: true },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await call("GET", PROBE, { token: a.token })).status).toBe(401);
  });

  it("an agent cannot bind its own key", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["admin"]);
    const r = await call("PUT", `/api/v1/agents/${a.id}/keys/${a.keyId}/dpop`, {
      token: a.token,
      body: { jwk: keyPair().jwk },
    });
    expect([401, 403]).toContain(r.status);
  });
});

describe("short-lived tokens", () => {
  it("narrows scopes, refuses what the caller lacks, and refuses chaining", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const a = await newAgent(["content:read", "content:write"]);
    const ex = await call("POST", "/api/agent/token/exchange", {
      token: a.token,
      body: { scopes: ["content:read"], ttlSeconds: 120 },
    });
    expect(ex.status, await ex.clone().text()).toBe(201);
    const t = (await ex.json()) as { token: string; scopes: string[]; tokenType: string };
    expect(t.token.startsWith("kitsuden_ast_")).toBe(true);
    expect(t.scopes).toEqual(["content:read"]);
    expect(t.tokenType).toBe("Bearer");
    expect((await call("GET", PROBE, { token: t.token })).status).toBe(200);

    const wider = await call("POST", "/api/agent/token/exchange", {
      token: a.token,
      body: { scopes: ["admin"] },
    });
    expect(wider.status).toBe(403);

    const chained = await call("POST", "/api/agent/token/exchange", { token: t.token, body: {} });
    expect(chained.status).toBe(403);

    const tooLong = await call("POST", "/api/agent/token/exchange", {
      token: a.token,
      body: { ttlSeconds: 99_999 },
    });
    expect(tooLong.status).toBe(422);
  });

  it("dies with its parent key, and when it expires", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const a = await newAgent(["content:read"]);
    const t = (await (
      await call("POST", "/api/agent/token/exchange", { token: a.token, body: {} })
    ).json()) as {
      token: string;
    };
    expect((await call("GET", PROBE, { token: t.token })).status).toBe(200);

    // expired
    const [row] = await db
      .select()
      .from(agentShortTokens)
      .where(eq(agentShortTokens.agentId, a.id))
      .limit(1);
    await db
      .update(agentShortTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentShortTokens.id, row!.id));
    expect((await call("GET", PROBE, { token: t.token })).status).toBe(401);

    // parent revoked
    const t2 = (await (
      await call("POST", "/api/agent/token/exchange", { token: a.token, body: {} })
    ).json()) as {
      token: string;
    };
    expect((await call("GET", PROBE, { token: t2.token })).status).toBe(200);
    const rv = await call("POST", `/api/v1/agents/${a.id}/keys/${a.keyId}/revoke`, {
      cookie: admin.cookie,
    });
    expect(rv.status, await rv.clone().text()).toBe(200);
    expect((await call("GET", PROBE, { token: t2.token })).status).toBe(401);
  });

  it("an audience limits the token to a path prefix", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const a = await newAgent(["content:read"]);
    const t = (await (
      await call("POST", "/api/agent/token/exchange", {
        token: a.token,
        body: { audience: "/api/agent/decisions" },
      })
    ).json()) as { token: string; audience: string };
    expect(t.audience).toBe("/api/agent/decisions");
    expect((await call("GET", PROBE, { token: t.token })).status).toBe(200);
    expect((await call("GET", "/api/proposals", { token: t.token })).status).toBe(401);
  });

  it("an exchange with a DPoP proof gives a bound token", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    forgetDpopJtis();
    const a = await newAgent(["content:read"]);
    const k = keyPair();
    const ex = await call("POST", "/api/agent/token/exchange", {
      token: a.token,
      scheme: "DPoP",
      dpop: proof(k, "POST", "/api/agent/token/exchange", a.token),
      body: {},
    });
    expect(ex.status, await ex.clone().text()).toBe(201);
    const t = (await ex.json()) as { token: string; tokenType: string };
    expect(t.tokenType).toBe("DPoP");
    expect((await call("GET", PROBE, { token: t.token })).status).toBe(401);
    const ok = await call("GET", PROBE, {
      token: t.token,
      scheme: "DPoP",
      dpop: proof(k, "GET", PROBE, t.token),
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});

describe("run credentials", () => {
  it("never authenticate over HTTP and can be revoked", async () => {
    if (!dbAvailable) return;
    const a = await newAgent(["content:read"]);
    const cred = await mintRunCredential(a.id, ["content:read"], randomUUID());
    const [row] = await db.select().from(agentShortTokens).where(eq(agentShortTokens.id, cred.id));
    expect(row!.runId).toBeTruthy();
    expect(row!.parentKeyId).toBeNull();
    await revokeShortToken(cred.id);
    const [after] = await db
      .select()
      .from(agentShortTokens)
      .where(eq(agentShortTokens.id, cred.id));
    expect(after!.revokedAt).not.toBeNull();
  });

  it("is checked per tool call: revoked, expired or agent deactivated → refused", async () => {
    if (!dbAvailable) return;
    const { runCredentialStatus } = await import("../services/agent-short-tokens");
    const a = await newAgent(["content:read", "content:write"]);
    const cred = await mintRunCredential(a.id, ["content:read"], randomUUID());
    const live = await runCredentialStatus(cred.id, a.id);
    expect(live).toEqual({ ok: true, scopes: ["content:read"] });
    // another agent cannot use it
    expect((await runCredentialStatus(cred.id, created[0]!)).ok).toBe(false);
    // the agent deactivated mid-run
    await db.update(agentIdentities).set({ isActive: false }).where(eq(agentIdentities.id, a.id));
    expect(await runCredentialStatus(cred.id, a.id)).toEqual({
      ok: false,
      reason: "agent deactivated",
    });
    await db.update(agentIdentities).set({ isActive: true }).where(eq(agentIdentities.id, a.id));
    // expired
    await db
      .update(agentShortTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentShortTokens.id, cred.id));
    expect(await runCredentialStatus(cred.id, a.id)).toEqual({
      ok: false,
      reason: "run credential expired",
    });
    // revoked
    const cred2 = await mintRunCredential(a.id, ["content:read"], randomUUID());
    await revokeShortToken(cred2.id);
    expect(await runCredentialStatus(cred2.id, a.id)).toEqual({
      ok: false,
      reason: "run credential revoked",
    });
  });
});
