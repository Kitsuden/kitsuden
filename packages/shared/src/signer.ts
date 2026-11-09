/**
 * The human SIGNER of an agent
 * ============================================================================
 *
 * Each agent can have a fixed responsible human (`sponsor_user_id`), which
 * an admin chooses in the panel. What the agent creates is SIGNED by that human:
 * the `authorId` of a blog entry and the `owner_id` of a dataset's
 * entries; `created_by_id` still says the agent wrote it.
 *
 * The rule is here, pure, so that the blog, the datasets
 * (REST and MCP) and the API apply it the same way. The host leaves on an agent's `user`:
 *
 *   sponsor: null                      → no signer configured
 *   sponsor: { userId, valid: true }   → team signer (admin or editor)
 *   sponsor: { userId, valid: false }  → configured but no longer valid (deleted
 *                                        or without a team role)
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 *   · With a valid signer: no author requested → the signer; requested = signer →
 *     the signer; requested SOMEONE ELSE → only if the agent has `admin`, otherwise 403.
 *   · With a signer that is no longer valid: 403 `KITSUDEN_E_AGENT_SPONSOR_INVALID`
 *     (it creates no signed content until an admin reassigns it), except an
 *     agent with `admin` that names another author itself.
 *   · Without a signer: as before signers existed. `requested` mode (the blog): the
 *     author the agent sends. `nobody` mode (datasets): no owner, unless an
 *     agent with `admin` names one.
 *
 * Public guide: docs/agents/approvals.md ("Human signer").
 */

import { concedeScope } from "./agent-permission";

export interface AgentSigner {
  userId: string;
  /** Exists and is on the team (`admin` or `editor`). */
  valid: boolean;
  /** Why it is not valid: the account does not exist or is no longer on the team. */
  reason?: "not_found" | "not_staff";
}

/** The roles that can sign for an agent. */
export const SIGNER_ROLES = ["admin", "editor"] as const;

export function canSign(role: unknown): boolean {
  return typeof role === "string" && (SIGNER_ROLES as readonly string[]).includes(role);
}

export type SignatureResolved =
  | {
      ok: true;
      /** The author / owner that is stored (`null` = none). */
      author: string | null;
      why: "sponsor" | "requested" | "none" | "human";
    }
  | {
      ok: false;
      code: "KITSUDEN_E_AGENT_SPONSOR_INVALID" | "KITSUDEN_E_FORBIDDEN";
      message: string;
    };

interface UserWithSigner {
  role?: unknown;
  scopes?: unknown;
  sponsor?: unknown;
}

function isSigner(v: unknown): v is AgentSigner {
  return Boolean(v) && typeof (v as AgentSigner).userId === "string";
}

/**
 * The author (or owner) of what the caller creates. For a human it returns what was
 * requested as is (each route keeps its usual rule); for an agent it
 * applies the signer rule.
 *
 * @param modeWithoutSigner what to do with an agent WITHOUT a signer: `requested`
 *   accepts the author it sends (blog, as before); `nobody` leaves it without an owner
 *   unless the agent has `admin` (datasets, as before).
 */
export function agentSignature(
  user: UserWithSigner | null | undefined,
  request: string | null | undefined,
  modeWithoutSigner: "requested" | "nobody"
): SignatureResolved {
  const requested = typeof request === "string" && request.length > 0 ? request : null;
  if (user?.role !== "agent") return { ok: true, author: requested, why: "human" };
  const scopes = Array.isArray(user.scopes) ? (user.scopes as string[]) : [];
  const isAdmin = concedeScope(scopes, "admin");
  const sponsor = isSigner(user.sponsor) ? user.sponsor : null;

  if (!sponsor) {
    if (requested && (modeWithoutSigner === "requested" || isAdmin)) {
      return { ok: true, author: requested, why: "requested" };
    }
    return { ok: true, author: null, why: "none" };
  }
  if (requested && requested !== sponsor.userId) {
    if (isAdmin) return { ok: true, author: requested, why: "requested" };
    return {
      ok: false,
      code: "KITSUDEN_E_FORBIDDEN",
      message:
        "An agent with a human signer can only write as that signer: send no author/owner, or its signer's id (an agent with `admin` may name another account).",
    };
  }
  if (!sponsor.valid) {
    return {
      ok: false,
      code: "KITSUDEN_E_AGENT_SPONSOR_INVALID",
      message:
        sponsor.reason === "not_found"
          ? "This agent's human signer no longer exists. An admin must assign a new signer before the agent can create signed content."
          : "This agent's human signer is no longer an admin or editor. An admin must assign a new signer before the agent can create signed content.",
    };
  }
  return { ok: true, author: sponsor.userId, why: "sponsor" };
}
