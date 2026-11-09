/**
 * Semantic search in defineModel, against Postgres with
 * pgvector: the generated migration creates the column and the HNSW index, creating a
 * row enqueues its embedding in the Postgres queue, the worker computes it, and
 * `search-<plural>` sorts by similarity respecting the owner filter.
 *
 * Without a configured provider, `generateEmbedding` gives a deterministic vector
 * (same text → same vector): enough to check the pipeline, not the meaning.
 */

import { field, defineModel, generateModelMigration, type KonContext } from "@kitsuden/shared";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

import { modelOperations, registerModelPolicies } from "../../../../packages/engine/src/models";
import { operationsRouter } from "../../../../packages/engine/src/operations";
import { runInRequestScope } from "../../../../packages/engine/src/request-scope";
import {
  theRequestDb,
  rlsTransaction,
  type TransactionalConnection,
} from "../../../../packages/engine/src/rls-request";
import { db } from "../db";
import { configureModelEmbeddings } from "../lib/model-embeddings";
import {
  pauseWorker,
  processPending,
  setRereadActor,
  setupWorkers,
  shutdownQueues,
} from "../lib/queue";
import { createTestKonContext } from "../lib/test-kon-context";

import { isDatabaseAvailable } from "./setup";

const KON = "kon-semtest";
const note = defineModel({
  name: "sem-note",
  table: "sem_test_notes",
  description: "A note with semantic search.",
  fields: { title: field.text({ max: 200, required: true }), body: field.longText() },
  access: { read: "owner", write: "owner" },
  semantics: { fields: ["title", "body"], dimensions: 8 },
});

let available = false;
const app = new Hono();

beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available) return;
  await db.execute(sql.raw(`DROP TABLE IF EXISTS sem_test_notes`));
  const migration = generateModelMigration(null, [note], { kon: "semtest" });
  await db.execute(sql.raw(migration.sql));

  registerModelPolicies(KON, [note]);
  const pass = async (
    c: { get: (k: never) => unknown; json: (b: unknown, s: number) => Response },
    next: () => Promise<void>
  ) => {
    if (!c.get("user" as never)) return c.json({ error: "Session required" }, 401);
    await next();
  };
  const ctx = createTestKonContext({
    db: { instance: theRequestDb(db) } as unknown as KonContext["db"],
    auth: {
      requireAuth: pass,
      optionalAuth: async (_c: unknown, next: () => Promise<void>) => next(),
    } as unknown as KonContext["auth"],
  });
  app.use("*", async (c, next) => {
    const id = c.req.header("x-user");
    c.set("user" as never, (id ? { id, role: "user" } : null) as never);
    await runInRequestScope({ requestId: "sem" }, () => next());
  });
  app.use("*", rlsTransaction(db as unknown as TransactionalConnection));
  app.route("/api/semtest", operationsRouter(KON, modelOperations(KON, note), ctx));

  configureModelEmbeddings();
  await setupWorkers();
  pauseWorker(true);
  // The test accounts do not exist in auth_users: the queue, which re-reads the
  // actor, would treat them as revoked (queue-postgres.test.ts tests that).
  setRereadActor(async (f) => ({
    ok: true,
    actor: f.user_id ? { id: String(f.user_id), role: "user" } : null,
  }));
});

afterAll(async () => {
  if (!available) return;
  await db.execute(sql`DELETE FROM kitsuden_outbox WHERE queue = 'kitsuden-embeddings'`);
  await db.execute(sql.raw(`DROP TABLE IF EXISTS sem_test_notes`));
  setRereadActor(null);
  await shutdownQueues();
});

async function create(user: string, title: string, body: string) {
  const res = await app.request("/api/semtest/sem-notes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify({ title, body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("semantic search in defineModel", () => {
  it("the migration creates the vector(8) column and the HNSW index", async () => {
    if (!available) return;
    const r = await db.execute(sql`
      SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
       WHERE a.attrelid = 'sem_test_notes'::regclass AND a.attname = 'embedding'`);
    expect((r.rows[0] as { type: string }).type).toBe("vector(8)");
    const i = await db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'sem_test_notes_embedding_idx'`
    );
    expect(String((i.rows[0] as { indexdef: string }).indexdef)).toContain("hnsw");
  });

  it("creating enqueues the embedding in the same transaction; the worker stores it", async () => {
    if (!available) return;
    const { id } = await create("ana", "red apple", "a fruit");
    const before = await db.execute(
      sql`SELECT embedding IS NULL AS empty FROM sem_test_notes WHERE id = ${id}::uuid`
    );
    expect((before.rows[0] as { empty: boolean }).empty).toBe(true);
    await processPending();
    const after = await db.execute(
      sql`SELECT embedding IS NULL AS empty FROM sem_test_notes WHERE id = ${id}::uuid`
    );
    expect((after.rows[0] as { empty: boolean }).empty).toBe(false);
  });

  it("search sorts by similarity and only sees the caller's own rows", async () => {
    if (!available) return;
    await create("ana", "blue car", "a vehicle");
    await create("luis", "red apple", "a fruit");
    await processPending();
    const res = await app.request(
      `/api/semtest/sem-notes/search?q=${encodeURIComponent("red apple a fruit")}&limit=5`,
      {
        headers: { "x-user": "ana" },
      }
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{ title: string; ownerId: string; score: number }>;
    };
    expect(data.every((f) => f.ownerId === "ana")).toBe(true);
    expect(data).toHaveLength(2);
    expect(data[0]?.title).toBe("red apple");
    expect(data[0]!.score).toBeGreaterThan(0.999);
    expect(data[0]!.score).toBeGreaterThan(data[1]!.score);
  });

  it("the /search route is not captured by /:id", async () => {
    if (!available) return;
    const res = await app.request(`/api/semtest/sem-notes/search?q=x`, {
      headers: { "x-user": "ana" },
    });
    expect(res.status).toBe(200);
  });

  it("without a query, 422; without a session, 401", async () => {
    if (!available) return;
    expect(
      (await app.request(`/api/semtest/sem-notes/search`, { headers: { "x-user": "ana" } })).status
    ).toBe(422);
    expect((await app.request(`/api/semtest/sem-notes/search?q=x`)).status).toBe(401);
  });
});
