/**
 * Tool actions (`agent.tool:*`) require their `meta.requiredScopes`
 * ============================================================================
 *
 * It was declared in ActionDefinition, but the engine's MCP adapter did not
 * look at it: any connected agent executed any tool action.
 */

import { describe, expect, it } from "vitest";

import { defineAction, executeMCPTool, missingScopes } from "../../packages/engine/src/actions";

describe("missingScopes", () => {
  it("same semantics as the API's hasScope", () => {
    expect(missingScopes(["crm:write"], ["crm:write"])).toEqual([]);
    expect(missingScopes(["crm:write"], ["crm:*"])).toEqual([]);
    expect(missingScopes(["crm:write"], ["*:write"])).toEqual([]);
    expect(missingScopes(["crm:write", "conta:read"], ["admin"])).toEqual([]);
    expect(missingScopes(["crm:write"], ["admin:*"])).toEqual([]);
    expect(missingScopes(["crm:write", "crm:read"], ["crm:read"])).toEqual(["crm:write"]);
    expect(missingScopes(["crm:write"], [])).toEqual(["crm:write"]);
    expect(missingScopes([], [])).toEqual([]);
  });
});

describe("executeMCPTool with requiredScopes", () => {
  const name = `test_scopes_${Date.now()}`;
  defineAction({
    trigger: `agent.tool:${name}`,
    description: "scopes test",
    meta: { requiredScopes: ["crm:write"] },
    run: async () => ({ success: true, data: { done: true } }),
  });

  it("without the scope: isError with KITSUDEN_E_FORBIDDEN and it is not executed", async () => {
    const r = await executeMCPTool(
      name,
      {},
      { agentId: "a", agentName: "a", scopes: ["mcp:read"] }
    );
    expect(r.isError).toBe(true);
    expect(r.code).toBe("KITSUDEN_E_FORBIDDEN");
    expect(r.content[0].text).toContain("crm:write");
  });

  it("without any scopes at all: it is denied (fails closed)", async () => {
    const r = await executeMCPTool(name, {}, {});
    expect(r.isError).toBe(true);
  });

  it("with the scope (or a wildcard that covers it): it is executed", async () => {
    for (const scopes of [["crm:write"], ["crm:*"], ["admin"]]) {
      const r = await executeMCPTool(name, {}, { agentId: "a", agentName: "a", scopes });
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content[0].text)).toEqual({ done: true });
    }
  });
});
