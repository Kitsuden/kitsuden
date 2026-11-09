/**
 * Page builder — authorization policy
 * ============================================================================
 *
 * The writes of `/api/page-builder` only asked for `requireAuth` (any
 * account: sign-up is open). It was covered by the prefix rule in
 * `apps/api/src/middleware/auth-guard.ts` (staff, or an agent with
 * `content:edit`). This policy makes the kon authorize itself.
 *
 * Same permissions as the gate: team (`admin`|`editor`) or an agent with the
 * EXACT scope `content:edit` (Inti's). The engine also adds, on its
 * own, the `page:<action>` scope and `admin`.
 */
import { definePolicy, type AuthzUser } from "@kitsuden/engine";

export const SCOPE_CONTENT = "content:edit";

export function isTeam(user: AuthzUser | null | undefined): boolean {
  return user?.role === "admin" || user?.role === "editor";
}

/** Team, or agent with `content:edit` (exact match, like the gate). */
export function editsContent(user: AuthzUser | null | undefined): boolean {
  return (
    isTeam(user) ||
    (user?.role === "agent" && Array.isArray(user.scopes) && user.scopes.includes(SCOPE_CONTENT))
  );
}

export function registerBlocksPolicy(): void {
  definePolicy("page", {
    /** Drafts, archived and `requireAuth` pages, without restriction. */
    viewUnpublished: (u) => editsContent(u),
    create: (u) => editsContent(u),
    update: (u) => editsContent(u),
    delete: (u) => editsContent(u),
    /** Marking the site's front page: the human team only. */
    setHomepage: (u) => isTeam(u),
  });
}

registerBlocksPolicy();
