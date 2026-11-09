/**
 * Postgres queue benchmark
 * ============================================================================
 *
 * The figure «2,000–5,000 jobs/s with SKIP LOCKED» was an assumption. This
 * measures it with the REAL schema, indexes and functions (migration 0056) on
 * the machine where it runs:
 *
 *   1. DISPATCH: N single inserts (each its own transaction, like a
 *      request) with C clients in parallel.
 *   2. CLAIM + CLOSE: W workers claiming batches of B with
 *      `kitsuden_queue_claim` and closing each job with
 *      `kitsuden_queue_complete` (the same as lib/queue.ts does, without a handler).
 *
 * Usage (ONLY against a test database: it deletes its benchmark queue):
 *
 *   DATABASE_URL=postgres://…/kitsuden_test bun run scripts/benchmark-queue.ts \
 *     --jobs=20000 --clients=8 --workers=4 --batch=50
 *
 * Prints jobs/s for each phase. What it says applies to THAT machine: it is not copied
 * into the documentation without saying where it was measured.
 */

import { randomUUID } from "node:crypto";

import pg from "pg";

const QUEUE = "benchmark-queue";

function arg(name: string, defaultValue: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  const n = Number(a?.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

const JOBS = arg("jobs", 10_000);
const CLIENTS = arg("clients", 8);
const WORKERS = arg("workers", 4);
const BATCH = arg("batch", 50);

const url = process.env.DATABASE_URL ?? "";
let baseName = "";
try {
  baseName = new URL(url).pathname.replace(/^\//, "");
} catch {
  /* below */
}
if (!/test|bench/i.test(baseName)) {
  console.error(
    "🛑 DATABASE_URL is not a test database (the name must contain 'test' or 'bench')."
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: Math.max(CLIENTS, WORKERS) + 2 });

async function dispatch(): Promise<number> {
  let next = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      const c = await pool.connect();
      try {
        while (next < JOBS) {
          next++;
          await c.query("BEGIN");
          await c.query(
            `INSERT INTO kitsuden_outbox (id, queue, name, payload) VALUES ($1, $2, 'bench', $3::jsonb)`,
            [randomUUID(), QUEUE, JSON.stringify({ n: next, to: "bench@example.com" })]
          );
          await c.query(`SELECT pg_notify('kitsuden_queue', $1)`, [QUEUE]);
          await c.query("COMMIT");
        }
      } finally {
        c.release();
      }
    })
  );
  return performance.now() - start;
}

async function processItem(): Promise<{ ms: number; facts: number }> {
  let facts = 0;
  const start = performance.now();
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, i) => {
      const w = `bench-${i}`;
      const c = await pool.connect();
      try {
        for (;;) {
          const r = await c.query(
            `SELECT id FROM kitsuden_queue_claim(ARRAY[$1]::text[], $2, 60, $3)`,
            [QUEUE, BATCH, w]
          );
          if (r.rows.length === 0) break;
          for (const row of r.rows) {
            await c.query(`SELECT kitsuden_queue_complete($1::uuid, $2)`, [row.id, w]);
          }
          facts += r.rows.length;
        }
      } finally {
        c.release();
      }
    })
  );
  return { ms: performance.now() - start, facts };
}

async function main(): Promise<void> {
  await pool.query(`DELETE FROM kitsuden_outbox WHERE queue = $1`, [QUEUE]);
  const { rows } = await pool.query(`SELECT version() AS v`);
  console.log(`Postgres: ${String(rows[0]?.v).split(",")[0]}`);
  console.log(`jobs=${JOBS} clients=${CLIENTS} workers=${WORKERS} batch=${BATCH}\n`);

  const msDispatch = await dispatch();
  console.log(
    `Dispatch (1 transaction per job): ${(JOBS / (msDispatch / 1000)).toFixed(0)} jobs/s (${msDispatch.toFixed(0)} ms)`
  );

  const { ms, facts } = await processItem();
  console.log(
    `Claim + close (SKIP LOCKED, no handler): ${(facts / (ms / 1000)).toFixed(0)} jobs/s (${facts} en ${ms.toFixed(0)} ms)`
  );

  await pool.query(`DELETE FROM kitsuden_outbox WHERE queue = $1`, [QUEUE]);
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
