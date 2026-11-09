/**
 * MCP settings of an agent: toolsets and wrapping of
 * untrusted content
 * ============================================================================
 *
 * Stored in `agent_identities.mcp_settings` (migration 0052) and edited by the
 * panel (`PUT /api/v1/agents/:id/mcp-settings`). `{}` = as always.
 *
 * ── TOOLSETS ───────────────────────────────────────────────────────────────
 *
 * A toolset NARROWS what `tools/list` advertises and what `tools/call` accepts.
 * It never widens: the tool must also pass `allowedTools` and the
 * usual scope. It is chosen on connect (`GET /api/mcp?toolset=read,kon:blog`)
 * or as the agent's preset in the panel; with both, the INTERSECTION applies (the
 * URL can only narrow the preset, not go outside it).
 *
 *   all        no restriction (as before)
 *   read       read-only: core tools with `mcp:read`,
 *              GET operations of the kons and the proposals query
 *   data       the core's datasets and collections tools (read and write rows)
 *   core       all the core's `kitsuden_*`
 *   actions    the engine's actions (`define_action`)
 *   kons       all kons SDK operations
 *   kon:<id>   the operations of ONE kon (`kon:blog`, `kon:crm`…)
 *   external   approved tools of external MCP servers (`ext_*`,
 *              lib/external-mcp-bridge.ts); never in `read`: they count as writes
 *   kon:<id>/<set>  a group the kon itself declares (`mcpToolsets` in its definition): `kon:crm/sales`.
 *              Only the kon knows which of its operations go together, and a model chooses
 *              worse among a hundred tools than among ten.
 *
 * Several separated by commas = union. `kitsuden_proposal_status` is in all of them:
 * it only reads the agent's own proposals and without it an agent in
 * "propose" mode cannot know what happened to what it proposed.
 *
 * ── WRAPPING ───────────────────────────────────────────────────────────────
 *
 * `untrustedWrap`: `none` (default), `delimiters` or `object`. See
 * lib/provenance.ts and docs/agents/untrusted-content.md.
 */

import { z } from "zod";

export const WRAPPER_MODES = ["none", "delimiters", "object"] as const;
export type WrapperMode = (typeof WRAPPER_MODES)[number];

export const FIXED_TOOLSETS = [
  "all",
  "read",
  "data",
  "core",
  "actions",
  "kons",
  "external",
] as const;
type FixedToolset = (typeof FIXED_TOOLSETS)[number];

/** A toolset element: a fixed one (`external` included), `kon:<id>` or `kon:<id>/<set>`. */
const ELEMENT =
  /^(all|read|data|core|actions|kons|external|kon:[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})?)$/;

/** The groups each mounted kon declares: short kon id → set name → operation ids. Filled by the module loader. */
const konToolsets = new Map<string, Map<string, Set<string>>>();

const shortKon = (id: string) => id.replace(/^kon-/, "");

/** Called once per kon when it is mounted. A set naming no operation is dropped. */
export function registerKonToolsets(
  konId: string,
  sets: Record<string, string[]> | undefined
): void {
  const kon = shortKon(konId);
  if (!sets) {
    konToolsets.delete(kon);
    return;
  }
  const map = new Map<string, Set<string>>();
  for (const [name, ops] of Object.entries(sets)) {
    if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) && Array.isArray(ops) && ops.length > 0)
      map.set(name, new Set(ops));
  }
  konToolsets.set(kon, map);
}

/** The set names a kon declares, for error messages and the panel. */
export function konToolsetNames(konId: string): string[] {
  return [...(konToolsets.get(shortKon(konId))?.keys() ?? [])];
}

/** `crm__list-deals` → `list-deals`: the operation id inside a kon tool's name. */
function operationOf(toolName: string): string {
  const i = toolName.indexOf("__");
  return i >= 0 ? toolName.slice(i + 2) : toolName;
}

export interface McpSettings {
  toolset?: string;
  untrustedWrap?: WrapperMode;
}

export const McpSettingsSchema = z
  .object({
    toolset: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe(
        "Default toolset for this agent's MCP sessions (comma-separated). null = all tools."
      ),
    untrustedWrap: z
      .enum(WRAPPER_MODES)
      .optional()
      .describe("How text written by others is wrapped in tool results. Default: none."),
  })
  .strict();

