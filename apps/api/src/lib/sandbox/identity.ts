/**
 * What identity the code of an action uses to call the API
 * ============================================================================
 *
 * The sandbox code only talks to Kitsuden through `kitsuden.api.*`, and each
 * call re-enters the app (`app.fetch`) as an AGENT: it goes through the
 * same denials, gates, operation permissions (`can()`), RLS, quotas
 * and approvals as that identity over the network. There is no shortcut to the database or to
 * any secret.
 *
 * Which agent:
 *
 *   · The action DECLARES what its code can do: `config.scopes`
 *     (e.g. `["datasets:clients:read"]`). Without a declaration, the code has no
 *     API — least privilege by default.
 *   · If the one executing is an AGENT (POST /api/actions/:id/execute with its
 *     key), the code acts AS that agent (its quotas, its approval mode,
 *     its audit) with the declared scopes the agent HAS
 *     — never more — and keeping its `!pattern` denials.
 *   · If the one executing is a PERSON, or the action fires from cron or an
 *     event, the code acts as a synthetic agent `action:<id>` with the
 *     declared scopes, but only if the responsible person (whoever executes, or
 *     whoever created the action for cron/events) is an admin NOW. If their
 *     role was withdrawn or the account deleted, the action keeps computing but without API.
 *
 * Headers that the code passes to the API are ignored: the identity is set by the
 * process (`INTERNAL_RUN_MARK`, a symbol that does not arrive from the network).
 */

import { concedeScope } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { db } from "../../db";
import { authUsers } from "../../db/schema";
import type { AgentAuthContext } from "../../services/agent-auth";
import { internalRequest } from "../approvals";
import type { SandboxApi } from "../worker-sandbox";

/** Who requested the execution (set by the routes; cron and events do not have it). */
export type ActionExecutor =
  | { type: "agent"; agent: AgentAuthContext }
  | { type: "human"; userId: string; role?: string | null };

/** What the action declares in `config.scopes` (non-empty text, no duplicates). */
export function declaredScopes(config: unknown): string[] {
  const s = (config as { scopes?: unknown } | null)?.scopes;
  if (!Array.isArray(s)) return [];
  return [
    ...new Set(
      s.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    ),
  ];
}

async function currentRole(userId: string): Promise<string | null> {
  const [u] = await db
    .select({ role: authUsers.role })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  return u?.role ?? null;
}

/**
 * The identity the action's code calls the API with, or `null` if
 * it must have no API (see the header).
 */
export async function actionIdentity(
  action: { id: string; slug?: string | null; config: unknown; createdById?: string | null },
  executor: ActionExecutor | undefined
): Promise<AgentAuthContext | null> {
  const declaredAll = declaredScopes(action.config).filter((s) => !s.startsWith("!"));
  if (declaredAll.length === 0) return null;

  if (executor?.type === "agent") {
    const ownValues = executor.agent.scopes ?? [];
    const grantedItems = declaredAll.filter((s) => concedeScope(ownValues, s));
    if (grantedItems.length === 0) return null;
    return {
      ...executor.agent,
      scopes: [...grantedItems, ...ownValues.filter((s) => s.startsWith("!"))],
    };
  }

  // Person: the one executing; for cron/events, the one who created the action.
  const userId = executor?.type === "human" ? executor.userId : (action.createdById ?? null);
  if (!userId) return null;
  // The role is re-read from the database: the session's may be hours old.
  const role = await currentRole(userId);
  if (role !== "admin") return null;

  return {
    agentId: `action:${action.id}`,
    agentName: `action:${action.slug ?? action.id}`,
    scopes: declaredAll,
    rateLimit: 120,
    writesPerDay: null,
    budgetUnitsPerDay: null,
    keyId: "",
    allowedTools: [],
    sponsor: { userId, valid: true },
  };
}

/**
 * The API injected into the sandbox: internal requests as `agent`. `unattended`
 * (cron and event triggers: nobody waits for the answer) lets the approval gate
 * refuse a held write with an alternative instead of holding it.
 */
export function sandboxApiFor(
  agent: AgentAuthContext,
  actionId: string,
  unattended = false
): SandboxApi {
  return async (method, path, body) => {
    const res = await internalRequest(
      { agent, sandbox: { actionId, unattended } },
      method,
      path,
      body
    );
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      body: await res.text(),
      url: path,
    };
  };
}

/** A request's executor: the agent if it came with its key, otherwise the person. */
export function requestExecutor(c: { get?(key: string): unknown }): ActionExecutor | undefined {
  // Without `get` (custom test contexts) there is nobody to attribute anything to.
  const get = typeof c.get === "function" ? (k: string) => c.get!(k) : () => undefined;
  const agent = get("agent") as AgentAuthContext | undefined;
  if (agent?.agentId) return { type: "agent", agent };
  const user = get("user") as { id?: string; role?: string | null } | null | undefined;
  if (user?.id) return { type: "human", userId: user.id, role: user.role ?? null };
  return undefined;
}

/**
 * Who is recorded as the creator (`created_by_id`, an `auth_users` account): the
 * person; for an agent, its valid signer. The session decides it, never the
 * request body.
 */
export function requestCreator(c: { get?(key: string): unknown }): string | null {
  const e = requestExecutor(c);
  if (e?.type === "human") return e.userId;
  if (e?.type === "agent") return e.agent.sponsor?.valid ? e.agent.sponsor.userId : null;
  return null;
}
