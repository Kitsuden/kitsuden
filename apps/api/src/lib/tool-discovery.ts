/**
 * Tool discovery and result caps — what keeps an MCP session's context small
 * ============================================================================
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 *
 * The client puts every tool definition `tools/list` returns into the model's
 * context on EVERY turn. With all kons on, an admin agent saw 661 tools ≈ 188k
 * tokens (docs/agents/toolsets.md). Toolsets fix that, but only for an agent
 * someone configured: the default was "everything".
 *
 * ── DISCOVERY MODE ──────────────────────────────────────────────────────────
 *
 * When the session chose NO toolset (neither the agent's preset nor
 * `?toolset=`) and the definitions it may see exceed `MCP_TOOLS_LIST_MAX_BYTES`
 * (default 64 000 bytes ≈ 16k tokens; `0` turns the mode off), `tools/list`
 * returns two tools instead:
 *
 *   kitsuden_find_tools   search the tools this session may call, by words;
 *                         without a query, how many there are per group
 *   kitsuden_call_tool    call one of them by name
 *
 * plus the approval tools, which every toolset carries. An installation small
 * enough to fit the budget sees the full list as before, and `?toolset=all`
 * (or the preset `all`) always gets the full list.
 *
 * Nothing is granted here: `kitsuden_call_tool` runs the inner tool through the
 * same `executeTool` path (allowed tools, toolsets, scopes, quota, approval,
 * audit under the inner tool's name), so it can reach exactly what the full
 * list would have shown.
 *
 * ── RESULT CAP ──────────────────────────────────────────────────────────────
 *
 * A tool result over `MCP_RESULT_MAX_CHARS` (default 100 000 characters ≈ 25k
 * tokens; `0` turns it off) is cut, says so in its text and in
 * `_meta["kitsuden/truncated"]`, and loses `structuredContent` (a client may
 * feed that to the model too). One unfiltered query should not fill a context.
 */

export const FIND_TOOL = "kitsuden_find_tools";
export const CALL_TOOL = "kitsuden_call_tool";
export const META_TOOLS = "kitsuden/tools";
export const META_TRUNCATED = "kitsuden/truncated";

const DEFAULT_LIST_BUDGET = 64_000;
const DEFAULT_RESULT_MAX = 100_000;
const MAX_FIND_RESULTS = 20;

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Bytes of `tools/list` definitions beyond which discovery mode starts (`0` = never). */
export function listBudgetBytes(): number {
  return envNumber("MCP_TOOLS_LIST_MAX_BYTES", DEFAULT_LIST_BUDGET);
}

/** Characters of a tool result beyond which it is cut (`0` = never). */
export function resultMaxChars(): number {
  return envNumber("MCP_RESULT_MAX_CHARS", DEFAULT_RESULT_MAX);
}

/** Serialized size of the definitions, as the client receives them. */
export function definitionBytes(tools: readonly ToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify(tools), "utf8");
}

/** Should `tools/list` answer with the discovery tools instead of the full list? */
export function useDiscovery(
  tools: readonly ToolDefinition[],
  budget = listBudgetBytes()
): boolean {
  return budget > 0 && definitionBytes(tools) > budget;
}

