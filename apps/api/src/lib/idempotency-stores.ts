/**
 * Idempotency stores of the real API: Valkey and, as a fallback, Postgres.
 *
 * Kept apart from `idempotency.ts` so that the rule tests do not pull in
 * the database or Valkey connection. See the header of `idempotency.ts`.
 */
import { db } from "../db";

import {
  postgresStore,
  valkeyStore,
  type IdempotencyStore,
  type MinimalValkeyClient,
  type SqlQuery,
} from "./idempotency";
import { getValkeyClient } from "./valkey";

/** `pg.Pool` (node-postgres) and PGlite both expose `query(text, params) → { rows }`. */
const query: SqlQuery = async (text, parameters) => {
  const client = (
    db as unknown as {
      $client?: { query: (text: string, parameters: unknown[]) => Promise<unknown> };
    }
  ).$client;
  if (!client || typeof client.query !== "function") {
    throw new Error("The database does not expose a SQL client for the idempotency table");
  }
  const res = (await client.query(text, parameters)) as { rows?: Array<Record<string, unknown>> };
  return res.rows ?? [];
};

let cache: IdempotencyStore[] | null = null;

export function defaultStores(): IdempotencyStore[] {
  cache ??= [
    valkeyStore(async () => (await getValkeyClient()) as unknown as MinimalValkeyClient),
    postgresStore(query),
  ];
  return cache;
}
