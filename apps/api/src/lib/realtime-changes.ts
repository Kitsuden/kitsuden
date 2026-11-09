/**
 * Kitsuden — Realtime: change emission with per-subscriber authorization
 * ============================================================================
 *
 * The missing half. `realtimeManager` already had the transport (WebSocket +
 * Valkey Pub/Sub, listening to `table:*`), but NOBODY published those events and
 * `subscribeToChannel` accepted any channel without validating.
 *
 * This module closes both gaps:
 *
 *   emitChange()      → publishes INSERT/UPDATE/DELETE to the table's channel
 *   canSubscribe()    → decides whether a user can listen to a channel
 *   filterForClient() → trims the row to what that user can see
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY AUTHORIZATION GOES HERE AND NOT IN THE TRANSPORT
 * ═══════════════════════════════════════════════════════════════════════════
 * A naive fan-out ("I publish the row to everyone subscribed to the channel") leaks
 * data between tenants: it is the SAME bug we had in GraphQL and in dataset
 * entries, but in streaming. The rule is that realtime must NOT have its
 * own authorization path — it must reuse the one that is already proven:
 * `checkReadAccess` for the gate and `rlsRules` for the per-row filter.
 *
 * That is why the event is published ONCE and evaluated PER SUBSCRIBER before
 * delivering it. It costs a bit more CPU, but it is the only correct way.
 *
 * And the same visibility of drafts as REST and search (`publishedOrOwn`):
 * outside the team (admin, editor) a row reaches a subscriber only when it is
 * `published` or theirs (`ownerId` or `createdById`). Until 2026-11-04 a public
 * dataset broadcast every draft to every subscriber (security review 2026-11-03).
 */

import { checkReadAccess, type PolicyJson, type RLSUser } from "./rls-builder";

// ── Types ────────────────────────────────────────────────────────────────────

export type ChangeType = "INSERT" | "UPDATE" | "DELETE";

export interface ChangeEvent {
  type: ChangeType;
  /** Table or dataset slug affected. */
  resource: string;
  /** Resulting row (INSERT/UPDATE) or the deleted one (DELETE). */
  row: Record<string, unknown>;
  /** Previous row, only on UPDATE — allows diffs on the client. */
  previous?: Record<string, unknown>;
  /** Moment of the change (ISO). */
  at: string;
}

/** Resource policy, resolved by the emitter. */
export interface ResourcePolicy {
  policyJson: PolicyJson | null;
  /** Field that identifies the row's owner (default "ownerId"). */
  ownerField?: string;
}

// ── Channels ─────────────────────────────────────────────────────────────────

/**
 * Channel name of a table. The `table:` prefix is the one `realtimeManager`
 * already listens to from Valkey.
 */
export function channelFor(resource: string): string {
  return `table:${resource}`;
}

/** Extracts the resource from a channel (`table:products` → `products`). */
export function resourceOf(channel: string): string | null {
  const match = /^table:([A-Za-z0-9_-]+)$/.exec(channel);
  return match ? match[1] : null;
}

// ── Authorization ────────────────────────────────────────────────────────────

/**
 * Can this user subscribe to the channel?
 *
 * Reuses `checkReadAccess`, the SAME gate used by the REST and GraphQL routes:
 * no policy → admin only (deny-by-default); `authenticated` → logged in;
 * `public` → anyone.
 *
 * A channel whose resource is not recognized is DENIED (it is not assumed to be public).
 */
export function canSubscribe(
  channel: string,
  user: RLSUser | null,
  policy: ResourcePolicy | null
): boolean {
  const resource = resourceOf(channel);
  if (!resource) return false; // channel with unknown format → deny
  if (!policy) return user?.role === "admin" && !!user.id; // resource without a policy → admin
  // The team reads every dataset over REST (`readable` in routes/crud.ts, `view`
  // in the datasets policy): the same here.
  if (isTeam(user)) return true;
  return checkReadAccess(policy.policyJson, user);
}

/**
 * Can this subscriber see THIS specific row?
 *
 * It is the streaming equivalent of `buildDatasetWhere` + `publishedOrOwn`:
 * when the policy declares owner isolation, a user only receives changes to
 * their own rows, and outside the team only published or own rows. The admin
 * sees everything.
 *
 * Returns the event (possibly without `previous`) or `null` if it must not be
 * delivered.
 */
export function filterForClient(
  event: ChangeEvent,
  user: RLSUser | null,
  policy: ResourcePolicy | null
): ChangeEvent | null {
  if (!policy) return user?.role === "admin" && !!user.id ? event : null;
  // The team passes the gate as it does over REST (`readable`); everyone else
  // needs the policy's `readAccess`.
  if (!isTeam(user) && !checkReadAccess(policy.policyJson, user)) return null;
  if (user?.role === "admin") return event;
  if (!event.row || typeof event.row !== "object") return null;

  if (!rowVisible(event.row, user, policy)) return null;
  // The row is visible now, but on an UPDATE `previous` is content too: the
  // draft it was, or a version another owner's rule hides. Delivered without it.
  if (event.previous && !rowVisible(event.previous, user, policy)) {
    const withoutPrevious: ChangeEvent = { ...event };
    delete withoutPrevious.previous;
    return withoutPrevious;
  }
  return event;
}

