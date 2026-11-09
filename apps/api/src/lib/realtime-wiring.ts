/**
 * Kitsuden — Wiring realtime to the real policies
 * ============================================================================
 *
 * Joins the two halves: the transport (`realtime.ts`, which knows no policies)
 * and the access rules (`realtime-changes.ts` + `rls-builder`).
 *
 * It is called ONCE at startup. If it were not called, realtime stays
 * deny-by-default (admins only) — it fails closed, never open.
 */

import { eq } from "drizzle-orm";

import { db } from "../db";
import { authSessions, authUsers, dataSets } from "../db/schema-core";

import { events } from "./events";
import {
  setSessionValidator,
  setSubscriptionAuthorizer,
  setRowFilter,
  type CurrentSession,
  type RealtimeUser,
} from "./realtime";
import {
  canSubscribe,
  changes,
  filterForClient,
  resourceOf,
  type ChangeEvent,
  type ResourcePolicy,
} from "./realtime-changes";
import type { PolicyJson, RLSUser } from "./rls-builder";

/**
 * Per-resource policy cache. Resolving the policy on EVERY event would be
 * one query per row and per subscriber; with the cache it is once per
 * resource. Short TTL so that a policy change propagates quickly.
 */
export const POLICY_TTL_MS = 30_000;
const cache = new Map<string, { policy: ResourcePolicy | null; at: number }>();
/** One query per resource even when several subscribers ask at once. */
const inFlight = new Map<string, Promise<ResourcePolicy | null>>();
/**
 * Bumped by every invalidation: a query that started before it may have read
 * the policy as it was BEFORE the edit, so its result is returned but not cached.
 */
let generation = 0;

function resolvePolicy(resource: string): Promise<ResourcePolicy | null> {
  const hit = cache.get(resource);
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return Promise.resolve(hit.policy);
  const pending = inFlight.get(resource);
  if (pending) return pending;
  const query = readPolicy(resource).finally(() => {
    if (inFlight.get(resource) === query) inFlight.delete(resource);
  });
  inFlight.set(resource, query);
  return query;
}

async function readPolicy(resource: string): Promise<ResourcePolicy | null> {
  const generationAtStart = generation;
  let policy: ResourcePolicy | null = null;
  try {
    // `table:<slug>` channels point to datasets; their policyJson is the
    // same source of truth that REST and GraphQL use.
    const [row] = await db
      .select({ policyJson: dataSets.policyJson })
      .from(dataSets)
      .where(eq(dataSets.slug, resource))
      .limit(1);

    if (row) policy = { policyJson: row.policyJson as PolicyJson | null };
  } catch {
    // No DB → no policy → the authorizer falls back to admin-only.
    policy = null;
  }

  // Invalidated while the query ran: what it read may predate the edit, and
  // caching it would serve the old policy for a whole TTL.
  if (generation === generationAtStart) cache.set(resource, { policy, at: Date.now() });
  return policy;
}

/**
 * Invalidates a policy's cache. Called by the routes that edit a dataset and by
 * the `dataset:updated`/`dataset:deleted` listener below.
 */
export function invalidateRealtimePolicy(resource?: string): void {
  generation++;
  if (resource) {
    cache.delete(resource);
    inFlight.delete(resource);
  } else {
    cache.clear();
    inFlight.clear();
  }
}

/**
 * A session by id as it is NOW in the database, with its user's current role:
 * realtime revalidates open sockets with it (lib/realtime.ts). Throws when the
 * database does not answer; the manager then closes the socket (fails closed).
 */
export async function readCurrentSession(sessionId: string): Promise<CurrentSession | null> {
  const [row] = await db
    .select({
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      role: authUsers.role,
    })
    .from(authSessions)
    .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  return {
    userId: row.userId,
    role: (row.role as string | null) ?? null,
    expiresAt: new Date(row.expiresAt).getTime(),
  };
}

/**
 * The realtime user as the policy functions expect it: `null` for an anonymous
 * socket. Passing `{ id: undefined }` made `checkReadAccess` count an anonymous
 * subscriber as signed in (`authenticated` is `!!user`).
 */
