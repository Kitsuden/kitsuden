/**
 * Narrowing an agent's tools for one run
 * ============================================================================
 *
 * Whoever runs an agent (a kon serving a chatbot, say) may give it fewer tools than it has, never more: the
 * result is always inside the agent's own `allowedTools`. Pure, so it is tested without a database or a model.
 */

import { inToolset, parseToolset } from "@/lib/mcp-settings";

/** An allowed-tools list that admits nothing: an empty list means "all tools" to the execution gate. */
export const NO_TOOLS = "<no tools>";

export interface Narrowing {
  /** Only these tools, of those the agent may use. */
  allowedTools?: string[];
  /** Only the tools of these toolsets: `kon:<id>` or `kon:<id>/<set>`. */
  toolset?: string;
}

interface NamedTool {
  function: { name: string };
}

/**
 * The tools the model is shown and the list the execution gate checks. Without narrowing, the agent's own list
 * (empty = all). With narrowing, the exact names left, or `[NO_TOOLS]` when none is left.
 */
export function narrowTools<T extends NamedTool>(
  tools: T[],
  agentAllowed: string[],
  narrowing: Narrowing
): { tools: T[]; allowedTools: string[] } {
  const narrowed = narrowing.allowedTools !== undefined || narrowing.toolset !== undefined;
  if (!narrowed) return { tools, allowedTools: agentAllowed };
  let out =
    agentAllowed.length > 0 ? tools.filter((t) => agentAllowed.includes(t.function.name)) : tools;
  if (narrowing.allowedTools) {
    const only = new Set(narrowing.allowedTools);
    out = out.filter((t) => only.has(t.function.name));
  }
  if (narrowing.toolset) {
    const parsed = parseToolset(narrowing.toolset);
    if (!parsed.ok) throw new Error(parsed.error);
    if (!parsed.toolset.all && parsed.toolset.fixedItems.size > 0) {
      throw new Error("A run narrows its tools only with kon:<id> or kon:<id>/<set>");
    }
    const set = parsed.toolset;
    out = out.filter((t) => {
      const name = t.function.name;
      const i = name.indexOf("__");
      return inToolset(set, {
        name,
        source: i > 0 ? "kon" : "core",
        kon: i > 0 ? name.slice(0, i) : null,
        readOnly: false,
      });
    });
  }
  return {
    tools: out,
    allowedTools: out.length > 0 ? out.map((t) => t.function.name) : [NO_TOOLS],
  };
}

/** A tool result that is a request held for a person's approval: its proposal id. */
export function approvalOf(result: string): { proposalId: string } | undefined {
  if (!result.includes("APPROVAL_REQUIRED")) return undefined;
  const id =
    /"proposal"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/.exec(result)?.[1] ??
    /proposal ([A-Za-z0-9_-]+)/.exec(result)?.[1];
  return id ? { proposalId: id } : undefined;
}
