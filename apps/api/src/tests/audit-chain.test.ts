/**
 * The agent audit hash chain on real Postgres (migration 0088)
 * ============================================================================
 *
 *   · 50 concurrent writes give one gapless chain that verifies;
 *   · UPDATE and DELETE are refused by the trigger;
 *   · a row edited with the trigger off (a superuser) is found at its seq;
 *   · the retention prune leaves a checkpoint and the rest still verifies;
 *   · deleting an agent keeps its history;
 *   · the verify endpoint is for human admins only.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
  setSystemTime,
} from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities } from "../db/schema";
import { app } from "../index";
import { verifyAuditChain } from "../lib/audit-chain";
import { cleanupOldLogs, registerAgentAction } from "../services/agent-audit";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

setDefaultTimeout(60_000);

let dbAvailable = false;
let admin = { cookie: "", userId: "" };
let agentId = "";
let agentToken = "";

const rowsOf = (r: unknown) =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, any>[];

const write = (n: number, tag: string) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      registerAgentAction({
        agentId,
        action: "tool_call",
        resource: "tool",
        resourceId: `${tag}-${i}`,
        details: { i, tag, nested: { b: 1, a: [i] } },
        success: true,
      })
    )
  );

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  admin = await enterAs(app, {
    email: `audit-admin-${generateTestId()}@test.local`,
    password: "Test-password-123!",
    name: "Audit admin",
    role: "admin",
  });
  const { agent, plainApiKey } = await createAgent({
    name: `audit-${generateTestId()}`,
    scopes: ["admin"],
  });
  agentId = agent.id;
  agentToken = plainApiKey;
});

afterAll(() => setSystemTime());

describe("the chain", () => {
  it("concurrent writes stay one gapless chain that verifies", async () => {
    if (!dbAvailable) return;
    await write(50, `burst-${generateTestId()}`);
    const r = await verifyAuditChain();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.checked).toBeGreaterThanOrEqual(50);
    const [gaps] = rowsOf(
      await db.execute(
        sql`SELECT count(*)::int AS n, max(seq) - min(seq) + 1 AS span FROM agent_audit_logs WHERE seq IS NOT NULL`
      )
    );
    expect(Number(gaps!.n)).toBe(Number(gaps!.span));
  });

  it("UPDATE and DELETE are refused", async () => {
    if (!dbAvailable) return;
    const run = (q: ReturnType<typeof sql>) => Promise.resolve().then(() => db.execute(q));
    await expect(
      run(sql`UPDATE agent_audit_logs SET resource = 'x' WHERE agent_id = ${agentId}`)
    ).rejects.toThrow();
    await expect(
      run(sql`DELETE FROM agent_audit_logs WHERE agent_id = ${agentId}`)
    ).rejects.toThrow();
  });

  it("a row edited behind the trigger's back is found at its seq", async () => {
    if (!dbAvailable) return;
    await write(3, `tamper-${generateTestId()}`);
    const [victim] = rowsOf(
      await db.execute(
        sql`SELECT seq FROM agent_audit_logs WHERE seq IS NOT NULL ORDER BY seq DESC OFFSET 1 LIMIT 1`
      )
    );
    const seq = Number(victim!.seq);
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE agent_audit_logs DISABLE TRIGGER agent_audit_logs_guard`);
      await tx.execute(
        sql`UPDATE agent_audit_logs SET details = '{"rewritten":true}'::jsonb WHERE seq = ${seq}`
      );
      await tx.execute(sql`ALTER TABLE agent_audit_logs ENABLE TRIGGER agent_audit_logs_guard`);
    });
    const r = await verifyAuditChain();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("hash_mismatch");
    expect(r.firstBadSeq).toBe(seq);
    // put the evidence back as it was so the rest of the suite can continue
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE agent_audit_logs DISABLE TRIGGER agent_audit_logs_guard`);
      await tx.execute(sql`DELETE FROM agent_audit_logs WHERE seq >= ${seq}`);
      await tx.execute(sql`ALTER TABLE agent_audit_logs ENABLE TRIGGER agent_audit_logs_guard`);
    });
    expect((await verifyAuditChain()).ok).toBe(true);
  });

  it("the retention prune leaves a checkpoint and the rest verifies", async () => {
    if (!dbAvailable) return;
    setSystemTime(new Date(Date.now() - 5 * 86_400_000));
    await write(4, `old-${generateTestId()}`);
    setSystemTime();
    await write(3, `new-${generateTestId()}`);
    const pruned = await cleanupOldLogs(2);
    expect(pruned).toBeGreaterThanOrEqual(4);
    const [cp] = rowsOf(
      await db.execute(sql`SELECT seq FROM agent_audit_checkpoints ORDER BY seq DESC LIMIT 1`)
    );
    expect(cp).toBeDefined();
    const r = await verifyAuditChain();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.checkpointSeq).toBe(Number(cp!.seq));
  });

  it("deleting an agent keeps its history", async () => {
    if (!dbAvailable) return;
    const { agent } = await createAgent({ name: `gone-${generateTestId()}`, scopes: [] });
    await registerAgentAction({
      agentId: agent.id,
      action: "tool_call",
      resource: "tool",
      success: true,
    });
    await db.execute(sql`DELETE FROM agent_identities WHERE id = ${agent.id}`);
    const [kept] = rowsOf(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM agent_audit_logs WHERE agent_id = ${agent.id}`
      )
    );
    expect(Number(kept!.n)).toBeGreaterThanOrEqual(1);
    expect((await verifyAuditChain()).ok).toBe(true);
  });
});

describe("the endpoint", () => {
  it("answers a human admin, never an agent", async () => {
    if (!dbAvailable) return;
    const asAdmin = await app.request(
      new Request("http://localhost:3000/api/admin/audit/verify", {
        headers: { origin: "http://localhost:4321", Cookie: admin.cookie },
      })
    );
    expect(asAdmin.status, await asAdmin.clone().text()).toBe(200);
    expect(((await asAdmin.json()) as { ok: boolean }).ok).toBe(true);
    const asAgent = await app.request(
      new Request("http://localhost:3000/api/admin/audit/verify", {
        headers: { origin: "http://localhost:4321", Authorization: `Bearer ${agentToken}` },
      })
    );
    expect([401, 403]).toContain(asAgent.status);
    await db.delete(agentIdentities).where(sql`${agentIdentities.id} = ${agentId}`);
  });
});
