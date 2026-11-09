/**
 * Kitsuden — Valkey Connection Layer (OPTIONAL)
 *
 * Valkey (open fork of Redis) is no longer mandatory ( * 2026-10-28). The queue lives in Postgres and, without `VALKEY_URL`, everything else
 * has its single-instance substitute:
 *
 *   · cache (queries, LLM, agent)    → process memory (in-memory-cache.ts)
 *   · limiter                        → process memory (rate-limiter.ts).
 *                                      NEVER a table: every request
 *                                      would write to Postgres.
 *   · realtime Pub/Sub               → the process + Postgres LISTEN/NOTIFY
 *                                      (reaches the other replicas, if any)
 *   · quotas and idempotency         → already had their fallback table
 *
 * With several replicas, configure Valkey: it is what shares cache and
 * counters between them. Without a URL no connection is attempted (previously
 * `localhost:6379` was probed and every request paid for the failed attempt).
 *
 * ENV: VALKEY_URL > REDIS_URL. With neither, "no Valkey" mode.
 */

import { createClient, type RedisClientType } from "redis";

import { memoryGet, memorySet } from "./in-memory-cache";

// ── URL Resolution ─────────────────────────────────────────────
export const VALKEY_URL = process.env.VALKEY_URL || process.env.REDIS_URL || "";

/** Is a Valkey configured? Without it, the single-instance substitutes. */
export function valkeyConfigured(): boolean {
  return Boolean(process.env.VALKEY_URL || process.env.REDIS_URL);
}

// ── Direct Client (for cache, leaderboards) ────────────────────

let _client: RedisClientType | null = null;

/**
 * Returns a connected Valkey client (lazy singleton).
 */
async function connectWithTimeout(client: RedisClientType, timeoutMs: number): Promise<void> {
  await Promise.race([
    client.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Valkey connection timeout")), timeoutMs)
    ),
  ]);
}

/**
 * With Valkey down, each call waited for its own connection timeout (~2 s)
 * and a request goes through several of them (limiter, cache, session…): measured
 * 2026-10-18, `/api/*` took longer than bun's `idleTimeout` and the connection
 * was closed without a response. The fail-closed limiter was useless if the
 * request never got answered.
 *
 * After a failure, for `VALKEY_RETRY_AFTER_MS` (5 s) requests are rejected immediately
 * without trying again; and simultaneous attempts share a single in-flight
 * connection instead of each opening one.
 */
const WAIT_AFTER_FAILURE_MS = Number(process.env.VALKEY_RETRY_AFTER_MS) || 5000;
let _failureUntil = 0;
let _connecting: Promise<RedisClientType> | null = null;

export async function getValkeyClient(): Promise<RedisClientType> {
  if (!valkeyConfigured()) {
    throw new Error("Valkey not configured (VALKEY_URL): single-instance mode");
  }
  if (_client?.isReady) return _client;
  // Open but NOT ready = Valkey went down after connecting and the client
  // is reconnecting. Previously it was returned anyway (`isOpen` stays true) and each
  // command sat in the wait queue until Valkey came back: the
  // request never finished (measured 2026-10-19: `/api/version` hung
  // until bun closed the connection). It is rejected immediately; the
  // client itself recovers when Valkey comes back.
  if (_client?.isOpen) {
    throw new Error("Valkey unavailable (reconnecting)");
  }
  if (Date.now() < _failureUntil) {
    throw new Error("Valkey unavailable (recent connection failure)");
  }
  if (_connecting) return _connecting;

  _connecting = connect().finally(() => {
    _connecting = null;
  });
  return _connecting;
}

async function connect(): Promise<RedisClientType> {
  const client = createClient({
    url: VALKEY_URL,
    socket: { connectTimeout: 1000 },
    // No wait queue: a command with the connection down fails immediately
    // instead of waiting indefinitely for it to come back (see getValkeyClient).
    disableOfflineQueue: true,
  }) as RedisClientType;

  client.on("error", (err: Error) => {
    console.warn(`[Valkey] Connection error: ${err.message}`);
  });

  try {
    await connectWithTimeout(client, 2000);
    _client = client;
    return _client;
  } catch (err) {
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    _client = null;
    _failureUntil = Date.now() + WAIT_AFTER_FAILURE_MS;
    throw err;
  }
}

// ── Availability Check ─────────────────────────────────────────

let _available: boolean | null = null;
let _lastCheck = 0;
const CHECK_INTERVAL = 30_000;

