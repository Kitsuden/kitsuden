/**
 * An approval is bound to the exact operation the reviewer was shown (0087)
 * ============================================================================
 *
 *   · approving needs the proposal's `operationHash`: missing or different → 409
 *     KITSUDEN_E_APPROVAL_STALE and nothing runs;
 *   · with the right hash it runs once;
 *   · a stored row changed after it was held (body edited in the database) is
 *     NOT executed: the proposal fails and `proposal_integrity_failed` is audited;
 *   · a legacy proposal (held before 0087, no hash) is still approvable.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentAuditLogs, agentIdentities, agentProposals } from "../db/schema";
import { app } from "../index";
import { clearQuotaMemory } from "../lib/agent-quotas";
import { createProposal } from "../lib/approvals";
import { authenticateAgent, createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

setDefaultTimeout(30_000);

let dbAvailable = false;
let admin = { cookie: "", userId: "" };
const ORIGIN = "http://localhost:4321";
const agents: string[] = [];

async function heldDecision(reason = `held-${generateTestId()}`) {
  const { agent, plainApiKey } = await createAgent({
    name: `binding-${generateTestId()}`,
    scopes: ["content:read"],
    rateLimit: 100_000,
  });
  agents.push(agent.id);
  const auth = await authenticateAgent(plainApiKey);
  expect(auth.success).toBe(true);
  const body = { action: "binding-test", reason };
  const { proposal } = await createProposal({
    agent: auth.context!,
    channel: "rest",
    method: "POST",
    path: "/api/agent/decisions",
    body,
    type: "application/json",
    fingerprint: generateTestId(),
    idempotencyKey: null,
    reason: "propose_only",
  });
  return { agentId: agent.id, proposal };
}

async function approve(id: string, body: Record<string, unknown>) {
  const res = await app.request(
    new Request(`http://localhost:3000/api/approvals/proposals/${id}/approve`, {
      method: "POST",
      headers: { origin: ORIGIN, Cookie: admin.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  admin = await enterAs(app, {
    email: `binding-admin-${generateTestId()}@test.local`,
    password: "Test-password-123!",
    name: "Binding admin",
    role: "admin",
  });
});

afterAll(async () => {
  if (!dbAvailable || !agents.length) return;
  await db.delete(agentProposals).where(inArray(agentProposals.agentId, agents));
  await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
});

describe("approval bound to the operation hash", () => {
  it("is stored with the proposal and shown to the reviewer", async () => {
    if (!dbAvailable) return;
    const { proposal } = await heldDecision();
    expect(proposal.operationHash).toMatch(/^[0-9a-f]{64}$/);
    const view = await app.request(
      new Request(`http://localhost:3000/api/approvals/proposals/${proposal.id}`, {
        headers: { origin: ORIGIN, Cookie: admin.cookie },
      })
    );
    const v = (await view.json()) as { proposal?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const shown = (v.proposal ?? v) as Record<string, unknown>;
    expect(shown.operationHash).toBe(proposal.operationHash);
    expect(shown.binding).toBe("bound");
  });

  it("missing or different hash → 409 and nothing runs; the right hash runs once", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const { proposal } = await heldDecision();
    const missing = await approve(proposal.id, {});
    expect(missing.status).toBe(409);
    const wrong = await approve(proposal.id, { operationHash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(JSON.stringify(wrong.body)).toContain("KITSUDEN_E_APPROVAL_STALE");
    const [still] = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, proposal.id));
    expect(still!.status).toBe("pending");

    const ok = await approve(proposal.id, { operationHash: proposal.operationHash });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.proposal.status).toBe("executed");
    const [row] = await db.select().from(agentProposals).where(eq(agentProposals.id, proposal.id));
    expect(row!.approvedOperationHash).toBe(proposal.operationHash);
    expect(row!.approvalMac).toMatch(/^[0-9a-f]{64}$/);

    const again = await approve(proposal.id, { operationHash: proposal.operationHash });
    expect(again.status).toBe(409);
  });

  it("a row tampered after it was held is not executed, and that is audited", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const { agentId, proposal } = await heldDecision("the original reason");
    // Someone with database access swaps what will run, keeping the hash the reviewer sees.
    await db
      .update(agentProposals)
      .set({ body: { action: "binding-test", reason: "something else entirely" } })
      .where(eq(agentProposals.id, proposal.id));
    const r = await approve(proposal.id, { operationHash: proposal.operationHash });
    expect([200, 409, 422]).toContain(r.status);
    const [row] = await db.select().from(agentProposals).where(eq(agentProposals.id, proposal.id));
    expect(row!.status).toBe("failed");
    // Closed without running: the error says why (executed_at is "closed at" for every outcome).
    expect(row!.resultError).toContain("integrity_check_failed (operation_tampered)");
    expect(row!.resultStatus).toBeNull();
    const audited = await db
      .select()
      .from(agentAuditLogs)
      .where(
        and(
          eq(agentAuditLogs.agentId, agentId),
          eq(agentAuditLogs.action, "proposal_integrity_failed")
        )
      );
    expect(audited.length).toBe(1);
  });

  it("a legacy proposal without a hash is still approvable", async () => {
    if (!dbAvailable) return;
    clearQuotaMemory();
    const { proposal } = await heldDecision();
    await db
      .update(agentProposals)
      .set({ operationHash: null })
      .where(eq(agentProposals.id, proposal.id));
    const r = await approve(proposal.id, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.proposal.status).toBe("executed");
  });
});
