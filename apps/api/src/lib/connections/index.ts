/**
 * Connections: the core's battery (docs/connections.md)
 * ============================================================================
 *
 * Accounts at other services, connected once and used by every kon that needs one: a person's Google or
 * Microsoft mailbox and calendar, the organization's Stripe or Resend key.
 *
 *   providers.ts  the catalog: Google and Microsoft built in, and what each kon registers (it owns it)
 *   service.ts    connect (OAuth with PKCE, or an API key), refresh, expire, revoke; every credential
 *                 sealed with the installation's secrets key and opened with a recorded purpose
 *   client.ts     the `fetch` a kon gets: it carries the credential only to the provider's hosts
 *   routes/connections.ts  what people and agents call
 *
 * A kon reaches it as `ctx.connections`, bound to its id by kon-setup.ts like `ctx.secrets`.
 *
 * Events (core event bus, after the write):
 *   connections:connection.created | .expired | .revoked   { connectionId, provider, scope, ownerId }
 *
 * A worker refreshes access tokens five minutes before they run out, every five minutes; a connection the
 * provider will no longer refresh becomes `expired` and is announced once.
 */

import {
  CONNECTION_EVENTS,
  type ConnectionProviderDefinition,
  type KonConnections,
} from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import { resolveExecutor } from "../../../../../packages/engine/src/request-scope";
import { db } from "../../db";
import { events } from "../events";
import { konSecrets } from "../kon-secrets";
import { logger } from "../logger";

import { clientFor } from "./client";
import { connectionFetch } from "./network";
import {
  covers,
  providerOf,
  providerProblem,
  registerProvider as addToCatalog,
  GOOGLE,
  MICROSOFT,
} from "./providers";
import { connConnections, publicConnection, type ConnectionRow } from "./schema";
import { dueForRefresh, refreshConnection, takeUnnotifiedExpired, type Fetch } from "./service";

export { allowedUrl, clientFor } from "./client";
export { ConnectionError } from "./service";

/** Which kon registered each provider: another kon cannot replace it. */
const owners = new Map<string, string>();

export function announceConnection(
  what: keyof typeof CONNECTION_EVENTS,
  row: ConnectionRow,
  extra: Record<string, unknown> = {}
): void {
  events.emit(CONNECTION_EVENTS[what], {
    connectionId: row.id,
    provider: row.provider,
    scope: row.scope,
    ownerId: row.ownerId ?? null,
    ...extra,
  });
}

function registerFor(konId: string, provider: ConnectionProviderDefinition): void {
  if (provider.id === GOOGLE.id || provider.id === MICROSOFT.id)
    throw new Error(`connections: ${provider.id} is built in`);
  const owner = owners.get(provider.id);
  if (owner && owner !== konId) throw new Error(`connections: ${provider.id} belongs to ${owner}`);
  const problem = providerProblem(provider);
  if (problem) throw new Error(`connections: ${problem}`);
  addToCatalog(provider);
  owners.set(provider.id, konId);
}

/** The battery, unbound: kon-setup.ts binds the kon id (a kon passing another one is refused). */
export const konConnections: KonConnections = {
  async client(konId, request) {
    // As the system: a kon calls this from a worker or after a request, and asks for the owner it means.
    return clientFor(db, konSecrets, { ...request, purpose: `${konId}: ${request.purpose}` });
  },
  registerProvider(konId, provider) {
    registerFor(konId, provider);
  },
  async visible(_konId, connectionId) {
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
    // The request's transaction when there is one: row security decides what the caller sees.
    const executor = resolveExecutor(db) as typeof db;
    const [row] = await executor
      .select()
      .from(connConnections)
      .where(eq(connConnections.id, connectionId))
      .limit(1);
    return row ? publicConnection(row as ConnectionRow) : null;
  },
  covers(provider, grantedScopes, scopeSets) {
    const p = providerOf(provider);
    return p ? covers(p, grantedScopes, scopeSets) : false;
  },
};

/** One pass: refresh what runs out soon, announce what expired. */
export async function refreshTick(network: Fetch = connectionFetch, now = new Date()) {
  const result = { refreshed: 0, expired: 0, failed: 0 };
  for (const row of await dueForRefresh(db, now)) {
    try {
      const r = await refreshConnection(db, konSecrets, row, { fetch: network, now });
      if (r.outcome === "refreshed") result.refreshed++;
      else if (r.outcome === "expired") result.expired++;
      else if (r.outcome === "failed") result.failed++;
    } catch (err) {
      result.failed++;
      logger.warn(
        { connectionId: row.id, err: err instanceof Error ? err.message : String(err) },
        "[connections] refresh failed"
      );
    }
  }
  for (const row of await takeUnnotifiedExpired(db, now))
    announceConnection("expired", row, { reason: row.lastError });
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** Started once by the API (index.ts); `unref` so it never holds the process open. */
export function startConnectionsWorker(): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await refreshTick();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[connections] refresh pass failed"
      );
    } finally {
      busy = false;
    }
  }, 5 * 60_000);
  timer.unref?.();
}

export function stopConnectionsWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Forgets which kon registered which provider (tests). */
export function resetProviderOwners(): void {
  owners.clear();
}