/** Reads `mcp_settings` from the database without trusting its shape (it is jsonb). */
export function readMcpSettings(raw: unknown): McpSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const output: McpSettings = {};
  if (typeof o.toolset === "string" && parseToolset(o.toolset).ok) output.toolset = o.toolset;
  if (
    typeof o.untrustedWrap === "string" &&
    (WRAPPER_MODES as readonly string[]).includes(o.untrustedWrap)
  ) {
    output.untrustedWrap = o.untrustedWrap as WrapperMode;
  }
  return output;
}

export type Toolset =
  | { all: true }
  | { all: false; fixedItems: Set<FixedToolset>; kons: Set<string>; konSets?: Set<string> };

/**
 * `"read,kon:blog"` → the set. Empty or `all` = no restriction. An
 * unknown element is an error (better a 400 on connect than a whole list
 * silently, or an empty one with no idea why).
 */
export function parseToolset(
  text: string | null | undefined
): { ok: true; toolset: Toolset } | { ok: false; error: string } {
  const parts = (text ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return { ok: true, toolset: { all: true } };
  const fixedItems = new Set<FixedToolset>();
  const kons = new Set<string>();
  const konSets = new Set<string>();
  for (const p of parts) {
    if (!ELEMENT.test(p)) {
      return {
        ok: false,
        error: `Unknown toolset '${p.slice(0, 80)}'. Valid: ${FIXED_TOOLSETS.join(", ")}, kon:<id>, kon:<id>/<set> (comma-separated).`,
      };
    }
    if (p === "all") return { ok: true, toolset: { all: true } };
    if (p.startsWith("kon:")) {
      const [kon, set] = p.slice(4).split("/") as [string, string | undefined];
      if (!set) {
        kons.add(shortKon(kon));
        continue;
      }
      // A mounted kon that does not declare the set is a typo: better a 400 than an empty list.
      const declared = konToolsets.get(shortKon(kon));
      if (declared && !declared.has(set)) {
        const names = [...declared.keys()];
        return {
          ok: false,
          error: `kon:${shortKon(kon)} has no toolset '${set}'. Its toolsets: ${names.length ? names.join(", ") : "none"}.`,
        };
      }
      konSets.add(`${shortKon(kon)}/${set}`);
    } else fixedItems.add(p as FixedToolset);
  }
  return { ok: true, toolset: { all: false, fixedItems, kons, konSets } };
}

/** What needs to be known about a tool to place it in the toolsets. */
export interface ToolCard {
  name: string;
  source: "core" | "action" | "kon" | "proposals" | "external";
  /** Short name of the kon (`blog`) if it is an SDK operation. */
  kon?: string | null;
  /** Read-only? */
  readOnly: boolean;
  /** Is it a core datasets/collections tool? */
  isDataTool?: boolean;
}

function inOne(f: ToolCard, t: FixedToolset): boolean {
  switch (t) {
    case "all":
      return true;
    case "read":
      return f.readOnly;
    case "data":
      return f.source === "core" && Boolean(f.isDataTool);
    case "core":
      return f.source === "core";
    case "actions":
      return f.source === "action";
    case "kons":
      return f.source === "kon";
    case "external":
      return f.source === "external";
  }
}

/** Is the tool in the toolset? */
export function inToolset(t: Toolset, f: ToolCard): boolean {
  if (t.all || f.source === "proposals") return true;
  for (const fixed of t.fixedItems) if (inOne(f, fixed)) return true;
  if (f.source !== "kon" || !f.kon) return false;
  if (t.kons.has(f.kon)) return true;
  for (const pair of t.konSets ?? []) {
    const [kon, set] = pair.split("/") as [string, string];
    if (kon === f.kon && konToolsets.get(kon)?.get(set)?.has(operationOf(f.name))) return true;
  }
  return false;
}

/** Is it in ALL the toolsets of the list? (agent preset ∩ the URL's) */
export function inAll(toolsets: readonly Toolset[], f: ToolCard): boolean {
  return toolsets.every((t) => inToolset(t, f));
}

/** Canonical text of a toolset (for logs and for the `initialize` response). */
export function toolsetText(t: Toolset): string {
  if (t.all) return "all";
  return [
    ...t.fixedItems,
    ...[...t.kons].map((k) => `kon:${k}`),
    ...[...(t.konSets ?? [])].map((k) => `kon:${k}`),
  ].join(",");
}
