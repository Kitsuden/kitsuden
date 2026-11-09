/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Agent Tools — Kitsuden Agents Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Combines dynamic MCP tools (defined by kons via @kitsuden/engine)
 * with Kitsuden's hardcoded MCP tools to expose them to the LLM.
 *
 * Used by Agent Engine for tool calling.
 */

// Deep import of the submodule (NOT the @kitsuden/engine facade): the facade
// re-exports modules from apps/api and this file takes part in the graph of
// agents — importing it closed the mega-cycle agent-handler → agent-engine →
// agent-tools → engine-index → ... → agent-handler.
import { executeMCPTool, listMCPTools } from "../../../../packages/engine/src/actions";
import { messageOf } from "../../../../packages/engine/src/errors";
import {
  DECISION_TOOL,
  DECISION_TOOL_DEFINITION,
  decisionView,
  parseDecision,
  recordDecision,
} from "../lib/agent-decisions";
import type { CustomerDataGuard } from "../lib/customer-data";

import { logToolCall } from "./agent-audit";
import type { LLMTool, LLMToolParameter } from "./llm/types";
import { listHardcodedMCPTools, executeHardcodedTool, assertToolScope } from "./mcp-tools";

export interface AgentToolContext {
  agentId: string;
  agentName: string;
  scopes?: string[];
  traceId?: string;
  keyId?: string;
  /** The agent's `allowedTools` list (empty = no list: the scope decides). */
  allowedTools?: string[];
  /** Nobody waits for this run (a cron or event action started it): lib/approvals.ts. */
  unattended?: boolean;
  /** Hold every write for human approval (see `McpAgent.holdWrites`). */
  holdWrites?: boolean;
  /**
   * The run's customer-data guard (lib/customer-data.ts): what the run read and
   * where it may go. External MCP tools check their arguments with it.
   */
  customerData?: CustomerDataGuard;
}

/**
 * Returns all the tools available to an agent.
 * If allowedTools is provided, filters to only those.
 */
export function getAgentTools(allowedTools?: string[]): LLMTool[] {
  const dynamicTools: LLMTool[] = listMCPTools().map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || `Tool: ${t.name}`,
      parameters: (t.inputSchema as LLMToolParameter) || { type: "object", properties: {} },
    },
  }));

  const hardcodedTools = listHardcodedMCPTools();
  // What it chose not to do (lib/agent-decisions.ts), as over MCP.
  const decisionTool: LLMTool = {
    type: "function",
    function: {
      name: DECISION_TOOL,
      description: DECISION_TOOL_DEFINITION.description,
      parameters: DECISION_TOOL_DEFINITION.inputSchema as unknown as LLMToolParameter,
    },
  };
  const allTools = [...dynamicTools, ...hardcodedTools, decisionTool];

  if (!allowedTools || allowedTools.length === 0) {
    return allTools;
  }

  return allTools.filter((tool) => allowedTools.includes(tool.function.name));
}

/**
 * `getAgentTools` plus the approved external MCP tools this agent has an
 * explicit `mcp-external:…` scope for (lib/external-mcp-bridge.ts).
 */
export async function listAgentTools(agent: {
  scopes?: string[];
  allowedTools?: string[];
}): Promise<LLMTool[]> {
  const allowed = agent.allowedTools ?? [];
  const tools = getAgentTools(allowed.length > 0 ? allowed : undefined);
  const { externalToolsFor, externalToolDefinition } = await import("../lib/external-mcp-bridge");
  const taken = new Set(tools.map((t) => t.function.name));
  for (const e of await externalToolsFor({ scopes: agent.scopes ?? [], allowedTools: allowed })) {
    if (taken.has(e.exposedName)) continue;
    const d = externalToolDefinition(e);
    tools.push({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: d.inputSchema as unknown as LLMToolParameter,
      },
    });
  }
  return tools;
}

