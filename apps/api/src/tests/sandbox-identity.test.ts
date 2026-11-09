/**
 * Sandbox: the injected API acts with the identity of whoever runs it, and no more
 * ============================================================================
 *
 * Against the REAL app (test Postgres). An action's code only reaches
 * Kitsuden through `kitsuden.api.*`, and each call re-enters through the app
 * as an agent (see lib/sandbox/identity.ts). Here we try, from the
 * code, to get MORE than what was granted:
 *
 *   · without declared scopes there is no API;
 *   · with `datasets:<slug>:read` that dataset is read, but not another, nor is anything
 *     written, nor does it reach admin things (creating agents, keys);
 *   · headers and cookies the code tries to pass do not change who it is;
 *   · an agent that runs the action does not gain scopes it does not have and keeps
 *     its `!pattern` denials;
 *   · on cron/event, whoever CREATED the action answers, with their role as of NOW: if
 *     they are no longer admin, the code is left without an API.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { actions, authUsers, dataEntries, dataSets } from "../db/schema";
import { app } from "../index";
import { executeActionById } from "../lib/actions";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
const ORIGIN = "http://localhost:4321";
let cookie = "";
let adminId = "";
let ownValue: { id: string; slug: string };
let foreign: { id: string; slug: string };
const createdMany: string[] = [];

async function createDataset(prefix: string) {
  const slug = `${prefix}-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const [ds] = await db
    .insert(dataSets)
    .values({ name: slug, slug, schema: [{ key: "n", type: "text" }], policyJson: null } as never)
    .returning({ id: dataSets.id, slug: dataSets.slug });
  await db
    .insert(dataEntries)
    .values({ dataSetId: ds!.id, title: "row", data: { n: "1" } } as never);
  return ds!;
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

/** Creates a code action and runs it; returns what the code returned. */
async function run(
  auth: { cookie?: string; token?: string },
  code: string,
  scopes?: string[]
): Promise<{ success: boolean; result: unknown; error?: string }> {
  const slug = `sbx-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  // It is always created by a person: since code promotion an agent does not create code outside
  // of promotion (docs/agents/promotion.md). It is run by `auth`.
  const high = await request({ cookie }, "POST", "/api/actions", {
    name: slug,
    slug,
    type: "code",
    trigger: "manual",
    config: { code, scopes, timeoutMs: 30_000 },
  });
  expect(high.status, await high.clone().text()).toBe(201);
  const { id } = (await high.json()) as { id: string };
  createdMany.push(id);
  const r = await request(auth, "POST", `/api/actions/${id}/execute`, {});
  expect(r.status).toBe(200);
  return (await r.json()) as { success: boolean; result: unknown; error?: string };
}

const statuses = (paths: [string, string, unknown?][]) => `
  const output = {};
  for (const [m, c, b] of ${JSON.stringify(paths)}) output[m + " " + c.split("?")[0]] = (await kitsuden.api.request(m, c, b)).status;
  return output;
`;

describe("sandbox — kitsuden.api identity", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie, userId: adminId } = await enterAs(app, {
      email: `sbx-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Sandbox Admin",
      role: "admin",
    }));
    ownValue = await createDataset("sbx-own");
    foreign = await createDataset("sbx-foreign");
  }, 60_000);

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdMany) await db.delete(actions).where(eq(actions.id, id));
    for (const ds of [ownValue, foreign])
      if (ds) await db.delete(dataSets).where(eq(dataSets.id, ds.id));
  });

  it("without declared scopes, the code has no API", async () => {
    if (!dbAvailable) return;
    const r = await run({ cookie }, "return (await kitsuden.api.get('/api/data-sets')).status;");
    expect(r.success).toBe(false);
    expect(r.error).toContain("no Kitsuden API identity");
  }, 60_000);

  it("admin person + datasets:<slug>:read: reads THAT dataset and nothing else", async () => {
    if (!dbAvailable) return;
    const r = await run(
      { cookie },
      statuses([
        ["GET", `/api/datasets/${ownValue.id}/entries`],
        ["GET", `/api/datasets/${foreign.id}/entries`],
        ["POST", `/api/datasets/${ownValue.id}/entries`, { title: "x", data: { n: "2" } }],
        ["GET", "/api/admin/agents"],
        ["POST", "/api/admin/agents", { name: "created-from-the-sandbox", scopes: ["admin"] }],
        ["GET", "/api/keys"],
        ["PATCH", "/api/settings", { siteName: "pwned" }],
      ]),
      [`datasets:${ownValue.slug}:read`]
    );
    expect(r.error ?? null).toBeNull();
    const s = r.result as Record<string, number>;
    expect(s[`GET /api/datasets/${ownValue.id}/entries`]).toBe(200);
    expect([403, 404]).toContain(s[`GET /api/datasets/${foreign.id}/entries`]);
    expect([401, 403, 404]).toContain(s[`POST /api/datasets/${ownValue.id}/entries`]);
    for (const k of [
      "GET /api/admin/agents",
      "POST /api/admin/agents",
      "GET /api/keys",
      "PATCH /api/settings",
    ]) {
      // 401/403, not 404: the route exists and the gate closes it.
      expect([401, 403]).toContain(s[k]);
    }
    // And no agent was created from the code.
    const [createdItem] = await db
      .execute(
        sql`SELECT count(*)::int AS n FROM agent_identities WHERE name = 'created-from-the-sandbox'`
      )
      .then(
        (x) => (Array.isArray(x) ? x : ((x as { rows: unknown[] }).rows ?? [])) as { n: number }[]
      );
    expect(createdItem?.n ?? 0).toBe(0);
  }, 60_000);

  it("headers and cookies passed by the code do not change the identity", async () => {
    if (!dbAvailable) return;
    // The injected API does not accept headers; even if the code puts them in the
    // body or the query, whoever arrives is the synthetic agent.
    const r = await run(
      { cookie },
      `
      const a = await kitsuden.api.request("GET", "/api/admin/agents", { headers: { Cookie: env.C, Authorization: "Bearer x" } });
      const b = await kitsuden.api.request("GET", "/api/admin/agents?Authorization=Bearer%20x");
      const c = await fetch("http://localhost:3000/api/admin/agents").then((r) => r.status, (e) => "fetch-rejected");
      return [a.status, b.status, c];
      `,
      [`datasets:${ownValue.slug}:read`]
    );
    const [a, b, c] = r.result as [number, number, string];
    expect([401, 403]).toContain(a);
    expect([401, 403]).toContain(b);
    expect(c).toBe("fetch-rejected");
  }, 60_000);

  it("an agent that runs does not gain scopes it does not have and keeps its denials", async () => {
    if (!dbAvailable) return;
    const { plainApiKey } = await createAgent({
      name: `sbx-agent-${generateTestId()}`,
      scopes: ["admin", `!datasets:${foreign.slug}:*`],
      rateLimit: 100_000,
    });
    const r = await run(
      { token: plainApiKey },
      statuses([
        ["GET", `/api/datasets/${ownValue.id}/entries`],
        ["GET", `/api/datasets/${foreign.id}/entries`],
        ["GET", "/api/admin/agents"],
      ]),
      ["admin", "superpower:invented"]
    );
    expect(r.error ?? null).toBeNull();
    const s = r.result as Record<string, number>;
    expect(s[`GET /api/datasets/${ownValue.id}/entries`]).toBe(200);
    // Control: it IS the agent (admin), not an identity wrongly trimmed.
    expect(s["GET /api/admin/agents"]).toBe(200);
    // The agent's denial travels with it into the sandbox.
    expect([403, 404]).toContain(s[`GET /api/datasets/${foreign.id}/entries`]);
  }, 60_000);

  it("on cron/event, whoever created the action answers, with their role as of NOW", async () => {
    if (!dbAvailable) return;
    const slug = `sbx-cron-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const high = await request({ cookie }, "POST", "/api/actions", {
      name: slug,
      slug,
      type: "code",
      trigger: "manual",
      config: {
        code: `return (await kitsuden.api.get("/api/datasets/${ownValue.id}/entries")).status;`,
        scopes: [`datasets:${ownValue.slug}:read`],
      },
    });
    const { id, createdById } = (await high.json()) as { id: string; createdById: string };
    createdMany.push(id);
    expect(createdById).toBe(adminId);

    const asAdmin = await executeActionById(id, { trigger: "cron", triggerEvent: "cron" });
    expect(asAdmin.result).toBe(200);

    await db.update(authUsers).set({ role: "user" }).where(eq(authUsers.id, adminId));
    try {
      const degraded = await executeActionById(id, { trigger: "cron", triggerEvent: "cron" });
      expect(degraded.success).toBe(false);
      expect(degraded.error).toContain("no Kitsuden API identity");
    } finally {
      await db.update(authUsers).set({ role: "admin" }).where(eq(authUsers.id, adminId));
    }
  }, 60_000);
});
