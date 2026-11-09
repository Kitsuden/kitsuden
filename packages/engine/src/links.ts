/**
 * ============================================================================
 * POLYMORPHIC LINKS BETWEEN ENTITIES
 * ============================================================================
 *
 * The edge that was missing between kons. Until now all relations were
 * foreign keys WITHIN a kon, so a CRM contact, an esports player and a member
 * were three rows with no way to say "they are the same person".
 *
 * ── THE RULE THIS MODULE FOLLOWS ───────────────────────────────────────────
 *
 * Integration by SHAPE, not by import — the pattern already used in
 * `kon-members`, where `grantFromSubscription` accepts a `SubscriptionLike`
 * instead of importing `kon-payments`.
 *
 * Here that means the engine never knows a concrete table. A link is a
 * `{ type, id }` pair of free text, and resolving it to real rows is done by
 * WHOEVER HAS THEM, passing their own loaders. This way `kon-ecommerce` can
 * link an order to a contact without depending on `kon-crm`, and work the same
 * if the CRM is not installed.
 *
 * ── WHY BOTH DIRECTIONS ARE READ ───────────────────────────────────────────
 *
 * `same_person` has no direction. If reading only looked at `from`, whoever
 * stored the edge the other way round would get zero results with no error —
 * the worst kind of failure. `neighbors()` queries both sides and always
 * returns "the other end", so whoever writes does not have to remember the direction.
 *
 * ── ORPHANS ────────────────────────────────────────────────────────────────
 *
 * There are no foreign keys: Postgres cannot point at a target whose type is
 * decided at runtime. Deleting a row leaves its edges dangling.
 *
 * They are tolerated and filtered out on resolution: if the loader does not
 * return the row, the neighbor disappears from the result. This was preferred
 * over putting triggers on every table, because a trigger forgotten when
 * creating a new table is a silent leak, and an orphan edge is only garbage.
 * Kons that want to be clean call `unlinkAll()` when deleting.
 */

import { sql } from "drizzle-orm";

import { resolveExecutor } from "./request-scope";

/** Reference to a row of any table in the system. */
export interface EntityRef {
  /** Logical name of the type. By convention, the table's: `crm_contacts`. */
  type: string;
  id: string;
}

export interface LinkRow extends EntityRef {
  /** What the edge means with respect to the queried entity. */
  relation: string;
  metadata: Record<string, unknown>;
  linkId: string;
  createdAt: Date;
}

export interface LinkOptions {
  relation?: string;
  metadata?: Record<string, unknown>;
  /** Owner, for RLS isolation. Without it, the link belongs to the system. */
  ownerId?: string | null;
  createdBy?: string | null;
}

export interface NeighborQuery {
  /** Filters by the edge's meaning. */
  relation?: string;
  /** Filters by the type of the other end. */
  type?: string;
  limit?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = { execute: (q: any) => Promise<any> };

function rowsValue<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as T[];
}

function requireRef(r: EntityRef, which: string): void {
  if (!r?.type || !r?.id) {
    throw new Error(`links: ${which} needs { type, id } and got ${JSON.stringify(r)}`);
  }
}

/**
 * Creates an edge. Idempotent: repeating the same one creates no duplicates.
 *
 * Uniqueness is guaranteed by an index, not a prior check — another request
 * fits between the SELECT and the INSERT, and two identical edges duplicate
 * results in every later read.
 */
export async function link(
  from: EntityRef,
  to: EntityRef,
  options: LinkOptions = {},
  db?: Executor
): Promise<void> {
  requireRef(from, "from");
  requireRef(to, "to");

  if (from.type === to.type && from.id === to.id) {
    throw new Error("links: an entity cannot be linked to itself");
  }

  const ex = db ?? resolveExecutor<Executor>(undefined as unknown as Executor);
  const relation = options.relation ?? "related";

  await ex.execute(sql`
    INSERT INTO kitsuden_links (from_type, from_id, to_type, to_id, relation, metadata, owner_id, created_by)
    VALUES (${from.type}, ${from.id}, ${to.type}, ${to.id}, ${relation},
            ${JSON.stringify(options.metadata ?? {})}::jsonb,
            ${options.ownerId ?? null}, ${options.createdBy ?? null})
    ON CONFLICT (from_type, from_id, to_type, to_id, relation) DO NOTHING
  `);
}

