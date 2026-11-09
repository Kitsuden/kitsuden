/**
 * An action's code only changes through promotion (owner
 * decision 2, 2026-10-28)
 * ============================================================================
 *
 * An AGENT (any agent identity, even with the `admin` scope) does not
 * change an action's code by any path other than code promotion
 * (`POST /api/promotion/drafts`, MCP `promotion_propose`). Not
 * `/api/actions`, nor `/api/functions`, nor the MCP tool
 * `kitsuden_define_action`, nor the generic grids.
 *
 * A PERSON (admin) still edits by hand through `/api/actions`, and every
 * code edit is recorded as a `manual` version in `code_versions`
 * (lib/promotion.ts, `registerManualEdit`). For that to hold, the
 * generic grids (`/api/items`, the explorer, GraphQL, the table MCP
 * tools) write NONE of the tables in `TABLES_ONLY_BY_THEIR_ROUTE`,
 * with any role: each has its own route, with its version and its audit.
 *
 * No dependencies on the rest of the API on purpose: the generic routes
 * and the MCP tools import it without dragging in cycles.
 */

import { buildProblem, type ProblemDetails } from "@kitsuden/shared";

/** The part of `config` that IS the code (what promotion versions). The rest is configuration. */
export const CODE_KEYS = [
  "code",
  "scopes",
  "fetchAllow",
  "timeoutMs",
  "memoryLimitMb",
  "maxCalls",
  "tests",
  "promotion",
] as const;

/**
 * Where an action may send customer data (docs/agents/egress.md). Only a PERSON
 * sets these keys, on any action type: an agent that could add its own host here
 * would carry out exactly what the limit is meant to stop.
 */
export const CUSTOMER_DATA_KEYS = ["customerDataHosts", "customerData"] as const;

/** Does `after` change where customer data may go, relative to `before`? */
export function changesCustomerDataPolicy(before: unknown, after: unknown): boolean {
  const a = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const d = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  return CUSTOMER_DATA_KEYS.some((k) => canon(a[k]) !== canon(d[k]));
}

export const CUSTOMER_DATA_HOSTS_MESSAGE =
  "Agents cannot set where an action may send customer data (customerDataHosts, customerData): a person does that in the panel or through /api/actions. See docs/agents/egress.md.";

/** The problem+json 403 for an agent touching `customerDataHosts`. */
export function customerDataPolicyProblem(
  instance: string,
  requestId?: string | null
): ProblemDetails {
  return buildProblem({
    code: "KITSUDEN_E_FORBIDDEN",
    detail: CUSTOMER_DATA_HOSTS_MESSAGE,
    instance,
    requestId,
    extensions: { reason: "customer_data_hosts_by_humans" },
  });
}

/**
 * Tables that no generic path writes: the code of actions and their
 * history, their executions (a new version's monitoring lives off them)
 * and the approvals configuration (the turbo cap).
 */
export const TABLES_ONLY_VIA_THEIR_ROUTE: ReadonlySet<string> = new Set([
  "actions",
  "kitsuden_functions",
  "code_versions",
  "action_executions",
  "function_executions",
  "approval_settings",
  // Who an agent is and what it may do, and what a human reviews before approving:
  // `PATCH /api/items/agentIdentities/<self>` turned approvals off for that agent,
  // and a pending proposal could be rewritten after its review.
  "agent_identities",
  "agent_proposals",
  "agent_proposal_files",
  "agent_audit_logs",
  // External MCP servers and the fingerprints a person approved (lib/external-mcp.ts):
  // a generic write could approve a changed tool or point a server elsewhere.
  "external_mcp_servers",
  "external_mcp_tools",
]);

