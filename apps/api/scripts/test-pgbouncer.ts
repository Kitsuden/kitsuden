#!/usr/bin/env bun
/**
 * Kitsuden behind PgBouncer in TRANSACTION mode: the test
 * ============================================================================
 *
 *   pnpm test:db:up
 *   docker compose -f docker-compose.pgbouncer-test.yml --env-file .env.test up -d
 *   cd apps/api && bun --no-env-file scripts/test-pgbouncer.ts
 *
 * It uses PGBOUNCER_URL (by default port 6434 of docker-compose.pgbouncer-test.yml)
 * and the direct URL of the test database (`DATABASE_URL` from .env.test). Only
 * against databases whose name contains `test`.
 *
 * What it checks, with Kitsuden's REAL code (not an imitation):
 *
 *   1. Each request's RLS: N transactions at once, each with its own
 *      user (`set_config(…, true)` = SET LOCAL), over fewer server connections
 *      than transactions. Each sees ONLY its user, and when done
 *      nothing is left on the connection (a stray query sees the system).
 *   2. Drizzle's parameterized queries (UNNAMED statements of the
 *      extended protocol): they work.
 *   3. A NAMED prepared statement (Drizzle's `.prepare("x")`): with
 *      `MAX_PREPARED_STATEMENTS=0` it may fail or go to another connection. Kitsuden
 *      does not use them; whatever happens is reported.
 *   4. A session `SET` (without LOCAL) DOES leak to another client: that is why
 *      the whole RLS context goes with `set_config(…, true)`.
 *   5. LISTEN through PgBouncer does not receive the NOTIFYs; direct, it does. That is why
 *      the queue uses the direct `DATABASE_LISTEN_URL`.
 *   6. The queue: dispatch in one transaction and claim with SKIP LOCKED.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import {
  withLazyTransactions,
  theRequestDb,
  inRlsTransaction,
  type TransactionalConnection,
} from "../../../packages/engine/src/rls-request";

const DIRECT = process.env.DATABASE_URL ?? "";
const BOUNCER =
  process.env.PGBOUNCER_URL ??
  (() => {
    try {
      const u = new URL(DIRECT);
      u.port = process.env.PGBOUNCER_PORT ?? "6434";
      return u.toString();
    } catch {
      return "";
    }
  })();

for (const [name, url] of [
  ["DATABASE_URL", DIRECT],
  ["PGBOUNCER_URL", BOUNCER],
] as const) {
  let base = "";
  try {
    base = new URL(url).pathname.slice(1);
  } catch {
    /* below */
  }
  if (!/test/i.test(base)) {
    console.error(`🛑 ${name} does not point to a test database (the name must contain 'test').`);
    process.exit(2);
  }
}

