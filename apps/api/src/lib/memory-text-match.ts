/**
 * Text search over agent memories
 * ============================================================================
 *
 * `POST /api/agent/memory/search` takes a `query`. The match runs in SQL, inside the
 * WHERE, so `limit`/`offset` page through the matches: filtering the first page in
 * JavaScript (as it once did) missed every match outside it.
 */
import { or, sql } from "drizzle-orm";

import { agentMemory } from "../db/schema-core";

/** Escapes LIKE's wildcards and its escape character (`\`, Postgres' default). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Case-insensitive substring match on key, summary and content. `%`, `_` and `\` in
 * the query are literal characters, not wildcards.
 */
export function memoryTextMatch(query: string) {
  const pattern = `%${escapeLike(query)}%`;
  return or(
    sql`${agentMemory.key} ILIKE ${pattern}`,
    sql`${agentMemory.summary} ILIKE ${pattern}`,
    sql`${agentMemory.content}::text ILIKE ${pattern}`
  );
}
