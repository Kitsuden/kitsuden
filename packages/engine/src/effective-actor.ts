/**
 * The EFFECTIVE ACTOR — so kon policies recognize agents
 * ============================================================================
 *
 * ── THE FAILURE (HTTP e2e tests) ───────────────────────────────────────────
 *
 * An agent reaches the kons with `role: "agent"` and its `scopes`. The kons'
 * policies and RLS asked about the HUMAN role (`role === "admin"`), so an
 * agent with `admin`:
 *
 *   · in dms, members and booking got a 200 with an EMPTY list (RLS did not
 *     know it);
 *   · in newsletter, 403 "Administrator required";
 *   · with `crm:*`, the guide promised "the whole kon" and it did not get into
 *     any legacy route.
 *
 * It was patched kon by kon (conta 0003, ecommerce 0004, blog, builder), each
 * with its own copy of the scopes rule in TypeScript or in plpgsql. This is
 * the rule ONCE, for all of them:
 *
 *   isEffectiveAdmin(user, kon)  human admin, or an agent that opens the WHOLE kon
 *                               (`admin`, `<kon>:*`, `kon:<kon>:*`; see
 *                               `opensWholeKon` in @kitsuden/shared)
 *   isEffectiveStaff(user, kon)  the above, or a human admin/editor
 *   agentCan(user, scope)    an agent whose scopes grant `scope`
 *   agentCanInKon(user, kon, scope)  the same within a kon (the whole kon
 *                               opens it; `!<kon>:*` closes it)
 *   effectiveActor(user, kon)    all together, for whoever prefers an object
 *
 * And in the database, the same questions with the same name (core file
 * `apps/api/src/db/agent-functions.sql`, applied BEFORE the kon
 * migrations): `kitsuden_effective_admin('<kon>')`,
 * `kitsuden_effective_staff('<kon>')`, `kitsuden_agent_can('<scope>')`,
 * `kitsuden_agent_can_in_kon('<kon>', '<scope>')`.
 * A test compares the two with the same table of cases.
 *
 * `kon` is the SHORT name (`crm`, `dms`, `members`), the one used in scopes.
 *
 * Without `kon`, `isEffectiveAdmin` only recognizes the `admin` scope: a `crm:*`
 * is not an administrator of anything other than the CRM.
 */

import { agentActsAsUser, opensWholeKon, concedeScope, denialThatCovers } from "@kitsuden/shared";

/**
 * The minimum that is looked at about whoever asks. Structural (not `AuthzUser`)
 * so that the user of any kon works: `DmsUser`, `{ role?: unknown }`…
 */
export type WhoAsks = { id?: unknown; role?: unknown; scopes?: unknown } | null | undefined;
type Who = WhoAsks;

const STAFF_ROLES = new Set(["admin", "editor"]);

/** Is it an agent (a `kitsuden_agent_*` key), with its list of scopes? */
export function isAgent(user: Who): user is NonNullable<Who> & { role: "agent"; scopes: string[] } {
  return !!user && user.role === "agent" && Array.isArray(user.scopes);
}

/**
 * Do its scopes grant the AGENT the `required` scope? (A human: no; humans
 * decide by role.) With several: if a denial covers ANY of them, no; otherwise,
 * it is enough that one is granted. It is the form of "any of these permissions
 * lets you see the draft": `!kon:blog:*` closes it even if it carries `admin`.
 */
export function agentCan(user: Who, required: string | readonly string[]): boolean {
  if (!isAgent(user)) return false;
  const list = typeof required === "string" ? [required] : required;
  if (list.length === 0) return false;
  if (denialThatCovers(user.scopes, list)) return false;
  return list.some((r) => concedeScope(user.scopes, r));
}

/**
 * A single permission WITHIN a kon: the agent can `required`
 * (`member:view`) or opens the whole kon, and no denial closes either the
 * action or the whole kon (`!members:*` also closes `member:view`, which does
 * not start with `members:`). In SQL: `kitsuden_agent_can_in_kon`.
 */
export function agentCanInKon(user: Who, kon: string, required: string): boolean {
  if (!isAgent(user) || !kon) return false;
  if (denialThatCovers(user.scopes, [`${kon}:*`, `kon:${kon}:*`, required])) return false;
  return opensWholeKon(user.scopes, kon) || concedeScope(user.scopes, required);
}

/** Human admin, or an agent that opens THIS whole kon (or with `admin` if no kon is given). */
export function isEffectiveAdmin(user: Who, kon?: string): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!isAgent(user)) return false;
  if (kon) return opensWholeKon(user.scopes, kon);
  return (
    !denialThatCovers(user.scopes, ["admin"]) &&
    user.scopes.some((s) => s === "admin" || s === "admin:*")
  );
}

/** Human admin or editor, or an agent that opens this whole kon. */
export function isEffectiveStaff(user: Who, kon?: string): boolean {
  if (!user) return false;
  if (typeof user.role === "string" && STAFF_ROLES.has(user.role)) return true;
  return isEffectiveAdmin(user, kon);
}

/**
 * The `actAsUser` rule of a kon policy, ready to use: `actAsUser: actsAsUserIn("crm")`.
 *
 * WHY IT EXISTS. A kon's "any signed-in account" routes (my courses, my bookings, the operations
 * on one row that check the row's policy in the handler) used to be opened by the host's
 * `requireAuth`, which lets an AGENT through only when it may act as a user: `user:act`, `admin`,
 * or some scope of that kon. SDK operations do not go through `requireAuth`, so a kon declares the
 * same rule as the `actAsUser` action of its policy and its operations ask for it before the
 * handler (`permission: { policy: { resource, action: "actAsUser" } }`). Fifteen kons had a
 * copy of this function; this is the copy.
 *
 * A human account always passes (what it may then do is the row's policy); an agent passes with
 * `user:act`/`admin` or a non-denied scope that starts with `<kon>:` or `kon:<kon>:`; nobody
 * without an id passes.
 */
export function actsAsUserIn(kon: string): (user: Who) => boolean {
  return (user) => {
    if (!user?.id) return false;
    if (user.role !== "agent") return true;
    const scopes = (Array.isArray(user.scopes) ? (user.scopes as unknown[]) : [])
      .filter((s): s is string => typeof s === "string")
      .filter((s) => !s.startsWith("!"));
    return (
      agentActsAsUser(scopes) ||
      scopes.some((s) => s.startsWith(`${kon}:`) || s.startsWith(`kon:${kon}:`))
    );
  };
}

export interface EffectiveActor {
  /** Id of the account or agent; `null` if nobody. */
  id: string | null;
  isAgent: boolean;
  isAdmin: boolean;
  isStaff: boolean;
}

/** The questions above all at once (for whoever asks several). */
export function effectiveActor(user: Who, kon?: string): EffectiveActor {
  return {
    id: typeof user?.id === "string" && user.id.length > 0 ? user.id : null,
    isAgent: isAgent(user),
    isAdmin: isEffectiveAdmin(user, kon),
    isStaff: isEffectiveStaff(user, kon),
  };
}