let failures = 0;
function notes(ok: boolean, that: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${that}${detail ? ` — ${detail}` : ""}`);
}
function info(that: string, detail: string): void {
  console.log(`· ${that} — ${detail}`);
}

const poolBouncer = withLazyTransactions(new pg.Pool({ connectionString: BOUNCER, max: 20 }));
const dbBouncer = drizzle(poolBouncer);
const instance = theRequestDb(dbBouncer);

async function rows(query: Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  return ((await query) as { rows: Array<Record<string, unknown>> }).rows;
}

async function principal(): Promise<void> {
  // ── 1. RLS per request ───────────────────────────────────────────────────
  const N = 40;
  const seen = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      inRlsTransaction(
        dbBouncer as unknown as TransactionalConnection,
        { id: `u-${i}`, role: "user" },
        async () => {
          const before = await rows(
            instance.execute(sql`SELECT current_setting('app.current_user_id', true) AS u`)
          );
          await instance.execute(sql`SELECT pg_sleep(${Math.random() * 0.05})`);
          const after = await rows(
            instance.execute(sql`SELECT current_setting('app.current_user_id', true) AS u`)
          );
          return [before[0]?.u, after[0]?.u];
        }
      )
    )
  );
  const good = seen.every(([a, d], i) => a === `u-${i}` && d === `u-${i}`);
  notes(
    good,
    `RLS: ${N} transactions at once each see their own user`,
    good ? "" : JSON.stringify(seen.slice(0, 5))
  );
  const loose = await Promise.all(
    Array.from({ length: 10 }, () =>
      rows(dbBouncer.execute(sql`SELECT current_setting('app.current_user_id', true) AS u`))
    )
  );
  const clean = loose.every((f) => !f[0]?.u);
  notes(
    clean,
    "RLS: when done no context is left on the connection (SET LOCAL)",
    clean ? "" : JSON.stringify(loose.map((f) => f[0]?.u))
  );

  // ── 2. Parameterized queries (unnamed statements) ────────────────────────
  try {
    const r = await rows(dbBouncer.execute(sql`SELECT ${41}::int + 1 AS n, ${"hello"}::text AS t`));
    notes(
      r[0]?.n === 42 && r[0]?.t === "hello",
      "Drizzle: parameterized queries (extended protocol, unnamed)"
    );
  } catch (err) {
    notes(false, "Drizzle: parameterized queries", String(err));
  }

  // ── 3. Named prepared statement ──────────────────────────────────────────
  try {
    const c1 = await poolBouncer.connect();
    const c2 = await poolBouncer.connect();
    try {
      await c1.query({ name: "kitsuden_probe", text: "SELECT $1::int AS n", values: [1] });
      await c2.query({ name: "kitsuden_probe", text: "SELECT $1::int AS n", values: [2] });
      info(
        "NAMED prepared statements",
        "they work (PgBouncer ≥ 1.21 with MAX_PREPARED_STATEMENTS > 0, or luck); Kitsuden does not use them"
      );
    } finally {
      c1.release();
      c2.release();
    }
  } catch (err) {
    info(
      "NAMED prepared statements",
      `fail as expected with MAX_PREPARED_STATEMENTS=0 (${(err as Error).message.slice(0, 80)}); Kitsuden does not use them`
    );
  }

  // ── 4. A session SET leaks ───────────────────────────────────────────────
  await dbBouncer.execute(sql`SET app.kitsuden_probe_leak = 'leaked'`);
  const others = await Promise.all(
    Array.from({ length: 10 }, () =>
      rows(dbBouncer.execute(sql`SELECT current_setting('app.kitsuden_probe_leak', true) AS v`))
    )
  );
  const leak = others.some((f) => f[0]?.v === "leaked");
  info(
    "session SET (without LOCAL)",
    leak
      ? "LEAKS to other transactions: that is why Kitsuden uses set_config(…, true)"
      : "was not seen in this batch (it can happen anyway)"
  );
  await dbBouncer.execute(sql`RESET app.kitsuden_probe_leak`);

  // ── 5. LISTEN through PgBouncer vs direct ────────────────────────────────
  const listens = async (url: string): Promise<boolean> => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    let arrived = false;
    c.on("notification", () => (arrived = true));
    await c.query("LISTEN kitsuden_probe_bouncer");
    const issuer = new pg.Client({ connectionString: DIRECT });
    await issuer.connect();
    await issuer.query("NOTIFY kitsuden_probe_bouncer, 'x'");
    await issuer.end();
    await new Promise((r) => setTimeout(r, 500));
    await c.end();
    return arrived;
  };
  const direct = await listens(DIRECT);
  const viaBouncer = await listens(BOUNCER).catch(() => false);
  notes(direct, "direct LISTEN to Postgres receives the NOTIFY");
  info(
    "LISTEN through PgBouncer",
    viaBouncer
      ? "arrived in this test, but it is not reliable in transaction mode"
      : "does NOT arrive: that is why the queue uses the direct DATABASE_LISTEN_URL"
  );

  // ── 6. The queue: atomic dispatch and SKIP LOCKED ────────────────────────
  try {
    const queue = `pgbouncer-probe-${Date.now()}`;
    await inRlsTransaction(dbBouncer as unknown as TransactionalConnection, null, async () => {
      for (let i = 0; i < 6; i++) {
        await instance.execute(
          sql`INSERT INTO kitsuden_outbox (id, queue, name) VALUES (gen_random_uuid(), ${queue}, 'x')`
        );
      }
    });
    const claim = (w: string) =>
      rows(
        dbBouncer.execute(
          sql`SELECT id FROM kitsuden_queue_claim(ARRAY[${queue}]::text[], 4, 60, ${w})`
        )
      );
    const [a, b] = await Promise.all([claim("a"), claim("b")]);
    const ids = [...a, ...b].map((f) => f.id);
    notes(
      ids.length === 6 && new Set(ids).size === 6,
      "Queue: 6 jobs, two claims at once, none repeated"
    );
    await dbBouncer.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = ${queue}`);
  } catch (err) {
    notes(false, "Queue through PgBouncer", String((err as Error).message));
  }
}

principal()
  .catch((err) => {
    notes(false, "The test could not finish", String((err as Error)?.message ?? err));
  })
  .finally(async () => {
    await poolBouncer.end().catch(() => {});
    console.log(
      failures === 0 ? "\nPgBouncer (transaction): all correct." : `\n${failures} check(s) failed.`
    );
    process.exit(failures === 0 ? 0 : 1);
  });
