/**
 * Kitsuden — Repository: Drizzle with chainable sugar
 * ============================================================================
 *
 * The ORM DECISION: we do not imitate Django (magic QuerySet) or Laravel (coupled
 * Active Record). Drizzle is the base (data-mapper, type-safe, no magic); this
 * is just chainable DX sugar on top — the ergonomics of a QuerySet without
 * sacrificing the clean model or security.
 *
 * SAFE BY DEFAULT: the repository runs on the executor you pass it. If
 * you pass it the `tx` from withTransactionalRLS (c.get("tx")), ALL queries
 * respect PostgreSQL RLS. There is no path that "skips" security.
 *
 *   // Inside a route with transactional RLS:
 *   const posts = await repo(blogPosts, { db: c.get("tx") })
 *     .filter({ status: "published" })
 *     .orderBy("-createdAt")
 *     .page(1, 20)
 *     .all();
 *
 *   const post = await repo(blogPosts).find(id);
 *   const { docs, total, pages } = await repo(blogPosts).paginate(2, 20);
 *   await repo(blogPosts, { db: tx }).create({ title: "Hello", ... });
 */

import { and, asc, desc, eq, getTableName, sql, type SQL } from "drizzle-orm";

import { db as defaultDb } from "../../../apps/api/src/db";

import { checkLock, type AnnotatedBlocking } from "./glass-box";
import { resolveExecutor } from "./request-scope";

// Executor = Drizzle db or tx (same query builder API).
type Executor = typeof defaultDb;

/**
 * STRUCTURAL constraint (not the `PgTable` brand): avoids the friction of a double
 * drizzle version in the monorepo (a kon and the engine may resolve different
 * copies of `PgTable`; the structural type treats them the same and keeps
 * type inference via $inferSelect/$inferInsert).
 */
type TableLike = {
  $inferSelect: Record<string, unknown>;
  $inferInsert: Record<string, unknown>;
};

type InferSelect<T extends TableLike> = T["$inferSelect"];
type InferInsert<T extends TableLike> = T["$inferInsert"];

/** Order field: "createdAt" (asc) or "-createdAt" (desc). */
type OrderField<T extends TableLike> = keyof InferSelect<T> | `-${string & keyof InferSelect<T>}`;

