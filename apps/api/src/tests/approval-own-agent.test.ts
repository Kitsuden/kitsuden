/**
 * An editor does not approve the proposals of an agent they sponsor
 * ============================================================================
 *
 * Security review 2026-11-03: `reasonNotToApprove` never compared the approver
 * with the agent's signer, so the human who answers for an agent could wave
 * its held writes through — a four-eyes check with one pair of eyes.
 *
 * Decision: an editor who sponsors the agent cannot approve (`own_agent`);
 * another editor can; an admin can, even their own agent's (admins are trusted,
 * and a solo install has one human who sponsors everything). Both the signer
 * recorded on the proposal and the agent's current signer count.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, agentProposals } from "../db/schema";
import { app } from "../index";
import { reasonNotToApprove, type Proposal } from "../lib/approvals";
import { createAgent } from "../services/agent-auth";

import { enterAs, generateTestId, isDatabaseAvailable } from "./setup";

let dbAvailable = false;
let admin = { cookie: "", userId: "" };
let editor = { cookie: "", userId: "" };
let otherEditor = { cookie: "", userId: "" };
const agents: string[] = [];

async function agentSponsoredBy(userId: string | null): Promise<string> {
  const { agent } = await createAgent({ name: `own-${generateTestId()}`, scopes: ["admin"] });
  agents.push(agent.id);
  await db
    .update(agentIdentities)
    .set({ sponsorUserId: userId })
    .where(eq(agentIdentities.id, agent.id));
  return agent.id;
}

/** A pending proposal on a staff-gated route an editor could approve. */
async function proposal(agentId: string, sponsorUserId: string | null): Promise<Proposal> {
  const [p] = await db
    .insert(agentProposals)
    .values({
      agentId,
      channel: "rest",
      method: "DELETE",
      path: `/api/blog/categories/${generateTestId()}`,
      fingerprint: generateTestId(),
      reason: "test",
      status: "pending",
      sponsorUserId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  return p!;
}

describe("approving your own agent's proposals", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    const make = (role: "admin" | "editor") =>
      enterAs(app, {
        email: `own-${role}-${generateTestId()}@example.com`,
        password: "TestPassword123!",
        name: role,
        role,
      });
    admin = await make("admin");
    editor = await make("editor");
    otherEditor = await make("editor");
  }, 120_000);

  afterAll(async () => {
    if (!dbAvailable || !agents.length) return;
    await db.delete(agentProposals).where(inArray(agentProposals.agentId, agents));
    await db.delete(agentIdentities).where(inArray(agentIdentities.id, agents));
  }, 60_000);

  it("the sponsoring editor cannot; another editor can", async () => {
    if (!dbAvailable) return;
    const agentId = await agentSponsoredBy(editor.userId);
    const p = await proposal(agentId, editor.userId);
    expect(await reasonNotToApprove({ id: editor.userId, role: "editor" }, p)).toBe("own_agent");
    expect(await reasonNotToApprove({ id: otherEditor.userId, role: "editor" }, p)).toBeNull();
  }, 60_000);

  it("the agent's CURRENT sponsor counts too, not only the one recorded on the proposal", async () => {
    if (!dbAvailable) return;
    const agentId = await agentSponsoredBy(editor.userId);
    const p = await proposal(agentId, otherEditor.userId);
    expect(await reasonNotToApprove({ id: editor.userId, role: "editor" }, p)).toBe("own_agent");
    expect(await reasonNotToApprove({ id: otherEditor.userId, role: "editor" }, p)).toBe(
      "own_agent"
    );
  }, 60_000);

  it("an admin approves their own agent's proposals", async () => {
    if (!dbAvailable) return;
    const agentId = await agentSponsoredBy(admin.userId);
    const p = await proposal(agentId, admin.userId);
    expect(await reasonNotToApprove({ id: admin.userId, role: "admin" }, p)).toBeNull();
  }, 60_000);

  it("over HTTP: 403 with the reason, the proposal stays pending, and the inbox says why", async () => {
    if (!dbAvailable) return;
    const agentId = await agentSponsoredBy(editor.userId);
    const p = await proposal(agentId, editor.userId);
    const headers = {
      origin: "http://localhost:4321",
      Cookie: editor.cookie,
      "Content-Type": "application/json",
    };
    const res = await app.request(
      new Request(`http://localhost:3000/api/approvals/proposals/${p.id}/approve`, {
        method: "POST",
        headers,
        body: "{}",
      })
    );
    expect(res.status, await res.clone().text()).toBe(403);
    expect(await res.text()).toContain("sponsor");
    const [after] = await db
      .select({ status: agentProposals.status })
      .from(agentProposals)
      .where(eq(agentProposals.id, p.id));
    expect(after?.status).toBe("pending");

    const detail = await app.request(
      new Request(`http://localhost:3000/api/approvals/proposals/${p.id}`, { headers })
    );
    expect(detail.status, await detail.clone().text()).toBe(200);
    const body = (await detail.json()) as { canDecide: boolean; cannotDecideReason: string };
    expect(body.canDecide).toBe(false);
    expect(body.cannotDecideReason).toBe("own_agent");
  }, 60_000);
});
