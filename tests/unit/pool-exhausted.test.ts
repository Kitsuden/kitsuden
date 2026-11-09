/**
 * Postgres pool exhausted → 503 + Retry-After, not 500.
 *
 * Under load, `GET /api/blog` answered 500: pg-pool threw «timeout exceeded
 * when trying to connect» and the kon's `catch` returned its own 500. Here a
 * REAL `pg.Pool` is used against a TCP server that accepts and does not answer
 * (like a saturated Postgres): `connect` times out and the request, even though
 * the handler catches the error and responds 500, comes out as 503 with Retry-After.
 */
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";

import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type * as Pg from "../../apps/api/node_modules/@types/pg";
import {
  poolConfiguration,
  isPoolExhausted,
  poolExhaustedTo503,
  POOL_RETRY_AFTER_S,
  watchPool,
} from "../../apps/api/src/lib/pool-exhausted";

// `pg` is a dependency of apps/api, not of the root: it is loaded from there, with its types.
const pg = createRequire(resolve(__dirname, "../../apps/api/package.json"))("pg") as typeof Pg;

let server: Server;
const sockets: Socket[] = [];
let port = 0;

beforeAll(async () => {
  server = createServer((s) => sockets.push(s)); // accepts and stays silent
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((ok) => server.close(ok));
});

function appWithPool() {
  const pool = watchPool(
    new pg.Pool({
      connectionString: `postgresql://nobody@127.0.0.1:${port}/none`,
      max: 1,
      connectionTimeoutMillis: 150,
    })
  );
  const app = new Hono();
  app.use("*", poolExhaustedTo503());
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "https://example.test");
    await next();
  });
  // Like the kons: catches and responds 500 on its own.
  app.get("/api/blog", async (c) => {
    try {
      await pool.query("SELECT 1");
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Failed to fetch posts" }, 500);
    }
  });
  // Uncaught: reaches onError.
  app.get("/api/no-catch", async (c) => {
    await pool.query("SELECT 1");
    return c.json({ ok: true });
  });
  app.onError((_err, c) => c.json({ error: "Internal Server Error" }, 500));
  // A 500 unrelated to the pool is still a 500.
  app.get("/api/broken", (c) => c.json({ error: "x" }, 500));
  return { app, pool };
}

describe("pool exhausted", () => {
  it("a kon that catches the error and responds 500 comes out as 503 + Retry-After", async () => {
    const { app, pool } = appWithPool();
    const r = await app.request("/api/blog");
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe(String(POOL_RETRY_AFTER_S));
    // Keeps the headers already set (CORS): otherwise the browser cannot read it
    expect(r.headers.get("access-control-allow-origin")).toBe("https://example.test");
    expect(await r.json()).toMatchObject({ error: "Service Unavailable" });
    await pool.end().catch(() => {});
  });

  it("an uncaught error (onError) too", async () => {
    const { app, pool } = appWithPool();
    expect((await app.request("/api/no-catch")).status).toBe(503);
    await pool.end().catch(() => {});
  });

  it("a 500 that does not come from the pool is left alone", async () => {
    const { app, pool } = appWithPool();
    expect((await app.request("/api/broken")).status).toBe(500);
    await pool.end().catch(() => {});
  });

  it("recognizes both pg-pool messages, also wrapped in `cause`", () => {
    expect(isPoolExhausted(new Error("timeout exceeded when trying to connect"))).toBe(true);
    const wrappedItem = new Error("Failed query: select ...", {
      cause: new Error("Connection terminated due to connection timeout"),
    });
    expect(isPoolExhausted(wrappedItem)).toBe(true);
    expect(isPoolExhausted(new Error("relation does not exist"))).toBe(false);
  });

  it("pool size and waits come from the environment, with default values", () => {
    expect(poolConfiguration({})).toEqual({
      max: 20,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    expect(
      poolConfiguration({ DB_POOL_MAX: "40", DB_POOL_CONNECTION_TIMEOUT_MS: "8000" })
    ).toMatchObject({
      max: 40,
      connectionTimeoutMillis: 8000,
    });
    // Garbage → the default value, not NaN
    expect(poolConfiguration({ DB_POOL_MAX: "lots" }).max).toBe(20);
  });
});