/** Deletes a specific edge, in either direction. */
export async function unlink(
  a: EntityRef,
  b: EntityRef,
  relation?: string,
  db?: Executor
): Promise<void> {
  requireRef(a, "a");
  requireRef(b, "b");
  const ex = db ?? resolveExecutor<Executor>(undefined as unknown as Executor);

  await ex.execute(sql`
    DELETE FROM kitsuden_links
    WHERE (
      (from_type = ${a.type} AND from_id = ${a.id} AND to_type = ${b.type} AND to_id = ${b.id})
      OR
      (from_type = ${b.type} AND from_id = ${b.id} AND to_type = ${a.type} AND to_id = ${a.id})
    )
    ${relation ? sql`AND relation = ${relation}` : sql``}
  `);
}

/**
 * Deletes ALL of an entity's edges, in both directions.
 *
 * It is what a kon should call when deleting a row if it does not want to leave orphans.
 * It is not mandatory —the system tolerates them— but it is cheap and keeps the
 * table from growing with garbage.
 */
export async function unlinkAll(entity: EntityRef, db?: Executor): Promise<void> {
  requireRef(entity, "entity");
  const ex = db ?? resolveExecutor<Executor>(undefined as unknown as Executor);

  await ex.execute(sql`
    DELETE FROM kitsuden_links
    WHERE (from_type = ${entity.type} AND from_id = ${entity.id})
       OR (to_type = ${entity.type} AND to_id = ${entity.id})
  `);
}

/**
 * Neighbors of an entity, looking in BOTH directions and always returning the
 * other end.
 *
 * Whoever stored the edge does not have to remember which direction they used.
 */
export async function neighbors(
  entity: EntityRef,
  query: NeighborQuery = {},
  db?: Executor
): Promise<LinkRow[]> {
  requireRef(entity, "entity");
  const ex = db ?? resolveExecutor<Executor>(undefined as unknown as Executor);

  // The CASE flips each row so the result is homogeneous: always
  // "what is on the other side", however it was stored.
  const res = await ex.execute(sql`
    SELECT
      id AS "linkId",
      CASE WHEN from_type = ${entity.type} AND from_id = ${entity.id}
           THEN to_type ELSE from_type END AS "type",
      CASE WHEN from_type = ${entity.type} AND from_id = ${entity.id}
           THEN to_id ELSE from_id END AS "id",
      relation,
      metadata,
      created_at AS "createdAt"
    FROM kitsuden_links
    WHERE (
      (from_type = ${entity.type} AND from_id = ${entity.id})
      OR (to_type = ${entity.type} AND to_id = ${entity.id})
    )
    ${query.relation ? sql`AND relation = ${query.relation}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${query.limit ?? 500}
  `);

  const all = rowsValue<LinkRow>(res);
  // The type filter goes after the CASE: in SQL the
  // condition would have to be repeated for both directions and it becomes unreadable for a null
  // saving at these cardinalities.
  return query.type ? all.filter((l) => l.type === query.type) : all;
}

/**
 * Resolves neighbors to real rows using loaders supplied by the caller.
 *
 * The engine does NOT know any table: it receives one loader per type. A type
 * without a loader is skipped —it is a kon that is not installed, not an
 * error— and a row the loader does not return disappears, which is how orphans
 * are filtered and how the destination table's RLS still rules: if you cannot
 * see it, the loader does not give it to you.
 */
export async function resolveNeighbors<T>(
  neighbors: LinkRow[],
  loaders: Record<string, (ids: string[]) => Promise<Array<{ id: string } & T>>>
): Promise<Array<LinkRow & { entity: T }>> {
  const byType = new Map<string, string[]>();
  for (const v of neighbors) {
    if (!loaders[v.type]) continue;
    byType.set(v.type, [...(byType.get(v.type) ?? []), v.id]);
  }

  const loaded = new Map<string, Map<string, T>>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const rows = await loaders[type](ids);
      loaded.set(type, new Map(rows.map((r) => [String(r.id), r as unknown as T])));
    })
  );

  const output: Array<LinkRow & { entity: T }> = [];
  for (const v of neighbors) {
    const entity = loaded.get(v.type)?.get(v.id);
    if (entity === undefined) continue; // orphan, or no permission to see it
    output.push({ ...v, entity });
  }
  return output;
}
