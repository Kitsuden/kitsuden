/**
 * Agent Scope-Escalation Adversarial Tests
 * ============================================================================
 *
 * ADR-002 promises that "the agent's scopes are translated into permissions and neither
 * a badly generated query nor prompt injection can escalate privileges". The control
 * point of that promise is `hasScope()` (services/agent-auth.ts).
 *
 * This suite attacks the scope logic looking for PRIVILEGE ESCALATION:
 *   - An agent with `read:*` must not be able to WRITE.
 *   - An agent with `*:posts` must not touch other resources.
 *   - Colliding prefixes (`read:` vs `readonly:`) must not open the door.
 *   - Empty scopes deny everything.
 *   - `admin` / `admin:*` are the only super-scope (intentional escape hatch).
 *
 * These are pure tests (no DB): they always run, in any environment.
 */

import { describe, it, expect } from "bun:test";

import { hasScope, hasAllScopes, hasAnyScope } from "../services/agent-auth";
import type { AgentAuthContext } from "../services/agent-auth";

/** Builds a minimal agent context with the given scopes. */
function agent(scopes: string[]): AgentAuthContext {
  return {
    agentId: "agent-test",
    agentName: "Test Agent",
    scopes,
    rateLimit: 1000,
    writesPerDay: null,
    budgetUnitsPerDay: null,
    keyId: "key-test",
    allowedTools: [],
  };
}

describe("Agent Scope Escalation — Zero Trust", () => {
  // ── Exact match ───────────────────────────────────────────────────────────

  describe("Exact match", () => {
    it("grants exactly the scope granted", () => {
      expect(hasScope(agent(["read:posts"]), "read:posts")).toBe(true);
    });

    it("denies a different action on the same resource (no vertical escalation)", () => {
      const a = agent(["read:posts"]);
      expect(hasScope(a, "write:posts")).toBe(false);
      expect(hasScope(a, "delete:posts")).toBe(false);
      expect(hasScope(a, "update:posts")).toBe(false);
    });

    it("denies the same verb on another resource (no horizontal escalation)", () => {
      const a = agent(["read:posts"]);
      expect(hasScope(a, "read:secrets")).toBe(false);
      expect(hasScope(a, "read:users")).toBe(false);
    });
  });

  // ── Resource wildcard (verb:*) ────────────────────────────────────────────

  describe("Resource wildcard (read:*)", () => {
    const a = agent(["read:*"]);

    it("grants reading of any resource", () => {
      expect(hasScope(a, "read:posts")).toBe(true);
      expect(hasScope(a, "read:users")).toBe(true);
      expect(hasScope(a, "read:secrets")).toBe(true);
    });

    it("does NOT grant writing of any resource (verb boundary intact)", () => {
      expect(hasScope(a, "write:posts")).toBe(false);
      expect(hasScope(a, "delete:users")).toBe(false);
      expect(hasScope(a, "admin:system")).toBe(false);
    });

    it("does NOT suffer prefix collision: 'read:*' does not grant 'readonly:secrets'", () => {
      // The derived prefix is 'read:'. 'readonly:secrets' does NOT start with 'read:'
      // (the char at the ':' position is 'o'), so it must be denied.
      expect(hasScope(a, "readonly:secrets")).toBe(false);
      expect(hasScope(a, "readwrite:posts")).toBe(false);
    });

    it("does NOT grant a malformed scope with no resource ('read' with no colon)", () => {
      expect(hasScope(a, "read")).toBe(false);
    });
  });

  // ── Action wildcard (*:resource) ──────────────────────────────────────────

  describe("Action wildcard (*:database)", () => {
    const a = agent(["*:database"]);

    it("grants any verb on the exact resource", () => {
      expect(hasScope(a, "read:database")).toBe(true);
      expect(hasScope(a, "write:database")).toBe(true);
      expect(hasScope(a, "delete:database")).toBe(true);
    });

    it("does NOT grant access to other resources even if the suffix looks similar", () => {
      expect(hasScope(a, "read:mydatabase")).toBe(false);
      expect(hasScope(a, "read:database_admin")).toBe(false);
      expect(hasScope(a, "read:posts")).toBe(false);
    });
  });

  // ── Admin super-scope (intentional escape hatch) ──────────────────────────

  describe("Super-scope admin", () => {
    it("'admin:*' grants absolutely everything", () => {
      const a = agent(["admin:*"]);
      expect(hasScope(a, "read:posts")).toBe(true);
      expect(hasScope(a, "write:secrets")).toBe(true);
      expect(hasScope(a, "delete:everything")).toBe(true);
    });

    it("'admin' (bare) also grants everything", () => {
      const a = agent(["admin"]);
      expect(hasScope(a, "write:anything")).toBe(true);
    });
  });

  // ── Deny by default ───────────────────────────────────────────────────────

  describe("Deny by default", () => {
    it("an agent with no scopes can do nothing", () => {
      const a = agent([]);
      expect(hasScope(a, "read:posts")).toBe(false);
      expect(hasScope(a, "write:posts")).toBe(false);
    });

    it("irrelevant scopes do not grant the required scope", () => {
      const a = agent(["mcp:connect", "read:games"]);
      expect(hasScope(a, "write:users")).toBe(false);
      expect(hasScope(a, "delete:database")).toBe(false);
    });

    it("a context with scopes = undefined is treated as having no permissions", () => {
      const a = { ...agent([]), scopes: undefined as unknown as string[] };
      expect(hasScope(a, "read:posts")).toBe(false);
    });
  });

  // ── Combinators hasAllScopes / hasAnyScope ────────────────────────────────

  describe("hasAllScopes (AND)", () => {
    it("requires ALL the scopes", () => {
      const a = agent(["read:posts", "write:posts"]);
      expect(hasAllScopes(a, ["read:posts", "write:posts"])).toBe(true);
      expect(hasAllScopes(a, ["read:posts", "delete:posts"])).toBe(false);
    });

    it("a wildcard covers multiple required scopes of the same verb", () => {
      const a = agent(["read:*"]);
      expect(hasAllScopes(a, ["read:posts", "read:users"])).toBe(true);
      expect(hasAllScopes(a, ["read:posts", "write:users"])).toBe(false);
    });
  });

  describe("hasAnyScope (OR)", () => {
    it("one is enough", () => {
      const a = agent(["read:posts"]);
      expect(hasAnyScope(a, ["read:posts", "write:posts"])).toBe(true);
      expect(hasAnyScope(a, ["write:posts", "delete:posts"])).toBe(false);
    });

    it("an agent with no scopes fails any OR", () => {
      expect(hasAnyScope(agent([]), ["read:posts", "write:posts"])).toBe(false);
    });
  });
});