export async function isValkeyAvailable(): Promise<boolean> {
  if (!valkeyConfigured()) return false;
  const now = Date.now();
  if (_available !== null && now - _lastCheck < CHECK_INTERVAL) {
    return _available;
  }

  try {
    const client = await getValkeyClient();
    await client.ping();
    _available = true;
  } catch {
    _available = false;
  }
  _lastCheck = Date.now();
  return _available ?? false;
}

// ═══════════════════════════════════════════════════════════════
// PUB/SUB — Real-time Layer
// ═══════════════════════════════════════════════════════════════

let _pubClient: RedisClientType | null = null;
let _subClient: RedisClientType | null = null;

/**
 * Get dedicated PUBLISH client.
 * Separate from main client because pub/sub requires dedicated connections.
 */
export async function getPublisher(): Promise<RedisClientType> {
  if (_pubClient && _pubClient.isOpen) return _pubClient;

  _pubClient = createClient({ url: VALKEY_URL }) as RedisClientType;
  _pubClient.on("error", (err: Error) => {
    console.warn(`[Valkey:PUB] Error: ${err.message}`);
  });
  await _pubClient.connect();
  return _pubClient;
}

/**
 * Get dedicated SUBSCRIBE client.
 */
export async function getSubscriber(): Promise<RedisClientType> {
  if (_subClient && _subClient.isOpen) return _subClient;

  _subClient = createClient({ url: VALKEY_URL }) as RedisClientType;
  _subClient.on("error", (err: Error) => {
    console.warn(`[Valkey:SUB] Error: ${err.message}`);
  });
  await _subClient.connect();
  return _subClient;
}

/**
 * Publish a message to a channel.
 * Used by the data layer to broadcast mutations.
 *
 * Without Valkey: it is delivered to the subscribers of THIS process and, via
 * `pg_notify('kitsuden_bus', …)`, to those of the other replicas (see
 * `busWithoutValkey`). A message that does not fit in a NOTIFY (8,000 bytes) only
 * reaches this process, and a warning is logged.
 *
 * @param channel Channel name (e.g., "table:matches", "entry:abc123")
 * @param message JSON-serializable payload
 */
export async function publish(channel: string, message: unknown): Promise<void> {
  if (!valkeyConfigured()) {
    await busWithoutValkey.publish(channel, JSON.stringify(message));
    return;
  }
  try {
    const pub = await getPublisher();
    await pub.publish(channel, JSON.stringify(message));
  } catch (err: unknown) {
    const message_err = err instanceof Error ? err.message : String(err);
    console.warn(`[Valkey:PUB] Failed to publish to ${channel}: ${message_err}`);
  }
}

/**
 * Subscribe to a channel pattern.
 * Returns an unsubscribe function.
 *
 * @param pattern Channel pattern (supports wildcards: "table:*")
 * @param callback Function to call when message received
 */
export async function subscribe(
  pattern: string,
  callback: (channel: string, message: string) => void
): Promise<() => Promise<void>> {
  if (!valkeyConfigured()) return busWithoutValkey.subscribe(pattern, callback);

  const sub = await getSubscriber();

  if (pattern.includes("*")) {
    await sub.pSubscribe(pattern, (message: string, channel: string) => {
      callback(channel, message);
    });
    return async () => {
      await sub.pUnsubscribe(pattern);
    };
  } else {
    await sub.subscribe(pattern, (message: string, channel: string) => {
      callback(channel, message);
    });
    return async () => {
      await sub.unsubscribe(pattern);
    };
  }
}

// ── The bus without Valkey: the process + LISTEN/NOTIFY ────────

type Subscriber = { re: RegExp; fn: (channel: string, message: string) => void };

const BUS_CHANNEL = "kitsuden_bus";
/** What really fits in a NOTIFY (the limit is 8000 bytes including the channel). */
const MAX_NOTIFY_BYTES = 7900;

/** A Valkey pattern (`*`, `?`) as an anchored regular expression. */
function patternToRegex(pattern: string): RegExp {
  const escapado = pattern
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return /[A-Za-z0-9_:\-]/.test(ch) ? ch : `\\${ch}`;
    })
    .join("");
  return new RegExp(`^${escapado}$`);
}

