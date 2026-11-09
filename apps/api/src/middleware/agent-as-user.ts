/**
 * Can THIS agent go through a route that only asks to be "authenticated"?
 * ============================================================================
 *
 * `requireAuth`/`protectRoute` used to accept any
 * agent as a user with a session, even if its key only carried
 * `datasets:x:read`; with that it commented, signed up for tournaments or saved
 * builds. Now an agent passes if:
 *
 *   · the route is an SDK operation (its `permission` decides, or
 *     `user:act` if it declares none: engine/src/operations.ts);
 *   · the prefix gate already opened for it by scope (`agentOpenedByGate`,
 *     e.g. `esports:*` on /api/esports);
 *   · it carries `user:act` or `admin`;
 *   · or it carries some scope of the route's FAMILY: of the kon that serves it
 *     (`<kon>:…`, `kon:<kon>:…`), and for dataset routes (also the lite
 *     API `/api/data-sets`) any `datasets:…` — the route then checks
 *     the specific dataset.
 *
 * SDK operations do not go through this rule: they are declared contracts and
 * decide with their `permission` (`sdkOperation` mark).
 *
 * How it coexists with fine-grained scopes and human approval (tests in
 * tests/unit/agent-as-user-paths.test.ts):
 *
 *   · Fine-grained per-dataset scopes: `datasets:<slug>:<action>` opens the
 *     `datasets` family (also the lite API); the route checks the specific dataset.
 *   · Human signer (`sponsor_user_id`): SIGNS what the agent creates
 *     (authorship and audit), does NOT lend it the human's account. An agent with a
 *     signer and no useful scope still does not act as a user here. What the
 *     agent signs goes through SDK operations, which decide with their `permission`.
 *   · Human approval: the approved proposal runs with the agent's
 *     identity re-read from the database (lib/approvals.ts), so it goes through
 *     THIS rule again. Approving is one more gate, not a grant: if the
 *     agent could not do it alone, the execution ends `failed` with 403.
 *   · MCP tools decide at their own checkpoint
 *     (mcp:read/mcp:write + each dataset's policy), not here.
 *
 * None of those paths marks the request as "act as user": so the
 * hole this rule closes stays closed for everything else.
 */
import { agentActsAsUser, konShortName } from "@kitsuden/shared";
import type { Context } from "hono";

import { pathKon } from "../lib/kon-routes";

export function agentCanActAsUser(c: Context): boolean {
  const get = c.get as (key: string) => unknown;
  const agent = get("agent") as { scopes?: string[] } | undefined;
  if (!agent) return true;
  if (get("sdkOperation") || get("agentOpenedByGate")) return true;
  const scopes = (agent.scopes ?? []).filter((s) => !s.startsWith("!"));
  if (agentActsAsUser(scopes)) return true;
  const family = routeFamily(c.req.path);
  return (
    family !== null &&
    scopes.some((s) => s.startsWith(`${family}:`) || s.startsWith(`kon:${family}:`))
  );
}

/** `blog` for /api/blog/…, `datasets` for /api/datasets and /api/data-sets. */
function routeFamily(path: string): string | null {
  if (path === "/api/data-sets" || path.startsWith("/api/data-sets/")) return "datasets";
  const kon = pathKon(path);
  return kon === null ? null : konShortName(kon);
}

export const AGENT_WITHOUT_ACCOUNT_MESSAGE =
  "This agent key cannot act as a user account here (grant it 'user:act' or the kon scope).";