export function policyUser(user: RealtimeUser): RLSUser | null {
  if (!user.id) return null;
  return { id: user.id, role: user.role ?? undefined } as RLSUser;
}

/**
 * Connects authorization and per-row filtering to the realtime manager.
 * Idempotent: calling it twice simply re-registers the functions.
 */
export function wireRealtimeAuthorization(): void {
  setSubscriptionAuthorizer(async (channel: string, user: RealtimeUser) => {
    const resource = resourceOf(channel);
    // Channels that are not table ones (entry:, content:) keep the
    // conservative behavior: admin only until they have their own policy.
    if (!resource) return user.role === "admin" && !!user.id;
    const policy = await resolvePolicy(resource);
    return canSubscribe(channel, policyUser(user), policy);
  });

  setRowFilter(async (channel: string, data: unknown, user: RealtimeUser) => {
    const resource = resourceOf(channel);
    if (!resource) return user.role === "admin" && user.id ? data : null;

    // The policy as of NOW. Reading the cache without resolving it used a policy
    // that could be any age (the TTL was only checked on subscribe) or none at all
    // right after `invalidateRealtimePolicy`: a tightened policy kept broadcasting
    // under the old one. `resolvePolicy` hits the same cache while it is fresh.
    const policy = await resolvePolicy(resource);

    const event = data as ChangeEvent;
    if (!event || typeof event !== "object" || !("row" in event)) {
      // A message that is not a ChangeEvent (legacy format): admin only.
      return user.role === "admin" && user.id ? data : null;
    }

    return filterForClient(event, policyUser(user), policy);
  });

  // Sockets re-read their session on subscribe and every minute (lib/realtime.ts).
  setSessionValidator(readCurrentSession);

  // A policy edited through this API applies to the very next event, as it does
  // to the next REST read; nothing was invalidating the cache, so a tightened
  // policy kept broadcasting for up to the TTL. An edit made on another replica
  // still waits for the TTL.
  if (!invalidatesOnEdit) {
    invalidatesOnEdit = true;
    for (const name of ["dataset:updated", "dataset:deleted"]) {
      events.on(name, () => invalidateRealtimePolicy());
    }
  }

  console.log("  🔒 Realtime: per-channel authorization + per-row filtering active");
}

let invalidatesOnEdit = false;

// ═══════════════════════════════════════════════════════════════════════════
// BRIDGE internal events → realtime channels
//
// Kons already emit semantic events through the host's EventEmitter
// (`ctx.events.emit("entry:created", …)`). Instead of touching every mutation of
// every kon, a single bridge translates them into change events published on
// Valkey — this way any kon gains realtime without writing an extra line, and
// the day the channel format changes only one place is touched.
// ═══════════════════════════════════════════════════════════════════════════

/** Resolves a dataset's slug by id (channels use slug, not uuid). */
async function slugOf(datasetId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ slug: dataSets.slug })
      .from(dataSets)
      .where(eq(dataSets.id, datasetId))
      .limit(1);
    return row?.slug ?? null;
  } catch {
    return null;
  }
}

export function bridgeEventsToRealtime(): void {
  events.on("entry:created", async (payload: unknown) => {
    const { datasetId, entries } = (payload ?? {}) as {
      datasetId?: string;
      entries?: Record<string, unknown>[];
    };
    if (!datasetId || !Array.isArray(entries)) return;
    const slug = await slugOf(datasetId);
    if (!slug) return;
    for (const row of entries) await changes.inserted(slug, row);
  });

  events.on("entry:updated", async (payload: unknown) => {
    const row = payload as Record<string, unknown> | undefined;
    const datasetId = row?.dataSetId as string | undefined;
    if (!row || !datasetId) return;
    const slug = await slugOf(datasetId);
    if (slug) await changes.updated(slug, row);
  });

  events.on("entry:deleted", async (payload: unknown) => {
    const row = payload as Record<string, unknown> | undefined;
    const datasetId = row?.dataSetId as string | undefined;
    if (!row || !datasetId) return;
    const slug = await slugOf(datasetId);
    if (slug) await changes.deleted(slug, row);
  });

  console.log("  📡 Realtime: internal events → channels bridge active");
}
