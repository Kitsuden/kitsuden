/**
 * Text search over agent memories, on real Postgres (PGlite)
 * ============================================================================
 *
 * `POST /api/agent/memory/search` used to read one page (`limit`, 20 by default)
 * and filter it by the query in JavaScript: a memory that matched but was not in
 * that first page was never found. The match now runs in the WHERE, so the page is
 * taken from the matches. `%`, `_` and `\` in the query are literal.
 */

import { PGlite } from "@electric-sql/pglite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { agentMemory } from "../../apps/api/src/db/schema-core";
import { escapeLike, memoryTextMatch } from "../../apps/api/src/lib/memory-text-match";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

async function keysFor(query: string, limit = 20): Promise<string[]> {
  const rows = await db
    .select({ key: agentMemory.key })
    .from(agentMemory)
    .where(and(eq(agentMemory.agentId, "agent-1"), memoryTextMatch(query)))
    .orderBy(desc(agentMemory.importance))
    .limit(limit);
  return rows.map((r: { key: string }) => r.key);
}

beforeAll(async () => {
  const client = await PGlite.create();
  db = drizzle(client);
  await client.exec(`
    CREATE TABLE agent_memory (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      key TEXT,
      summary TEXT,
      content JSONB NOT NULL,
      importance INTEGER
    )`);
  // 30 important memories that do not match, then one that does, least important.
  for (let i = 0; i < 30; i++) {
    await client.query(
      `INSERT INTO agent_memory (agent_id, key, summary, content, importance) VALUES ($1,$2,$3,$4,$5)`,
      ["agent-1", `note-${i}`, "routine", JSON.stringify({ text: "nothing here" }), 100 - i]
    );
  }
  await client.query(
    `INSERT INTO agent_memory (agent_id, key, summary, content, importance) VALUES
       ('agent-1', 'invoice', NULL, '{"client":"Acme Corp"}', 1),
       ('agent-1', 'rate', '100% done', '{}', 1),
       ('agent-1', 'path', 'C:\\temp', '{}', 1),
       ('agent-2', 'other', 'Acme Corp too', '{}', 99)`
  );
});

describe("memoryTextMatch", () => {
  it("finds a match outside the first page of the unfiltered list", async () => {
    expect(await keysFor("acme")).toEqual(["invoice"]);
  });

  it("matches key, summary and content, ignoring case", async () => {
    expect(await keysFor("INVOICE")).toEqual(["invoice"]);
    expect(await keysFor("routine", 3)).toHaveLength(3);
    expect(await keysFor("corp")).toEqual(["invoice"]);
  });

  it("treats %, _ and \\ as literal characters", async () => {
    expect(await keysFor("%")).toEqual(["rate"]);
    expect(await keysFor("_")).toEqual([]);
    expect(await keysFor("\\")).toEqual(["path"]);
  });

  it("escapeLike escapes every wildcard and the escape character", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});