/** Same order on every call for the same set: clients can cache the prefix. */
export function stableOrder<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const FIND_TOOL_DEFINITION: ToolDefinition = {
  name: FIND_TOOL,
  description:
    "Search the tools you can call on this Kitsuden. With `query` (words such as 'blog post create' or 'tournament report'), returns the best matches with their input schemas; call one with kitsuden_call_tool. Without `query`, returns how many tools each group has (core, kon:<id>, actions, external) with example names.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to match against tool names and descriptions." },
      group: {
        type: "string",
        description: "Only this group, e.g. 'core' or 'kon:blog' (from a call without query).",
      },
      limit: {
        type: "number",
        default: 8,
        description: `Max tools returned (max ${MAX_FIND_RESULTS}).`,
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export const CALL_TOOL_DEFINITION: ToolDefinition = {
  name: CALL_TOOL,
  description:
    "Call a tool found with kitsuden_find_tools, by its exact name. `arguments` must match that tool's input schema. Permissions, quotas and human approval apply exactly as if you had called the tool directly.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool name from kitsuden_find_tools." },
      arguments: { type: "object", description: "The tool's arguments." },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

/** Is this one of the two discovery tools? */
export function isDiscoveryTool(name: string): boolean {
  return name === FIND_TOOL || name === CALL_TOOL;
}

/** The group a tool belongs to, for the overview and the `group` filter. */
export function toolGroup(name: string): string {
  const kon = name.indexOf("__");
  if (kon > 0) return `kon:${name.slice(0, kon)}`;
  if (name.startsWith("kitsuden_")) return "core";
  if (name.startsWith("ext_")) return "external";
  return "actions";
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/**
 * The best matches for `query`: a word in the name weighs three times one in
 * the description. Ties go by name, so the answer is stable.
 */
export function searchTools(
  tools: readonly ToolDefinition[],
  query: string,
  limit = 8
): ToolDefinition[] {
  const asked = [...new Set(words(query))];
  if (asked.length === 0) return [];
  const max = Math.min(Math.max(1, Math.floor(limit) || 8), MAX_FIND_RESULTS);
  return tools
    .map((t) => {
      const name = words(`${t.name} ${t.title ?? ""}`);
      const text = words(t.description ?? "");
      let score = 0;
      for (const w of asked) {
        if (name.some((n) => n.startsWith(w))) score += 3;
        if (text.some((n) => n.startsWith(w))) score += 1;
      }
      return { t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.t.name < b.t.name ? -1 : 1))
    .slice(0, max)
    .map((s) => s.t);
}

/** How many tools each group has, with a few names each: the cheapest map of the server. */
export function toolOverview(tools: readonly ToolDefinition[]): {
  total: number;
  groups: { group: string; count: number; examples: string[] }[];
} {
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    const g = toolGroup(t.name);
    const list = groups.get(g) ?? [];
    list.push(t.name);
    groups.set(g, list);
  }
  return {
    total: tools.length,
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([group, names]) => ({
        group,
        count: names.length,
        examples: names.sort().slice(0, 4),
      })),
  };
}

interface ToolResponse {
  result?: {
    content?: { type?: string; text?: string }[];
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Cuts a `tools/call` response whose text is longer than `max` characters.
 * The response is returned as it came when it fits (or is not a tool result).
 */
export function capToolResult<T>(response: T, max = resultMaxChars()): T {
  const r = response as ToolResponse | null;
  const content = r?.result?.content;
  if (!max || !Array.isArray(content)) return response;
  const total = content.reduce((n, c) => n + (typeof c?.text === "string" ? c.text.length : 0), 0);
  if (total <= max) return response;

  let left = max;
  const cut = content.map((c) => {
    if (typeof c?.text !== "string") return c;
    const text = c.text.slice(0, Math.max(0, left));
    left -= text.length;
    return { ...c, text };
  });
  cut.push({
    type: "text",
    text: `[Result truncated: ${max} of ${total} characters shown. Ask for less: a smaller limit with offset, fields, or a narrower filter.]`,
  });
  const { structuredContent: _dropped, ...rest } = r!.result!;
  return {
    ...r,
    result: {
      ...rest,
      content: cut,
      _meta: { ...(rest._meta ?? {}), [META_TRUNCATED]: { shownChars: max, totalChars: total } },
    },
  } as T;
}

/**
 * Keeps only `fields` of each row. A key is read from the row itself, else from
 * its `data` object (dataset entries keep their fields there). `id` always stays,
 * so provenance and follow-up calls still work.
 */
export function projectFields(
  rows: readonly unknown[],
  fields: readonly string[] | undefined
): unknown[] {
  if (!fields || fields.length === 0) return [...rows];
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const source = row as Record<string, unknown>;
    const data =
      source.data && typeof source.data === "object" && !Array.isArray(source.data)
        ? (source.data as Record<string, unknown>)
        : undefined;
    const out: Record<string, unknown> = {};
    if ("id" in source) out.id = source.id;
    for (const f of fields) {
      if (f === "id" || f === "__proto__" || f === "constructor" || f === "prototype") continue;
      if (Object.prototype.hasOwnProperty.call(source, f)) out[f] = source[f];
      else if (data && Object.prototype.hasOwnProperty.call(data, f)) out[f] = data[f];
    }
    return out;
  });
}
