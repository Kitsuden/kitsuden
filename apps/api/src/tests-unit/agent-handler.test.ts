import { describe, it, expect, mock, beforeAll } from "bun:test";

import type { Action, ActionContext } from "../lib/actions/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let executeAgentAction: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runAgentCalls: any[] = [];
let shouldFail = false;

beforeAll(async () => {
  // Mock of the Agent Engine (FULL export surface to avoid
  // "Export named X not found" in other files — mock.module leaks
  // between tests in the same bun process).
  mock.module("@/services/agent-engine", () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runAgent: async (options: any) => {
      runAgentCalls.push(options);
      if (shouldFail) throw new Error("LLM provider unavailable");
      return {
        response: "Task completed",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        tokensIn: 100,
        tokensOut: 50,
        traceId: "trace-1",
        sessionId: "session-1",
      };
    },
  }));

  const mod = await import("../lib/actions/handlers/agent-handler");
  executeAgentAction = mod.executeAgentAction;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baseAction = (config: any): Action =>
  ({
    id: "act-1",
    name: "Test Agent Action",
    type: "agent",
    trigger: "manual",
    enabled: true,
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const baseContext: ActionContext = {
  actionId: "act-1",
  actionName: "Test",
  actionType: "agent",
  trigger: "manual",
  env: {},
  executionId: "exec-1",
  startedAt: new Date(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// Who answers (security review 2026-11-04): a current admin, without touching the database.
const adminAccountable = {
  userRole: async () => "admin",
  agentScopes: async () => ["admin"],
};
const asAdmin = {
  ...baseContext,
  executor: { type: "human", userId: "u-admin" },
} as unknown as ActionContext;

describe("executeAgentAction", () => {
  it("returns error when no agentId configured", async () => {
    const result = await executeAgentAction(baseAction({}), baseContext);
    expect(result.success).toBe(false);
    expect(result.error).toBe("No agent configured for this action");
    expect(result.durationMs).toBeDefined();
  });

  it("runs the agent via Agent Engine and maps the result", async () => {
    runAgentCalls = [];
    shouldFail = false;

    const result = await executeAgentAction(
      baseAction({ agentId: "agent-1", promptTemplate: "Hello" }),
      asAdmin,
      adminAccountable
    );

    expect(result.success).toBe(true);
    expect(result.result.response).toBe("Task completed");
    expect(result.result.provider).toBe("anthropic");
    expect(result.result.tokensIn).toBe(100);
    expect(result.result.traceId).toBe("trace-1");
    expect(result.durationMs).toBeDefined();

    expect(runAgentCalls.length).toBe(1);
    expect(runAgentCalls[0].agentId).toBe("agent-1");
    expect(runAgentCalls[0].message).toBe("Hello");
    // Defaults: memory and brain search enabled unless explicitly opted out
    expect(runAgentCalls[0].enableMemory).toBe(true);
    expect(runAgentCalls[0].enableBrainSearch).toBe(true);
  });

  it("renders {{variables}} from the context in the promptTemplate", async () => {
    runAgentCalls = [];
    shouldFail = false;

    const context = {
      ...asAdmin,
      event: { data: { user: { name: "Arqui" }, issue: "BUG-42" } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await executeAgentAction(
      baseAction({ agentId: "agent-1", promptTemplate: "Review {{issue}} from {{user.name}}" }),
      context,
      adminAccountable
    );

    // Event values are fenced as untrusted data, and the writes are held
    expect(runAgentCalls[0].message).toEndWith(
      "Review <untrusted-content>BUG-42</untrusted-content> from <untrusted-content>Arqui</untrusted-content>"
    );
    expect(runAgentCalls[0].holdWrites).toBe(true);
  });

  it("respects memory and brain search opt-out", async () => {
    runAgentCalls = [];
    shouldFail = false;

    await executeAgentAction(
      baseAction({ agentId: "agent-1", enableMemory: false, enableBrainSearch: false }),
      asAdmin,
      adminAccountable
    );

    expect(runAgentCalls[0].enableMemory).toBe(false);
    expect(runAgentCalls[0].enableBrainSearch).toBe(false);
  });

  it("maps Agent Engine errors to ActionResult", async () => {
    shouldFail = true;

    const result = await executeAgentAction(
      baseAction({ agentId: "agent-1" }),
      asAdmin,
      adminAccountable
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("LLM provider unavailable");
    expect(result.durationMs).toBeDefined();

    shouldFail = false;
  });

  it("without a caller or a creator (e.g. an event, defined over MCP): does not run", async () => {
    runAgentCalls = [];
    const result = await executeAgentAction(
      baseAction({ agentId: "agent-1" }),
      baseContext,
      adminAccountable
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("needs a creator");
    expect(runAgentCalls.length).toBe(0);
  });

  it("an agent without the target's scopes: does not run", async () => {
    runAgentCalls = [];
    const asAgent = {
      ...baseContext,
      executor: { type: "agent", agent: { agentId: "ag-a", scopes: ["mcp:admin"] } },
    } as unknown as ActionContext;
    const result = await executeAgentAction(
      baseAction({ agentId: "agent-1" }),
      asAgent,
      adminAccountable
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("more permissions");
    expect(runAgentCalls.length).toBe(0);
  });
});