/**
 * Runs a tool by name.
 * First looks in dynamic tools, then in hardcoded ones.
 */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  context: AgentToolContext
): Promise<string> {
  // ── The same gates as /api/mcp (security audit) ──
  // `getAgentTools(allowedTools)` only filtered what is SHOWN to the model; what
  // the model asked for (e.g. after a prompt injection) was run
  // all the same, and without going through human approval.
  const allowedOnes = context.allowedTools ?? [];
  if (allowedOnes.length > 0 && !allowedOnes.includes(name)) {
    throw new Error(`Tool '${name}' is not in this agent's allowed tools.`);
  }
  // Never held for approval and no quota: recording a choice changes nothing.
  if (name === DECISION_TOOL) {
    const row = await recordDecision(
      context.agentId,
      { ...parseDecision(args), traceId: context.traceId ?? null },
      "engine"
    );
    return JSON.stringify(decisionView(row));
  }
  // An external MCP tool: resolved (explicit scope) and checked against the
  // run's customer-data guard BEFORE it can be proposed or called.
  const isDynamicTool = listMCPTools().some((t) => t.name === name);
  const bridge = await import("../lib/external-mcp-bridge");
  let external: import("../lib/external-mcp-bridge").ExternalToolEntry | null = null;
  if (!isDynamicTool && bridge.isExternalToolName(name)) {
    const r = await bridge.resolveExternalTool(name, context.scopes ?? []);
    if (!r.ok) throw new Error(r.message);
    external = r.entry;
    const { egressProblem } = await import("../lib/customer-data");
    const { serverConnection } = await import("../lib/external-mcp");
    const server = context.customerData ? await serverConnection(external.serverId) : null;
    if (server && context.customerData) {
      const blocked = egressProblem(context.customerData, {
        url: server.url,
        hostname: new URL(server.url).hostname,
        body: JSON.stringify(args ?? {}),
      });
      if (blocked) {
        // Audited like the other channels (fields as labels, never values).
        context.customerData.onBlock?.({
          channel: "external_mcp",
          decision: "refused",
          ...blocked.block,
        });
        throw new Error(blocked.message);
      }
    }
  }
  // Deferred import: approvals-mcp pulls in the engine facade, and this
  // file cannot import it at the top (see the comment on the imports).
  const { holdToolIfNeeded } = await import("../lib/approvals-mcp");
  const held = await holdToolIfNeeded(name, args, {
    agentId: context.agentId,
    agentName: context.agentName,
    apiKeyId: context.keyId ?? "",
    scopes: context.scopes ?? [],
    allowedTools: allowedOnes,
    unattended: context.unattended === true,
    holdWrites: context.holdWrites === true,
  });
  if (held) return JSON.stringify(held.structuredContent ?? held);

  if (external) {
    // Fingerprint checked with the server again, output wrapped as untrusted.
    const result = await bridge.callExternalTool(external, args, {
      agentId: context.agentId,
      keyId: context.keyId,
      origin: "engine",
      customerData: context.customerData,
    });
    const text = result.content.map((c) => c.text).join("\n");
    if (result.isError) throw new Error(text);
    return text;
  }

  const dynamicTools = listMCPTools();
  const isDynamic = dynamicTools.find((t) => t.name === name);

  if (isDynamic) {
    // Dynamic tools inherit the base scope mcp:read or mcp:write depending on the kon.
    assertToolScope(name, context.scopes);
    const toolStart = Date.now();
    let success = true;
    let error: string | undefined;
    try {
      const result = await executeMCPTool(name, args, {
        agentId: context.agentId,
        agentName: context.agentName,
        scopes: context.scopes || [],
        preferToon: false,
        traceId: context.traceId,
      });
      return JSON.stringify(result);
    } catch (err: unknown) {
      success = false;
      error = messageOf(err, String(err));
      throw err;
    } finally {
      // The argument NAMES, never their values (they may carry personal
      // data or secrets): security audit.
      logToolCall(
        context.agentId,
        context.keyId || "unknown",
        name,
        Object.keys(args ?? {}).sort(),
        Date.now() - toolStart,
        success,
        error
      );
    }
  }

  assertToolScope(name, context.scopes);
  return executeHardcodedTool(name, args, {
    agentId: context.agentId,
    agentName: context.agentName,
    scopes: context.scopes || [],
    apiKeyId: context.keyId,
    // What the tool returns is tracked; the email tool checks what it sends.
    customerData: context.customerData,
  });
}
