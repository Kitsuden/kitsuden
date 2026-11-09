/**
 * Kitsuden — Postgres LISTEN: one dedicated connection for the whole process
 * ============================================================================
 *
 * Used by the queue (channel `kitsuden_queue`: «there is work») and by the realtime
 * bus when there is no Valkey (channel `kitsuden_bus`).
 *
 * ── WHY A SEPARATE CONNECTION ──────────────────────────────────────────────
 *
 * LISTEN is SESSION state: it needs a long-lived connection that nobody
 * else uses. That is why:
 *   · it does NOT come from the request pool (a pool connection serves
 *     anyone and goes back to the pool; the LISTEN would be lost or, worse, taken
 *     by another request).
 *   · it can NOT go through PgBouncer in transaction mode: there each statement
 *     may go to a different server and the LISTEN reaches nothing. If the API
 *     sits behind PgBouncer, `DATABASE_LISTEN_URL` points DIRECTLY to Postgres
 *     (docs/install/pgbouncer.md).
 *
 * NOTIFY is delivered at COMMIT: a job dispatched in a request that
 * ends in ROLLBACK notifies nobody, which is exactly what the outbox asks for. And
 * since a notification can be lost (reconnection, an outage), the queue does NOT
 * depend on it: it polls anyway every few seconds. This only speeds things up.
 *
 * Failure: it reconnects with growing backoff (up to 30 s), without taking anything down.
 */

import pg from "pg";

import { logger } from "./logger";

type Listener = (payload: string) => void;

const listeners = new Map<string, Set<Listener>>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closed = false;

const VALID_CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

/** The listen connection URL: direct to Postgres if there is a PgBouncer in front. */
export function listenUrl(): string | null {
  const url = process.env.DATABASE_LISTEN_URL || process.env.DATABASE_URL || "";
  if (!url || url === "lite") return null;
  return url;
}

async function connect(): Promise<void> {
  const url = listenUrl();
  if (!url || closed) return;
  const next = new pg.Client({ connectionString: url, application_name: "kitsuden-listen" });
  next.on("notification", (msg) => {
    for (const fn of listeners.get(msg.channel) ?? []) {
      try {
        fn(msg.payload ?? "");
      } catch (err) {
        logger.warn({ err, channel: msg.channel }, "[listen] a listener failed");
      }
    }
  });
  next.on("error", (err) => {
    logger.warn({ err: err.message }, "[listen] the listen connection failed; reconnecting");
    lose(next);
  });
  next.on("end", () => lose(next));
  await next.connect();
  for (const channel of listeners.keys()) await next.query(`LISTEN ${channel}`);
  client = next;
  attempts = 0;
}

function lose(old: pg.Client): void {
  if (client !== old) return;
  client = null;
  old.end().catch(() => {});
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (closed || retryTimer) return;
  attempts++;
  const wait = Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensure();
  }, wait);
  retryTimer.unref?.();
}

async function ensure(): Promise<void> {
  if (client || closed) return;
  connecting ??= connect()
    .catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[listen] could not open the listen connection; retrying"
      );
      scheduleReconnect();
    })
    .finally(() => {
      connecting = null;
    });
  await connecting;
}

/**
 * Listens on a channel. Returns the function to stop listening. Without a Postgres
 * URL (lite mode, pg-mem) it does nothing: whoever listens must have their
 * own plan B (the queue polls; the bus delivers in-process).
 */
export async function listen(channel: string, fn: Listener): Promise<() => Promise<void>> {
  if (!VALID_CHANNEL.test(channel)) throw new TypeError(`Invalid LISTEN channel: ${channel}`);
  closed = false;
  let listenerSet = listeners.get(channel);
  const newChannel = !listenerSet;
  if (!listenerSet) {
    listenerSet = new Set();
    listeners.set(channel, listenerSet);
  }
  listenerSet.add(fn);
  await ensure();
  if (newChannel && client) await client.query(`LISTEN ${channel}`).catch(() => {});
  return async () => {
    listenerSet.delete(fn);
    if (listenerSet.size === 0) {
      listeners.delete(channel);
      await client?.query(`UNLISTEN ${channel}`).catch(() => {});
    }
  };
}

/** Is there a live listen connection right now? */
export function activeListening(): boolean {
  return client !== null;
}

/** Closes the connection (orderly shutdown). */
export async function closeListener(): Promise<void> {
  closed = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const c = client;
  client = null;
  listeners.clear();
  await c?.end().catch(() => {});
}
