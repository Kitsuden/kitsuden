/**
 * New agent keys expire by default
 * ============================================================================
 *
 * Security review 2026-11-03: every path that issued an agent key left
 * `expires_at` NULL unless the caller asked, so a key forgotten in a CI
 * variable worked forever. Now a key without `expiresInDays` gets
 * `AGENT_KEY_DEFAULT_EXPIRY_DAYS` (90); `expiresInDays: null` still asks for
 * one that never expires, on purpose.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentApiKeys, agentIdentities } from "../db/schema";
import { app } from "../index";
import {
  agentKeyExpiresAt,
  createAgent,
  DEFAULT_AGENT_KEY_EXPIRY_DAYS,
  defaultAgentKeyExpiryDays,
} from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

const DAY = 86_400_000;
let dbAvailable = false;
let admin = { cookie: "", userId: "" };
const agents: string[] = [];
const saved = process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS;

function call(method: string, path: string, body?: unknown) {
  return app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers: {
        origin: "http://localhost:4321",
        Cookie: admin.cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function keysOf(agentId: string) {
  return db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
}

/** Days from now until `d`, rounded. */
const daysUntil = (d: Date | null | undefined) =>
  d ? Math.round((d.getTime() - Date.now()) / DAY) : null;

describe("agent key expiry", () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS;
    else process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS = saved;
  });

  it("the rule: omitted → default, null → never, a number → that many days", () => {
    delete process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS;
    const now = Date.UTC(2026, 10, 4);
    expect(defaultAgentKeyExpiryDays()).toBe(DEFAULT_AGENT_KEY_EXPIRY_DAYS);
    expect(agentKeyExpiresAt(undefined, now)?.getTime()).toBe(now + 90 * DAY);
    expect(agentKeyExpiresAt(null, now)).toBeNull();
    expect(agentKeyExpiresAt(0, now)).toBeNull();
    expect(agentKeyExpiresAt(7, now)?.getTime()).toBe(now + 7 * DAY);

    process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS = "30";
    expect(agentKeyExpiresAt(undefined, now)?.getTime()).toBe(now + 30 * DAY);
    process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS = "0";
    expect(agentKeyExpiresAt(undefined, now)).toBeNull();
    process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS = "nonsense";
    expect(defaultAgentKeyExpiryDays()).toBe(DEFAULT_AGENT_KEY_EXPIRY_DAYS);
  });

  describe("every path that issues a key", () => {
    beforeAll(async () => {
      dbAvailable = await isDatabaseAvailable();
      if (!dbAvailable) return;
      admin = await enterAs(app, {
        email: `keyexp-${generateTestId()}@example.com`,
        password: "TestPassword123!",
        name: "Key expiry",
        role: "admin",
      });
    }, 120_000);

    afterAll(async () => {
      if (!dbAvailable || !agents.length) return;
      await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
    });

    it("createAgent (service)", async () => {
      if (!dbAvailable) return;
      delete process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS;
      const { agent } = await createAgent({ name: `keyexp-${generateTestId()}` });
      agents.push(agent.id);
      expect(daysUntil((await keysOf(agent.id))[0]?.expiresAt)).toBe(90);
      const never = await createAgent({ name: `keyexp-${generateTestId()}`, expiresInDays: null });
      agents.push(never.agent.id);
      expect((await keysOf(never.agent.id))[0]?.expiresAt).toBeNull();
    }, 60_000);

    it("POST /api/admin/agents and POST /api/admin/agents/:id/keys", async () => {
      if (!dbAvailable) return;
      delete process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS;
      const r = await call("POST", "/api/admin/agents", { name: `keyexp-${generateTestId()}` });
      expect(r.status, await r.clone().text()).toBe(201);
      const id = ((await r.json()) as { data: { agent: { id: string } } }).data.agent.id;
      agents.push(id);
      expect(daysUntil((await keysOf(id))[0]?.expiresAt)).toBe(90);

      const k = await call("POST", `/api/admin/agents/${id}/keys`, {});
      expect(k.status, await k.clone().text()).toBe(201);
      const never = await call("POST", `/api/admin/agents/${id}/keys`, { expiresInDays: null });
      expect(never.status).toBe(201);
      const rows = await keysOf(id);
      expect(rows.length).toBe(3);
      expect(rows.filter((x) => x.expiresAt === null).length).toBe(1);
      expect(rows.filter((x) => daysUntil(x.expiresAt) === 90).length).toBe(2);
    }, 60_000);

    it("POST /api/v1/agents/:id/keys (SDK) and its rotation", async () => {
      if (!dbAvailable) return;
      process.env.AGENT_KEY_DEFAULT_EXPIRY_DAYS = "14";
      const { agent } = await createAgent({ name: `keyexp-${generateTestId()}`, expiresInDays: 5 });
      agents.push(agent.id);
      const k = await call("POST", `/api/v1/agents/${agent.id}/keys`, { name: "ci" });
      expect(k.status, await k.clone().text()).toBe(201);
      const created = (await k.json()) as { key: { id: string } };
      const rot = await call("POST", `/api/v1/agents/${agent.id}/keys/${created.key.id}/rotate`, {
        graceHours: 0,
      });
      expect(rot.status, await rot.clone().text()).toBe(201);
      const never = await call("POST", `/api/v1/agents/${agent.id}/keys`, { expiresInDays: null });
      expect(never.status).toBe(201);
      const days = (await keysOf(agent.id)).map((x) => daysUntil(x.expiresAt));
      // 5 (createAgent), 0 (rotated away, grace 0), 14 (rotation), null (asked never)
      expect(days.filter((d) => d === 14).length).toBe(1);
      expect(days.filter((d) => d === 5).length).toBe(1);
      expect(days.filter((d) => d === null).length).toBe(1);
    }, 60_000);
  });
});
