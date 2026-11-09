/**
 * brain_notes with pgvector (migration 0045).
 *
 * The 0024 trigger did `NEW.embedding::VECTOR(384)` and Postgres has no
 * cast from jsonb to vector: with pgvector EVERY insert into brain_notes failed,
 * even without an embedding. Without pgvector (or with pg-mem) this file checks
 * nothing: the failure only exists with the extension and the `embedding_vector` column.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";

import { isDatabaseAvailable } from "./setup";

type Row = Record<string, unknown>;
const rows = (r: unknown) => ((r as { rows?: Row[] }).rows ?? []) as Row[];

async function hasPgvector(): Promise<boolean> {
  if (!(await isDatabaseAvailable())) return false;
  const r = await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'brain_notes' AND column_name = 'embedding_vector') AS si
  `);
  return rows(r)[0]?.si === true;
}

const withPgvector = await hasPgvector();
const PREFIX = `pgvector-0045-${Date.now()}`;

describe("brain_notes with pgvector", () => {
  afterAll(async () => {
    if (withPgvector)
      await db.execute(sql`DELETE FROM brain_notes WHERE title LIKE ${PREFIX + "%"}`);
  });

  it.skipIf(!withPgvector)(
    "an insert without an embedding works and leaves embedding_vector NULL",
    async () => {
      const r = await db.execute(sql`
      INSERT INTO brain_notes (title, content) VALUES (${PREFIX + "-empty"}, 'x')
      RETURNING embedding_vector IS NULL AS nullable
    `);
      expect(rows(r)[0]?.nullable).toBe(true);
    }
  );

  it.skipIf(!withPgvector)("a 384-dimension embedding is copied to embedding_vector", async () => {
    const embedding = JSON.stringify(Array.from({ length: 384 }, (_, i) => i / 384));
    const r = await db.execute(sql`
      INSERT INTO brain_notes (title, content, embedding)
      VALUES (${PREFIX + "-384"}, 'x', ${embedding}::jsonb)
      RETURNING vector_dims(embedding_vector) AS dims
    `);
    expect(Number(rows(r)[0]?.dims)).toBe(384);
  });

  it.skipIf(!withPgvector)(
    "an embedding of another dimension does not break the write",
    async () => {
      const r = await db.execute(sql`
      INSERT INTO brain_notes (title, content, embedding)
      VALUES (${PREFIX + "-3"}, 'x', '[1,2,3]'::jsonb)
      RETURNING embedding_vector IS NULL AS nullable
    `);
      expect(rows(r)[0]?.nullable).toBe(true);
    }
  );
});
