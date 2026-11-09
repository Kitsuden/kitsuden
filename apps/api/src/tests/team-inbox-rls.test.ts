/**
 * The team's approval inbox under RLS (rls-system-only.sql)
 * ============================================================================
 *
 * `agent_proposals` and `ledger_reviews` are read and written by the API and
 * the panel without an RLS context (the system). Under a request's context,
 * only the human team (`admin`, `editor`) reads or writes them: an agent, a
 * user or an anonymous visitor reads ZERO rows and cannot insert, whatever
 * surface asks. Measured as the application role (`kitsuden_app`, no
 * superuser, no BYPASSRLS), the role the API serves with in production.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";

import { db } from "../db";
import { agentIdentities, agentProposals, ledgerReviews } from "../db/schema";
import { createAgent } from "../services/agent-auth";

import { ensureAppRole, generateTestId, isDatabaseAvailable } from "./setup";

let ready = false;
let agentId = "";
let proposalId = "";

async function as<T>(role: string, userId: string, query: SQL): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE kitsuden_app`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_role', ${role}, true)`);
    const r = (await tx.execute(query)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(r) ? r : (r.rows ?? []);
  });
}

const count = async (role: string, userId: string, table: string) =>
  Number(
    (
      await as<{ n: number }>(
        role,
        userId,
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE ${sql.raw(
          table === "agent_proposals" ? "id" : "proposal_id"
        )} = ${proposalId}::uuid`
      )
    )[0]?.n ?? 0
  );

describe("team approval inbox under RLS", () => {
  beforeAll(async () => {
    if (!(await isDatabaseAvailable())) return;
    ready = await ensureAppRole();
    if (!ready) return;
    const { agent } = await createAgent({ name: `inbox-rls-${generateTestId()}`, scopes: [] });
    agentId = agent.id;
    const [p] = await db
      .insert(agentProposals)
      .values({
        agentId,
        channel: "rest",
        method: "POST",
        path: "/api/x",
        fingerprint: generateTestId(),
        reason: "test",
        expiresAt: new Date(Date.now() + 3_600_000),
      } as never)
      .returning({ id: agentProposals.id });
    proposalId = p!.id;
    await db.insert(ledgerReviews).values({
      proposalId,
      dueAt: new Date(Date.now() + 86_400_000),
      scheduledBy: "someone",
    } as never);
  });

  afterAll(async () => {
    if (agentId) await db.delete(agentIdentities).where(eq(agentIdentities.id, agentId));
  });

  it("the human team and the system read the proposal and its review", async () => {
    if (!ready) return;
    for (const table of ["agent_proposals", "ledger_reviews"]) {
      expect(await count("admin", "admin-1", table)).toBe(1);
      expect(await count("editor", "editor-1", table)).toBe(1);
      expect(await count("", "", table)).toBe(1);
    }
  });

  it("an agent, a user or an anonymous visitor reads zero rows", async () => {
    if (!ready) return;
    for (const table of ["agent_proposals", "ledger_reviews"]) {
      expect(await count("agent", agentId, table)).toBe(0);
      expect(await count("user", "user-1", table)).toBe(0);
      expect(await count("anonymous", "", table)).toBe(0);
    }
  });

  it("an agent cannot write a review or approve its own proposal through SQL", async () => {
    if (!ready) return;
    const refused = await as(
      "agent",
      agentId,
      sql`INSERT INTO ledger_reviews (proposal_id, due_at, scheduled_by)
          VALUES (${proposalId}::uuid, now() + interval '1 day', ${agentId})`
    ).then(
      () => null,
      (err: unknown) => err as { cause?: { message?: string }; message?: string }
    );
    expect(refused?.cause?.message ?? refused?.message ?? "").toMatch(/row-level security/);
    const updated = await as<{ id: string }>(
      "agent",
      agentId,
      sql`UPDATE agent_proposals SET status = 'executed' WHERE id = ${proposalId}::uuid RETURNING id`
    );
    expect(updated).toHaveLength(0);
  });
});