function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(",")}}`;
}

/** Does `after` change the code relative to `before`? (full `config` of the action) */
export function changesCode(before: unknown, after: unknown): boolean {
  const a = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const d = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  return CODE_KEYS.some((k) => canon(a[k]) !== canon(d[k]));
}

/**
 * When and whether a code action runs. As decisive as the code itself: a code
 * action runs as its synthetic identity, with the scopes its code declares, so
 * the agent that may not touch the code may not decide when it fires either
 * (a cron every minute, an event on someone else's dataset, `active` again
 * after a human paused it). Security review 2026-11-03.
 */
export const SCHEDULE_KEYS = ["trigger", "triggerConfig", "status"] as const;

/** Does `patch` change any of `SCHEDULE_KEYS` relative to `before`? (absent = unchanged) */
export function changesSchedule(
  before: Record<string, unknown>,
  patch: Record<string, unknown>
): boolean {
  return SCHEDULE_KEYS.some((k) => patch[k] !== undefined && canon(patch[k]) !== canon(before[k]));
}

/** Does this `config` carry any code? (for creation) */
export function bringsCode(config: unknown): boolean {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return CODE_KEYS.some((k) => c[k] !== undefined && c[k] !== null);
}

export const PROMOTION_ONLY_MESSAGE =
  "Agents cannot create or change an action's code outside the code promotion pipeline. Submit a draft with tests instead: MCP tool promotion_propose, or POST /api/promotion/drafts (see docs/agents/promotion.md).";

/** The problem+json 403 for an agent trying to change code by another path. */
export function codeOutsidePromotionProblem(
  instance: string,
  requestId?: string | null
): ProblemDetails {
  return buildProblem({
    code: "KITSUDEN_E_FORBIDDEN",
    detail: PROMOTION_ONLY_MESSAGE,
    instance,
    requestId,
    hint: "Use promotion_propose (POST /api/promotion/drafts). A human approves it, or turbo mode activates it when nothing widens permissions.",
    extensions: {
      reason: "use_promotion_pipeline",
      tool: "promotion_propose",
      route: "POST /api/promotion/drafts",
    },
  });
}

export const SCHEDULE_HUMAN_ONLY_MESSAGE =
  "Agents cannot change when a code action runs (trigger, triggerConfig, status): it runs as its own identity with the scopes its code declares, so that is decided with the code. Change the code through the code promotion pipeline (MCP tool promotion_propose, or POST /api/promotion/drafts); its trigger and status are set by a human (see docs/agents/promotion.md).";

/** The problem+json 403 for an agent changing a code action's trigger or status. */
export function scheduleOutsidePromotionProblem(
  instance: string,
  requestId?: string | null
): ProblemDetails {
  return buildProblem({
    code: "KITSUDEN_E_FORBIDDEN",
    detail: SCHEDULE_HUMAN_ONLY_MESSAGE,
    instance,
    requestId,
    hint: "Ask a human to set the trigger. Code changes go through promotion_propose (POST /api/promotion/drafts).",
    extensions: {
      reason: "code_action_schedule_human_only",
      keys: [...SCHEDULE_KEYS],
      tool: "promotion_propose",
      route: "POST /api/promotion/drafts",
    },
  });
}

/** The problem+json 403 of a generic grid over a table with its own route. */
export function tableProblemOnlyByItsRoute(
  table: string,
  instance: string,
  requestId?: string | null
): ProblemDetails {
  return buildProblem({
    code: "KITSUDEN_E_FORBIDDEN",
    detail: `'${table}' is not written through generic routes. Use its own route: actions through /api/actions (humans) or the code promotion pipeline (agents: promotion_propose); approval settings and proposals through /api/approvals; agents through /api/admin/agents.`,
    instance,
    requestId,
    extensions: { reason: "table_has_its_own_route", table, tool: "promotion_propose" },
  });
}

/** What the MCP tools throw: `status` 403 → KITSUDEN_E_FORBIDDEN (lib/problems-mcp.ts). */
export class CodeOutsidePromotion extends Error {
  readonly status = 403;
  constructor(message = PROMOTION_ONLY_MESSAGE) {
    super(message);
    this.name = "CodeOutsidePromotion";
  }
}

/** Answers a problem+json with Hono without depending on its context type. */
export function respondProblem(
  c: { body: (b: string, s: never, h: Record<string, string>) => Response },
  p: ProblemDetails,
  status = 403
): Response {
  return c.body(JSON.stringify(p), status as never, { "Content-Type": "application/problem+json" });
}