export const busWithoutValkey = (() => {
  const subscribers = new Set<Subscriber>();
  const instance = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  let listening: Promise<unknown> | null = null;
  let sizeWarning = false;

  function deliver(channel: string, message: string): void {
    for (const s of subscribers) {
      if (!s.re.test(channel)) continue;
      try {
        s.fn(channel, message);
      } catch (err) {
        console.warn(`[bus] a subscriber of ${channel} failed: ${String(err)}`);
      }
    }
  }

  async function listenToOtherReplicas(): Promise<void> {
    const { listen } = await import("./postgres-listen");
    await listen(BUS_CHANNEL, (payload) => {
      try {
        const m = JSON.parse(payload) as { o?: string; c?: string; m?: string };
        if (m.o === instance || typeof m.c !== "string" || typeof m.m !== "string") return;
        deliver(m.c, m.m);
      } catch {
        /* a foreign or broken notification: ignored */
      }
    });
  }

  return {
    async publish(channel: string, message: string): Promise<void> {
      deliver(channel, message);
      const about = JSON.stringify({ o: instance, c: channel, m: message });
      if (Buffer.byteLength(about) > MAX_NOTIFY_BYTES) {
        if (!sizeWarning) {
          sizeWarning = true;
          console.warn(
            `[bus] message from ${channel} too large for NOTIFY: it only reaches this process (configure Valkey if there are several replicas)`
          );
        }
        return;
      }
      try {
        const { db, isPgMem, isLiteMode } = await import("../db");
        if (isPgMem || isLiteMode) return;
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`SELECT pg_notify(${BUS_CHANNEL}, ${about})`);
      } catch (err) {
        console.warn(`[bus] NOTIFY failed (${channel}): ${String(err)}`);
      }
    },

    async subscribe(
      pattern: string,
      fn: (channel: string, message: string) => void
    ): Promise<() => Promise<void>> {
      const s: Subscriber = { re: patternToRegex(pattern), fn };
      subscribers.add(s);
      listening ??= listenToOtherReplicas().catch((err: unknown) => {
        listening = null;
        console.warn(`[bus] no Postgres LISTEN: this process only (${String(err)})`);
      });
      return async () => {
        subscribers.delete(s);
      };
    },
  };
})();

// ═══════════════════════════════════════════════════════════════
// Leaderboard Helpers (Sorted Sets)
// ═══════════════════════════════════════════════════════════════

export async function updateLeaderboardScore(
  leaderboard: string,
  userId: string,
  score: number
): Promise<void> {
  const client = await getValkeyClient();
  await client.zAdd(leaderboard, [{ score, value: userId }], { GT: true });
}

export async function getLeaderboardTop(
  leaderboard: string,
  count = 10
): Promise<Array<{ userId: string; score: number; rank: number }>> {
  const client = await getValkeyClient();
  const results = await client.zRangeWithScores(leaderboard, 0, count - 1, {
    REV: true,
  });

  return results.map((entry, idx) => ({
    userId: entry.value,
    score: entry.score,
    rank: idx + 1,
  }));
}

export async function getLeaderboardRank(
  leaderboard: string,
  userId: string
): Promise<{ rank: number; score: number } | null> {
  const client = await getValkeyClient();
  const rank = await client.zRevRank(leaderboard, userId);
  if (rank === null) return null;

  const score = await client.zScore(leaderboard, userId);
  return { rank: (rank as number) + 1, score: score ?? 0 };
}

// ── Cache Helpers ──────────────────────────────────────────────

export async function cacheGet(key: string): Promise<string | null> {
  if (!valkeyConfigured()) return memoryGet(key);
  const client = await getValkeyClient();
  const value = await client.get(key);
  return value as string | null;
}

export async function cacheSet(key: string, value: string, ttlSeconds = 300): Promise<void> {
  if (!valkeyConfigured()) {
    memorySet(key, value, ttlSeconds);
    return;
  }
  const client = await getValkeyClient();
  await client.set(key, value, { EX: ttlSeconds });
}

// ── Shutdown ───────────────────────────────────────────────────

export async function closeValkey(): Promise<void> {
  const closes: Promise<void>[] = [];

  if (_client?.isOpen)
    closes.push(
      _client.quit().then(() => {
        _client = null;
      })
    );
  if (_pubClient?.isOpen)
    closes.push(
      _pubClient.quit().then(() => {
        _pubClient = null;
      })
    );
  if (_subClient?.isOpen)
    closes.push(
      _subClient.quit().then(() => {
        _subClient = null;
      })
    );

  await Promise.all(closes);
}
