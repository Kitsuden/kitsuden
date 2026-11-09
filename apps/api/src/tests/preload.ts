/**
 * Every API test starts with empty rate-limit counters
 * ============================================================================
 *
 * The integration suite runs in ONE process against one test Valkey, and requests
 * made with `app.request()` have no socket: unless a test sets an IP, they all count
 * as the same client. The limiter's buckets are per minute, so whether the suite hit
 * a 429 depended on its speed: on Windows a file took long enough for the window to
 * pass, on the Linux CI 73 files ran in 32 s and 28 tests got 429s that had
 * nothing to do with them. The tests that expect a 429 make all their requests
 * inside one test, so clearing before each test keeps them meaningful.
 *
 * Loaded by apps/api/bunfig.toml. It imports nothing from the API (the unit tests
 * replace modules with `mock.module`), and only touches a Valkey when NODE_ENV is
 * `test`: never one that may hold anything else.
 */
import { afterAll, beforeEach } from "bun:test";
import { createClient } from "redis";

const url = process.env.VALKEY_URL || process.env.REDIS_URL;
let client: ReturnType<typeof createClient> | null = null;
let unavailable = false;

async function connected() {
  if (!url || process.env.NODE_ENV !== "test" || unavailable) return null;
  if (client) return client;
  try {
    const c = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    c.on("error", () => {});
    await c.connect();
    client = c;
    return c;
  } catch {
    unavailable = true; // no Valkey: the limiter counts in memory, per app
    return null;
  }
}

beforeEach(async () => {
  const c = await connected();
  if (!c) return;
  const keys: string[] = [];
  for await (const batch of c.scanIterator({ MATCH: "ratelimit:*", COUNT: 500 }))
    keys.push(...(Array.isArray(batch) ? batch : [batch]));
  if (keys.length) await c.del(keys);
});

afterAll(async () => {
  await client?.quit().catch(() => {});
});
