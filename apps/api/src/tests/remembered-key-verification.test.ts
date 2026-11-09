/**
 * Agent keys: remembering the argon2 result opens nothing that was previously closed
 * ============================================================================
 *
 * Performance: an argon2 verification that succeeded is remembered
 * (HMAC of the secret with a process key, bound to the stored hash). Against
 * the real test database, with real argon2:
 *   · the same key still gets in (and the second time without argon2);
 *   · a wrong secret for the SAME public id stays out, even if the
 *     good one is remembered, and it does not erase what is remembered;
 *   · revoking, expiring or deactivating cut access on the next request;
 *   · a rotated hash in the row does not reuse what is remembered.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

const { isDatabaseAvailable, clearTestData, generateTestId } = await import("./setup");

let dbAvailable = false;

describe("remembered key verification", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await clearTestData();
  });
  afterAll(async () => {
    if (dbAvailable) await clearTestData();
  });

  it("gets in with the good key, and not with a changed secret even if the good one is remembered", async () => {
    if (!dbAvailable) return;
    const { createAgent, authenticateAgent, forgetKeyChecks, parseAgentApiKey } =
      await import("../services/agent-auth");
    forgetKeyChecks();
    const { plainApiKey } = await createAgent({
      name: `remembered-${generateTestId()}`,
      scopes: ["mcp:connect"],
    });

    const t0 = performance.now();
    expect((await authenticateAgent(plainApiKey)).success).toBe(true);
    const first = performance.now() - t0;
    const t1 = performance.now();
    expect((await authenticateAgent(plainApiKey)).success).toBe(true);
    const second = performance.now() - t1;
    // The second one does not pay argon2 (~30 ms): the exact time is not measured, only
    // that it is not slower than the first
    expect(second).toBeLessThanOrEqual(first + 5);

    const p = parseAgentApiKey(plainApiKey)!;
    const last = p.secret.at(-1) === "A" ? "B" : "A";
    const changed = plainApiKey.slice(0, -1) + last;
    const bad = await authenticateAgent(changed);
    expect(bad.success).toBe(false);
    expect(bad.code).toBe("INVALID_KEY");

    // The bad attempt neither erased nor damaged what was remembered
    expect((await authenticateAgent(plainApiKey)).success).toBe(true);
  });

  it("revoking, expiring and deactivating cut access on the next request even if it is remembered", async () => {
    if (!dbAvailable) return;
    const { db } = await import("../db");
    const { agentApiKeys, agentIdentities } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const { createAgent, authenticateAgent, revokeApiKey } = await import("../services/agent-auth");

    // Revoked
    const a = await createAgent({ name: `revoked-${generateTestId()}`, scopes: ["mcp:connect"] });
    const okA = await authenticateAgent(a.plainApiKey);
    expect(okA.success).toBe(true);
    await revokeApiKey(okA.context!.keyId);
    const afterRevoking = await authenticateAgent(a.plainApiKey);
    expect(afterRevoking.success).toBe(false);
    expect(afterRevoking.code).toBe("KEY_REVOKED");

    // Expired
    const b = await createAgent({ name: `expired-${generateTestId()}`, scopes: ["mcp:connect"] });
    const okB = await authenticateAgent(b.plainApiKey);
    expect(okB.success).toBe(true);
    await db
      .update(agentApiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentApiKeys.id, okB.context!.keyId));
    expect((await authenticateAgent(b.plainApiKey)).success).toBe(false);

    // Agent deactivated
    const c = await createAgent({
      name: `disabled-${generateTestId()}`,
      scopes: ["mcp:connect"],
    });
    expect((await authenticateAgent(c.plainApiKey)).success).toBe(true);
    await db
      .update(agentIdentities)
      .set({ isActive: false })
      .where(eq(agentIdentities.id, c.agent.id));
    const afterDisabling = await authenticateAgent(c.plainApiKey);
    expect(afterDisabling.success).toBe(false);
    expect(afterDisabling.code).toBe("AGENT_DEACTIVATED");
  });

  it("a rotated hash in the row forces verifying again (and the old secret no longer gets in)", async () => {
    if (!dbAvailable) return;
    const { db } = await import("../db");
    const { agentApiKeys } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const { hash } = await import("@node-rs/argon2");
    const { createAgent, authenticateAgent } = await import("../services/agent-auth");

    const { plainApiKey } = await createAgent({
      name: `rotated-${generateTestId()}`,
      scopes: ["mcp:connect"],
    });
    const ok = await authenticateAgent(plainApiKey);
    expect(ok.success).toBe(true);
    // Another secret in the same row (same public keyId)
    await db
      .update(agentApiKeys)
      .set({ keyHash: await hash("another-secret-different-from-the-remembered-one") })
      .where(eq(agentApiKeys.id, ok.context!.keyId));
    const after = await authenticateAgent(plainApiKey);
    expect(after.success).toBe(false);
    expect(after.code).toBe("INVALID_KEY");
  });
});
