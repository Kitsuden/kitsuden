/**
 * Conditions for operations that WRITE
 * ============================================================================
 *
 * A single place where the WHERE of an UPDATE, a DELETE or an UPSERT is built
 * from an `id` and/or a `where` object. It exists because the two batch
 * implementations did it on their own and each had its own hole.
 *
 * The three rules, in order of severity:
 *
 *   1. WITHOUT CONDITIONS IT THROWS. A `where: {}` left the statement without
 *      a WHERE, and an UPDATE or DELETE without WHERE hits the ENTIRE TABLE.
 *      It is not a rare case: `{}` is what arrives when a client builds the
 *      filter dynamically and finds nothing to put in it.
 *
 *   2. Conditions are ACCUMULATED and `.where()` is called once. In Drizzle,
 *      chaining two `.where()` does not add them up: the second replaces the
 *      first. A two-field `where` filtered only by the last one, and combined
 *      with an `id` the id was lost.
 *
 *   3. A field that does not exist in the table THROWS instead of being
 *      ignored. Ignoring it widens the scope of the write without anyone
 *      noticing.
 */

import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export function writeCondition(
  table: PgTable,
  id: unknown,
  where: Record<string, unknown> | undefined,
  operation: string
): SQL {
  const conditions: SQL[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing columns by name at runtime
  const columns = table as any;

  if (id !== undefined && id !== null && id !== "") {
    if (!columns.id) {
      throw new Error(`${operation} received an id but the table has no 'id' column`);
    }
    conditions.push(eq(columns.id, id));
  }

  for (const [field, value] of Object.entries(where ?? {})) {
    if (!columns[field]) {
      throw new Error(`${operation}: the table has no column '${field}'`);
    }
    conditions.push(eq(columns[field], value));
  }

  if (conditions.length === 0) {
    throw new Error(`${operation} needs an id or a where with at least one field`);
  }

  return conditions.length === 1 ? conditions[0]! : and(...conditions)!;
}

/**
 * Equality against an ENUM column with a value that comes from OUTSIDE.
 * ============================================================================
 *
 * The pattern it replaces was repeated 25 times in 15 files:
 *
 *     const status = c.req.query("status");
 *     if (status) conditions.push(eq(table.status, status as any));
 *
 * That `as any` is not a typing oversight: it means nobody checks that the text
 * belongs to the enum. And since it is a PostgreSQL enum, the query does not
 * return zero rows — it FAILS: `invalid input value for enum X: "whatever"`. So
 * a typo in a URL parameter produces a **500**, and the message publishes the
 * internal name of the type.
 *
 * Here the value is checked against `enumValues`, which the column itself
 * carries. There is no list to maintain in parallel: if a status is added to
 * the schema tomorrow, this filter accepts it on its own.
 *
 * It returns `undefined` when the value does not belong, and `undefined` is
 * exactly what Drizzle's `and(...)` discards — so the filter is simply not
 * applied, just as the rest of these routes do with a parameter they do not
 * recognize. A client that makes a mistake does not bring the request down.
 *
 * If you prefer to reject instead of ignore, use the result:
 *
 *     const f = eqEnum(table.status, status);
 *     if (status && !f) return c.json({ error: "invalid status" }, 400);
 */
export function eqEnum(column: PgColumn, value: unknown): SQL | undefined {
  if (typeof value !== "string" || value === "") return undefined;

  const valid = (column as PgColumn & { enumValues?: readonly string[] }).enumValues;
  // Without `enumValues` it is not an enum column: it is compared as is, which is
  // correct for a `text`. Returning undefined here would silence a
  // legitimate filter.
  if (!valid) return eq(column, value);

  return valid.includes(value) ? eq(column, value) : undefined;
}
