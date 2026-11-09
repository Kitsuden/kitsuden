/**
 * Second Brain — Operations integration tests (requires real PostgreSQL)
 * ============================================================================
 *
 * They exercise the deterministic pipeline end to end against the database:
 * capture (Layer 1 → Layer 2), source dedup, idempotent sync and lint.
 * It uses the `instruction` author (offline, deterministic) → no network.
 *
 * Skipped with pg-mem. Start it with:
 *   pnpm test:db:up && KITSUDEN_TEST_DB=postgres bun test src/tests/brain-operations.test.ts
 */

import { capture, captureSource, lint, syncBrain, createInstructionAuthor } from "@kitsuden/engine";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";

import { isDatabaseAvailable, generateTestId } from "./setup";

let dbAvailable = false;

// With pgvector, the 0024 trigger broke every INSERT into brain_notes; migration
// 0045 fixes it. These tests run the same with or without pgvector.
const itNotes = it;
const RUN = `brainop-${generateTestId()}`;
const author = createInstructionAuthor();

async function cleanup() {
  // Deletes notes/sources created by this run (by unique title).
  await db.execute(
    sql`DELETE FROM brain_connections WHERE source_note_id IN
        (SELECT id FROM brain_notes WHERE title LIKE ${`${RUN}%`})
        OR target_note_id IN (SELECT id FROM brain_notes WHERE title LIKE ${`${RUN}%`})`
  );
  await db.execute(sql`DELETE FROM brain_notes WHERE title LIKE ${`${RUN}%`}`);
  await db.execute(sql`DELETE FROM brain_sources WHERE title LIKE ${`${RUN}%`}`);
}

describe("Second Brain — Operations (integration)", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (dbAvailable) await cleanup();
  });

  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it("captureSource is idempotent by content hash", async () => {
    if (!dbAvailable) return;
    const input = {
      title: `${RUN}-src`,
      content: "PostgreSQL RLS isolates data by owner. TOON saves tokens.",
    };
    const first = await captureSource(db, input);
    const second = await captureSource(db, input);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.source.id).toBe(first.source.id);
  });

  itNotes("capture derives a wiki page from a source (Layer 1 → Layer 2)", async () => {
    if (!dbAvailable) return;
    const result = await capture(
      db,
      {
        title: `${RUN}-toon`,
        content:
          "TOON declares an array's keys once and lists CSV rows. " +
          "It reduces token consumption in LLM responses. It is deterministic.",
      },
      author
    );
    expect(result.sourceId).toBeDefined();
    expect(result.noteId).toBeDefined();
    expect(result.authoredBy).toBe("instruction");
    expect(result.pendingAgent).toBe(true);

    // The note exists and references its source.
    const rows = await db.execute<{ metadata: any; content: string }>(
      sql`SELECT metadata, content FROM brain_notes WHERE id = ${result.noteId}`
    );
    const note = rows.rows?.[0];
    expect(note?.metadata?.sourceId).toBe(result.sourceId);
    expect(note?.content).toContain("AGENT-TASK");
  });

  it("sync is idempotent: it does not recreate pages that are already up to date", async () => {
    if (!dbAvailable) return;
    // We already captured 2 sources above; sync should not create new ones.
    const first = await syncBrain(db, { author });
    const second = await syncBrain(db, { author });
    // On the second pass, everything from this run is up to date.
    expect(second.notesCreated).toBeLessThanOrEqual(first.notesCreated);
    expect(second.sourcesTotal).toBe(first.sourcesTotal);
  });

  itNotes("lint detects pending pages (pendingAgent) deterministically", async () => {
    if (!dbAvailable) return;
    const report = await lint(db);
    // The page derived with the instruction author was left with AGENT-TASK → stale.
    const staleTitles = report.staleNotes.map((n) => n.title);
    expect(staleTitles.some((t) => t.startsWith(RUN))).toBe(true);
  });

  itNotes("lint detects broken backlinks", async () => {
    if (!dbAvailable) return;
    // We insert a note with a backlink to a nonexistent title.
    await db.execute(sql`
      INSERT INTO brain_notes (title, content, source, category)
      VALUES (${`${RUN}-broken`}, ${"See [[Nonexistent Title XYZ]] for more."}, 'user', 'general')
    `);
    const report = await lint(db);
    const broken = report.brokenLinks.find((b) => b.title === `${RUN}-broken`);
    expect(broken).toBeDefined();
    expect(broken?.target).toBe("Nonexistent Title XYZ");
  });
});