/**
 * Whether one version of a row reaches a non-admin subscriber, as in a REST
 * read: ALL the `rlsRules` (AND, like `buildDatasetWhere`, which skips them
 * only for admin) and, outside the team, `publishedOrOwn`.
 */
function rowVisible(
  row: Record<string, unknown>,
  user: RLSUser | null,
  policy: ResourcePolicy
): boolean {
  // Before only the owner's rule was checked: with `status eq published` the
  // socket also delivered drafts (an earlier audit).
  const rules = policy.policyJson?.rlsRules ?? [];
  const data = (row.data ?? {}) as Record<string, unknown>;
  for (const rule of rules) {
    if (!meetsRule(rule, row, data, user, policy.ownerField)) return false;
  }
  return isTeam(user) || publishedOrOwnRow(row, user);
}

/**
 * The team (admin, editor) sees drafts over REST too (`isFromTeam` in
 * routes/crud.ts). Only with an id: a role on an anonymous socket is nothing.
 */
export function isTeam(user: RLSUser | null): boolean {
  return !!user?.id && (user.role === "admin" || user.role === "editor");
}

/**
 * `publishedOrOwn` (@kitsuden/shared) on a row in memory: `status = 'published'`
 * or the row is the user's (`owner_id` / `created_by_id`). A row without a status
 * is not published, as in SQL (`NULL = 'published'` is not true).
 */
export function publishedOrOwnRow(row: Record<string, unknown>, user: RLSUser | null): boolean {
  if (row.status === "published") return true;
  const id = user?.id;
  if (!id) return false;
  const owner = row.ownerId ?? row.owner_id;
  const creator = row.createdById ?? row.created_by_id;
  return (owner != null && String(owner) === id) || (creator != null && String(creator) === id);
}

/**
 * An `rlsRules` rule over a row, in memory: the same semantics as
 * `buildRuleCondition` from @kitsuden/shared (`data->>field` as text). An unknown
 * operator does NOT let anything through (in SQL it is ignored; here no risk is taken).
 */
function meetsRule(
  rule: { field?: string; operator?: string; value?: unknown },
  row: Record<string, unknown>,
  data: Record<string, unknown>,
  user: RLSUser | null,
  ownerField?: string
): boolean {
  // The two markers for "the current user": `__USER_ID__` (the one
  // rls-builder understands) and the historical `{{current_user_id}}`.
  const ofTheUser = rule.value === "__USER_ID__" || rule.value === "{{current_user_id}}";
  if (ofTheUser && !user?.id) return false;
  const expected = ofTheUser ? user!.id : rule.value;
  // The ownerId may come in the column or inside the JSONB `data` (datasets)
  const field = rule.field || (ofTheUser ? ownerField || "ownerId" : "");
  if (!field) return false;
  const raw = row[field] ?? data[field];
  const value = raw === undefined || raw === null ? null : String(raw);
  switch (rule.operator) {
    case "eq":
      return value !== null && value === String(expected);
    case "neq":
      // In SQL `NULL <> x` is not true: not here either
      return value !== null && value !== String(expected);
    case "contains":
      return value !== null && value.includes(String(expected));
    case "gt":
      return value !== null && Number(value) > Number(expected);
    case "lt":
      return value !== null && Number(value) < Number(expected);
    default:
      return false;
  }
}

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Publishes a change to its resource's channel.
 *
 * It relies on Valkey Pub/Sub so that the event reaches ALL API instances
 * (not just the one that served the request). If Valkey is not
 * available, it degrades silently: realtime is an enhancement, it can never
 * take down the write that originated it.
 */
export async function emitChange(
  type: ChangeType,
  resource: string,
  row: Record<string, unknown>,
  previous?: Record<string, unknown>
): Promise<void> {
  const event: ChangeEvent = {
    type,
    resource,
    row,
    ...(previous ? { previous } : {}),
    at: new Date().toISOString(),
  };

  try {
    const { publish } = await import("./valkey");
    await publish(channelFor(resource), JSON.stringify(event));
  } catch {
    // Valkey down → no realtime, but the data operation has already completed.
  }
}

/** Sugar for the three types, so that handlers read well. */
export const changes = {
  inserted: (resource: string, row: Record<string, unknown>) => emitChange("INSERT", resource, row),
  updated: (resource: string, row: Record<string, unknown>, previous?: Record<string, unknown>) =>
    emitChange("UPDATE", resource, row, previous),
  deleted: (resource: string, row: Record<string, unknown>) => emitChange("DELETE", resource, row),
};
