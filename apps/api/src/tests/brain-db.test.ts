/**
 * KITSUDEN Brain — Integration Tests
 *
 * Tests brain notes, connections and semantic search against the real DB.
 */

import {
  upsertBrainNote,
  listBrainNotes,
  getBrainNote,
  deleteBrainNote,
  createBrainConnection,
  listBrainConnections,
  searchSimilarBrainNotes,
  buildKnowledgeGraph,
} from "@kitsuden/engine";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { db } from "../db";

import { isDatabaseAvailable, generateTestId } from "./setup";

let dbAvailable = false;

// With pgvector, the 0024 trigger broke every INSERT into brain_notes; migration
// 0045 fixes it. These tests run the same with or without pgvector.
const itNotes = it;

describe("KITSUDEN Brain DB Integration", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) {
      console.log("⚠️ Skipping Brain DB tests: real PostgreSQL not available");
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.execute(`DELETE FROM brain_connections`);
      await db.execute(`DELETE FROM brain_notes WHERE title LIKE 'Test Brain %'`);
    }
  });

  itNotes("creates and retrieves brain notes", async () => {
    if (!dbAvailable) return;

    const title = `Test Brain ${generateTestId()}`;
    const note = await upsertBrainNote(db, {
      title,
      content: "Testing brain note persistence",
      source: "user",
      category: "insight",
      tags: ["test"],
      importance: 80,
    });

    expect(note.id).toBeDefined();
    expect(note.title).toBe(title);
    expect(note.category).toBe("insight");

    const fetched = await getBrainNote(db, note.id);
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe(title);
  });

  itNotes("lists notes with filters", async () => {
    if (!dbAvailable) return;

    const notes = await listBrainNotes(db, { category: "insight", limit: 10 });
    expect(notes.length).toBeGreaterThan(0);
  });

  itNotes("finds similar notes", async () => {
    if (!dbAvailable) return;

    const id = generateTestId();
    const a = await upsertBrainNote(db, {
      title: `Test Brain Auth ${id}`,
      content: "user authentication and sessions",
      category: "insight",
    });
    const b = await upsertBrainNote(db, {
      title: `Test Brain Login ${id}`,
      content: "login form and session handling",
      category: "insight",
    });

    // The query shares whole words with both notes: the local embedding
    // is a bag of words with hash and trigrams, and with only «login session»
    // note A ended up at the edge of the threshold depending on the random id in the title.
    const similar = await searchSimilarBrainNotes(db, "user login session authentication", {
      limit: 5,
    });
    const ids = similar.map((n) => n.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  itNotes("creates connections and builds a knowledge graph", async () => {
    if (!dbAvailable) return;

    const id = generateTestId();
    const a = await upsertBrainNote(db, {
      title: `Test Brain Node A ${id}`,
      content: "node a",
      category: "general",
    });
    const b = await upsertBrainNote(db, {
      title: `Test Brain Node B ${id}`,
      content: "node b",
      category: "general",
    });

    await createBrainConnection(db, {
      sourceNoteId: a.id,
      targetNoteId: b.id,
      relationType: "depends_on",
      strength: 0.9,
    });

    const connections = await listBrainConnections(db, a.id);
    expect(connections.length).toBeGreaterThan(0);

    const allNotes = await listBrainNotes(db, { limit: 100 });
    const graph = buildKnowledgeGraph(allNotes, connections);
    expect(graph.nodes.some((n) => n.id === a.id)).toBe(true);
    expect(graph.nodes.some((n) => n.id === b.id)).toBe(true);
    expect(graph.edges.some((e) => e.source === a.id && e.target === b.id)).toBe(true);
  });

  itNotes("deletes notes and their connections", async () => {
    if (!dbAvailable) return;

    const note = await upsertBrainNote(db, {
      title: `Test Brain Delete ${generateTestId()}`,
      content: "to be deleted",
      category: "general",
    });

    const deleted = await deleteBrainNote(db, note.id);
    expect(deleted).toBe(true);
    expect(await getBrainNote(db, note.id)).toBeNull();
  });
});