export interface PaginatedResult<R> {
  docs: R[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface RepositoryOptions {
  /** Executor: pass the RLS `tx` for safe queries. Default: global db. */
  db?: Executor;
}

class Repository<T extends TableLike> {
  private conditions: SQL[] = [];
  private orderings: SQL[] = [];
  private _limit?: number;
  private _offset?: number;
  /** The `id` it was filtered by, if it was filtered by it (for the glass box). */
  private filteredId?: unknown;

  constructor(
    private readonly table: T,
    private readonly executor: Executor
  ) {}

  private col(name: string): unknown {
    return (this.table as unknown as Record<string, unknown>)[name];
  }

  // ── Filters (chainable) ──────────────────────────────────────────────────

  /** Django-style filter: equality on each field (AND). */
  filter(match: Partial<InferSelect<T>>): this {
    for (const [key, value] of Object.entries(match)) {
      this.conditions.push(eq(this.col(key) as never, value as never));
      if (key === "id") this.filteredId = value;
    }
    return this;
  }

  /** Raw Drizzle condition (for advanced operators: gt, like, inArray…). */
  where(condition: SQL): this {
    this.conditions.push(condition);
    return this;
  }

  orderBy(...fields: OrderField<T>[]): this {
    for (const f of fields) {
      const desc_ = typeof f === "string" && f.startsWith("-");
      const name = desc_ ? (f as string).slice(1) : (f as string);
      this.orderings.push((desc_ ? desc : asc)(this.col(name) as never));
    }
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  offset(n: number): this {
    this._offset = n;
    return this;
  }

  /** Convenient pagination: sets limit/offset from page (1-based). */
  page(page: number, pageSize = 20): this {
    this._limit = pageSize;
    this._offset = (Math.max(1, page) - 1) * pageSize;
    return this;
  }

  private whereClause(): SQL | undefined {
    if (this.conditions.length === 0) return undefined;
    return this.conditions.length === 1 ? this.conditions[0] : and(...this.conditions);
  }

  // ── Execution (terminals) ────────────────────────────────────────────────

  async all(): Promise<InferSelect<T>[]> {
    let q = this.executor.select().from(this.table as never) as any;
    const where = this.whereClause();
    if (where) q = q.where(where);
    if (this.orderings.length) q = q.orderBy(...this.orderings);
    if (this._limit !== undefined) q = q.limit(this._limit);
    if (this._offset !== undefined) q = q.offset(this._offset);
    return (await q) as InferSelect<T>[];
  }

  async first(): Promise<InferSelect<T> | null> {
    this._limit = 1;
    const rows = await this.all();
    return rows[0] ?? null;
  }

  /**
   * Looks up by primary key `id`.
   *
   * ── AN IMPOSSIBLE ID MEANS "DOES NOT EXIST", NOT A SERVER ERROR ──────────
   *
   * If the column is `uuid` and something that is not one arrives —`"null"`,
   * `"undefined"`, a slug, an id from another table—, Postgres does not return zero
   * rows: it throws
   *
   *     invalid input syntax for type uuid: "null"        (SQLSTATE 22P02)
   *
   * and the error handler turns it into a **500**. Measured on a real
   * installation: the MOBA panel called
   * `POST /games/null/ingest/start` when no match was selected, and the
   * screen showed "HTTP 500" — as if the server were broken, when
   * all that happened was that the id could not exist.
   *
   * ── WHY IT IS FIXED HERE AND NOT IN EACH ROUTE ───────────────────────────
   *
   * Because there are ~240 routes with `:id` spread over 24 kon files, and only one
   * validated them. Asking each one to check the format before
   * querying is asking 240 places to remember the same thing; the one that forgets
   * —the general case— returns a 500 for a mistyped URL.
   *
   * ── WHY THE ERROR IS CAUGHT INSTEAD OF VALIDATING FIRST ──────────────────
   *
   * Because NOT all primary keys are uuid: `builder_definitions.id` is
   * `TEXT`, and rejecting there whatever does not look like a uuid would break a whole kon.
   * Catching `22P02` is exact: it only fires when the column really requires a
   * uuid and the value really cannot be one. In that case, no row can
   * match — so `null` is not an assumption, it is the answer.
   *
   * Any other error propagates: a connection or permissions failure CANNOT
   * be disguised as "not found".
   */
  async find(id: string | number): Promise<InferSelect<T> | null> {
    try {
      return await this.filter({ id } as Partial<InferSelect<T>>).first();
    } catch (e: unknown) {
      if (isInvalidInputSyntax(e)) return null;
      throw e;
    }
  }

  async count(): Promise<number> {
    let q = this.executor
      .select({ c: sql<number>`count(*)::int` })
      .from(this.table as never) as any;
    const where = this.whereClause();
    if (where) q = q.where(where);
    const [row] = (await q) as { c: number }[];
    return row?.c ?? 0;
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  /** Returns page + metadata (docs, total, pages, hasNext…). */
  async paginate(page = 1, pageSize = 20): Promise<PaginatedResult<InferSelect<T>>> {
    const total = await this.count();
    const docs = await this.page(page, pageSize).all();
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return {
      docs,
      total,
      page,
      pageSize,
      pages,
      hasNext: page < pages,
      hasPrev: page > 1,
    };
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  async create(data: InferInsert<T>): Promise<InferSelect<T>> {
    const [row] = (await (this.executor.insert(this.table as never) as any)
      .values(data)
      .returning()) as InferSelect<T>[];
    return row;
  }

  async createMany(data: InferInsert<T>[]): Promise<InferSelect<T>[]> {
    if (data.length === 0) return [];
    return (await (this.executor.insert(this.table as never) as any)
      .values(data)
      .returning()) as InferSelect<T>[];
  }

  /** Updates the rows that match the accumulated filters. */
  async update(data: Partial<InferInsert<T>>): Promise<InferSelect<T>[]> {
    const where = this.whereClause();
    let q = (this.executor.update(this.table as never) as any).set(data);
    if (where) q = q.where(where);
    const rows = (await q.returning()) as InferSelect<T>[];
    if (rows.length === 0) await this.annotateIfBlocked("update");
    return rows;
  }

  /** Deletes the rows that match the accumulated filters. Returns the count. */
  async delete(): Promise<number> {
    const where = this.whereClause();
    let q = this.executor.delete(this.table as never) as any;
    if (where) q = q.where(where);
    const rows = (await q.returning()) as unknown[];
    if (rows.length === 0) await this.annotateIfBlocked("delete");
    return rows.length;
  }

  /**
   * A write by `id` that touched nothing: does it not exist, or did the owner filter
   * or RLS set it aside? It is checked as the system and goes ONLY to the trace
   * (glass-box.ts); what the route responds does not change.
   */
  private async annotateIfBlocked(operation: AnnotatedBlocking["operation"]): Promise<void> {
    const idCol = this.col("id");
    if (this.filteredId === undefined || !idCol) return;
    const id = this.filteredId;
    await checkLock(getTableName(this.table as never), operation, async () => {
      const r = (await (this.executor.select({ one: sql`1` }) as any)
        .from(this.table as never)
        .where(eq(idCol as never, id as never))
        .limit(1)) as unknown[];
      return r.length > 0;
    });
  }
}

/**
 * Entry point.
 *   - `repo(table)` inside a request with transactional RLS → uses the request-scope
 *     `tx` automatically (RLS applied, nothing to pass).
 *   - `repo(table)` outside a request → uses the global db.
 *   - `repo(table, { db })` → forces an explicit executor (override).
 */
/**
 * Is it a Postgres "invalid input syntax" (SQLSTATE 22P02)?
 *
 * The real code travels in `cause`, not in `message`: Drizzle wraps the error
 * in a `DrizzleQueryError` whose message is "Failed query: …". Looking for the clue
 * only in the top-level message finds nothing — it is the same lesson as the
 * migrations diagnostics.
 */
/**
 * Is it "the id you gave me does not have the shape of this column"?
 *
 * It is exported because the same case appears outside the repository: any route
 * that puts a URL parameter in a comparison against a `uuid` column
 * can receive "x" and cause a 22P02, which uncaught comes out as a 500. A
 * mistyped URL is not a server failure.
 */
export function isInvalidInputSyntax(e: unknown): boolean {
  const codes: unknown[] = [];
  let actual: unknown = e;

  // The chain of causes is walked in case there is more than one wrapper.
  for (let i = 0; i < 5 && actual; i++) {
    const err = actual as { code?: unknown; message?: unknown; cause?: unknown };
    codes.push(err.code);
    if (typeof err.message === "string" && /invalid input syntax for type/i.test(err.message)) {
      return true;
    }
    actual = err.cause;
  }

  return codes.includes("22P02");
}

export function repo<T extends TableLike>(
  table: T,
  options: RepositoryOptions = {}
): Repository<T> {
  const executor = options.db ?? resolveExecutor(defaultDb);
  return new Repository(table, executor);
}

export type { Repository };
