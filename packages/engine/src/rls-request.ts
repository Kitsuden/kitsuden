/**
 * Kitsuden — Per-request RLS (the shared piece for the core and the kons)
 * ============================================================================
 *
 * One request = ONE Postgres transaction with who is asking set with
 * `set_config('app.current_user_id' | 'app.current_user_role', …, true)`.
 * `is_local = true`: the context dies with the transaction and is never left on
 * a pool connection (an earlier incident where the RLS context was never set).
 *
 * This used to be repeated: `withTransactionalRLS()` in the core, three copies of
 * an RLS-context helper (dms, agile, conta), an as-user helper in payments and a
 * loose `set_config` in booking, crm and directory. Each copy with its own
 * convention for the anonymous user. Now there is one, with no dependencies on the API's
 * startup (no global `db`, no logger), so the kons' tests can
 * mount it on PGlite exactly as the host mounts it on the
 * real pool.
 *
 * ── THE THREE IDENTITIES POSTGRES SEES ─────────────────────────────────────
 *
 *   · An account:   the account's id, the account's role (`user` if it has none).
 *   · The anonymous: id '' and role `anonymous`.
 *   · The system:   id '' and role '' (or unset). Migrations, background
 *                   tasks and whatever a route does with `asSystem()`.
 *
 * Policies treat as system ONLY "empty id AND role". The non-empty role is
 * what separates the anonymous user from the system.
 *
 * ── THE THREE RISKS OF "ONE REQUEST = ONE TRANSACTION" ─────────────────────
 *
 * 1. PARALLEL QUERIES. A `Promise.all` of queries on the same
 *    transaction sends several `client.query()` calls to ONE connection at once. pg 8
 *    queues them internally with a deprecation warning; pg 9 removes that. Here
 *    they are serialized BEFORE reaching the driver: each request has its own queue
 *    (`Lane`) and each query waits its turn. A SAVEPOINT
 *    (`tx.transaction(fn)`) and `asSystem(fn)` are EXCLUSIVE sections:
 *    they take the whole turn and what is inside goes in a child queue, so whatever
 *    runs in parallel with them waits outside —it neither sneaks inside the
 *    savepoint nor runs as the system—.
 *
 * 2. SWALLOWED SQL ERRORS. Inside a transaction, a statement that
 *    fails aborts the whole transaction: the next one fails with "current
 *    transaction is aborted" and, if there is nothing else, Postgres turns the
 *    COMMIT into a ROLLBACK WITHOUT an error. Whatever may fail and you want to continue goes in
 *    `withSavepoint()` / `attemptSql()`. And as a safety net underneath, this file
 *    looks at the response to COMMIT: if Postgres answered ROLLBACK, the write
 *    was not saved; a warning is raised (`onLosingConfirmation`) and, if the request was a
 *    write and responded with success, it comes out as a 500 instead of lying.
 *
 * 3. LONG CALLS WITH THE TRANSACTION OPEN. The application role
 *    has `idle_in_transaction_session_timeout = 60s`. With the pg pool
 *    wrapped by `withLazyTransactions()`, the transaction is LAZY:
 *    the BEGIN and the context are stored and no connection is requested from the pool until the
 *    FIRST query. A route that calls out before touching the database does not
 *    hold a connection; one that queries nothing never requests one. Whatever is
 *    called out AFTER querying still has the transaction open: that
 *    is fixed in the route (before querying, `background` or a timeout
 *    that fits). See `docs/install/kon-transactions.md`.
 *
 * With other drivers (PGlite in the kons' tests) the transaction is opened
 * at the start, as before, and the exclusive sections still hold; the per-query
 * queue is provided by PGlite itself.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler, Next } from "hono";

import {
  clearRequestTx,
  resolveExecutor,
  runInRequestScope,
  setRequestTx,
  DB_METRICS_SERVICE,
  useRequest,
} from "./request-scope";

/** The minimum of a user that matters to the database. */
export interface RlsUser {
  id?: unknown;
  role?: unknown;
}

/** The minimum of a Drizzle connection: execute and open transactions. */
export interface TransactionalConnection {
  execute(query: unknown): Promise<unknown>;
  /** The driver's `tx` (or savepoint); here it is only passed from hand to hand. */
  transaction<R>(fn: (tx: TransactionalConnection) => Promise<R>, config?: unknown): Promise<R>;
}

/** Is it a Drizzle connection (what is published as `tx` in the request-scope)? */
function isTransactionalConnection(value: unknown): value is TransactionalConnection {
  return (
    typeof field(value, "execute") === "function" &&
    typeof field(value, "transaction") === "function"
  );
}

/** Which id and role Postgres sees for a user (or for nobody). */
export function rlsContextOf(user: RlsUser | null | undefined): {
  userId: string;
  userRole: string;
} {
  if (user?.id === undefined || user?.id === null || user.id === "") {
    return { userId: "", userRole: "anonymous" };
  }
  const role = typeof user.role === "string" && user.role ? user.role : "user";
  return { userId: String(user.id), userRole: role };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ONE QUERY AT A TIME: the request's queue
// ═══════════════════════════════════════════════════════════════════════════

const nothing = () => undefined;

/**
 * A FIFO queue of turns. Each request has its own (the root) and each
 * exclusive section opens a child one while holding the parent's turn.
 */
class Lane {
  private queue: Promise<unknown> = Promise.resolve();
  /** When its section ends, a child queue hands whatever arrives late to the parent. */
  closed = false;

  constructor(readonly parentTx?: Lane) {}

  turn<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(nothing, nothing);
    return result;
  }

  /** Waits for what has been enqueued so far to drain. */
  clear(): Promise<unknown> {
    return this.queue;
  }
}

/** What a transactional request needs to remember. */
interface RequestStatus {
  root: Lane;
  /** While `db.transaction()` requests its connection from the pool (see `withLazyTransactions`). */
  requestingConnection: boolean;
  /** The lazy connection, if the pool is wrapped. */
  connection?: LazyConnection;
  /** For the "glass box" (glass-box.ts): what the request asked of the database. */
  measures?: { queries: number; ms: number; rows: number };
}

const WRITE_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

/**
 * The request's measurements, in the request-scope (the same ones read by
 * `requestMeasures()`). Without a request-scope, none.
 */
function publishedMeasures(): RequestStatus["measures"] {
  const scope = useRequest();
  if (!scope) return undefined;
  scope.services ??= {};
  return (scope.services[DB_METRICS_SERVICE] ??= {
    queries: 0,
    ms: 0,
    rows: 0,
  }) as RequestStatus["measures"];
}

/** Which queue the code that is running now is in (inside a section, the child). */
const currentLane = new AsyncLocalStorage<{ status: RequestStatus; lane: Lane }>();

function laneOf(status: RequestStatus): Lane {
  const inProgress = currentLane.getStore();
  let lane = inProgress?.status === status ? inProgress.lane : status.root;
  while (lane.closed && lane.parentTx) lane = lane.parentTx;
  return lane;
}

/**
 * Exclusive section: takes a turn from the current queue and holds it until
 * `fn` finishes; `fn`'s queries go through a child queue.
 *
 * The only thing that can jam it is `fn` WAITING for something outside that,
 * in turn, needs to query in the outer queue (a promise created earlier and
 * awaited inside that still has pending queries). Inside, only its own.
 */
async function section<T>(status: RequestStatus, fn: () => Promise<T>): Promise<T> {
  const parentTx = laneOf(status);
  return parentTx.turn(async () => {
    const child = new Lane(parentTx);
    try {
      return await currentLane.run({ status, lane: child }, fn);
    } finally {
      child.closed = true;
      await child.clear();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE LAZY CONNECTION (pg pool)
// ═══════════════════════════════════════════════════════════════════════════

/** What Drizzle (node-postgres) uses from a pool client. */
interface PoolClient {
  query(...args: unknown[]): Promise<unknown>;
  release(err?: unknown): void;
}

/** A field of an unknown value (an error, a pg result), without assuming its shape. */
function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

function emptyResult() {
  return { command: "", rowCount: 0, oid: 0, rows: [], fields: [] };
}

function textOf(args: unknown[]): string {
  const first = args[0];
  const text = typeof first === "string" ? first : field(first, "text");
  return typeof text === "string" ? text.trim().toLowerCase() : "";
}

const isTransactionEnd = (args: unknown[]) => {
  const text = textOf(args);
  return text === "commit" || text === "rollback";
};

/** An error that leaves the connection unusable (so it must be destroyed, not returned)? */
function isConnectionError(err: unknown): boolean {
  const code = field(err, "code");
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return true;
  return code.startsWith("08") || code.startsWith("57P") || code === "25P03";
}

/**
 * A pool client that does not exist until it is needed.
 *
 * Drizzle receives it from `pool.connect()` inside `db.transaction()` and uses it
 * like any `PoolClient`: `query()` and, when done, `release()`.
 *
 *   · `preparing` phase: what the middleware sends (BEGIN, `set_config`) is
 *     stored and answered with an empty result.
 *   · First real query: requests the connection from the pool, replays what was
 *     stored and continues. All queries go through the request's queue.
 *   · COMMIT/ROLLBACK with no open connection: there is nothing to close.
 *   · After closing, a query fails with a clear message instead of going
 *     to a connection that now serves someone else.
 *
 * The class name cannot contain "Pool": Drizzle uses it to decide whether
 * what it has is a pool (and would then request another connection).
 */
class LazyConnection implements PoolClient {
  private real: PoolClient | null = null;
  private opening: Promise<PoolClient> | null = null;
  private deferredOnes: unknown[][] = [];
  private phase: "preparing" | "active" | "closing" | "closed" = "preparing";
  private revert = false;
  private finished = false;
  private connectionError: unknown;
  /** COMMIT was sent and Postgres answered ROLLBACK: the transaction was aborted. */
  lostConfirmation = false;
  /** The request's first SQL error (for the warning). */
  primerError: { code?: string; message: string } | undefined;

  constructor(
    private readonly openReal: () => Promise<PoolClient>,
    private readonly requestStatus: RequestStatus
  ) {}

  /** Did it ever request a connection from the pool? */
  get isOpen(): boolean {
    return this.real !== null || this.opening !== null;
  }

  /** The middleware finished preparing: what follows are real queries. */
  activate(): void {
    if (this.phase === "preparing") this.phase = "active";
  }

  /** The middleware is about to close (`rollback`: ROLLBACK on purpose). */
  close(revert: boolean): void {
    this.phase = "closing";
    this.revert = revert;
  }

  query(...args: unknown[]): Promise<unknown> {
    const last = args[args.length - 1];
    const callback = typeof last === "function" ? last : undefined;
    const promise = this.enqueue(callback ? args.slice(0, -1) : args);
    if (callback) {
      promise.then(
        (res) => callback(null, res),
        (err) => callback(err)
      );
    }
    return promise;
  }

  private enqueue(args: unknown[]): Promise<unknown> {
    if (this.phase === "closed") return Promise.reject(errorClosed());
    if (this.phase === "preparing" && !this.isOpen) {
      this.deferredOnes.push(args);
      return Promise.resolve(emptyResult());
    }
    const closing = this.phase === "closing" && isTransactionEnd(args);
    return laneOf(this.requestStatus).turn(async () => {
      if (this.finished) throw errorClosed();
      if (closing) {
        this.finished = true;
        // Nobody queried: there is no transaction to close or connection to request.
        if (!this.isOpen) return emptyResult();
      }
      const real = await this.open();
      try {
        const start = performance.now();
        const res = await real.query(...args);
        const measures = this.requestStatus.measures;
        if (measures && !closing) {
          measures.queries++;
          measures.ms += performance.now() - start;
          const command = field(res, "command");
          const rows = field(res, "rowCount");
          if (
            typeof command === "string" &&
            WRITE_COMMANDS.has(command) &&
            typeof rows === "number"
          ) {
            measures.rows += rows;
          }
        }
        if (closing && !this.revert && field(res, "command") === "ROLLBACK") {
          this.lostConfirmation = true;
        }
        return res;
      } catch (err) {
        this.annotate(err);
        throw err;
      }
    });
  }

  private annotate(err: unknown): void {
    if (!this.primerError) {
      const code = field(err, "code");
      const message = field(err, "message");
      this.primerError = {
        code: typeof code === "string" ? code : undefined,
        message: typeof message === "string" ? message : String(err),
      };
    }
    if (isConnectionError(err)) this.connectionError = err;
  }

  private open(): Promise<PoolClient> {
    if (this.real) return Promise.resolve(this.real);
    this.opening ??= (async () => {
      const real = await this.openReal();
      try {
        // BEGIN + context in ONE round trip if possible; otherwise, one by one.
        const together = deferredInOneStatement(this.deferredOnes, real);
        if (together !== null) await real.query(together);
        else for (const args of this.deferredOnes) await real.query(...args);
      } catch (err) {
        this.annotate(err);
        real.release(err);
        throw err;
      }
      this.deferredOnes = [];
      this.real = real;
      return real;
    })();
    return this.opening;
  }

  release(err?: unknown): void {
    this.phase = "closed";
    this.finished = true;
    const real = this.real;
    this.real = null;
    // With an error, pg-pool destroys the connection instead of lending it again.
    real?.release(err ?? this.connectionError);
  }
}

/**
 * ── BEGIN AND CONTEXT IN A SINGLE ROUND TRIP (performance) ─────────────────
 *
 * What the middleware leaves stored before the first query is always
 * the same: `begin` and one or two `SELECT set_config('app.…', $n, true)`. One
 * statement at a time was sent: two or three trips to Postgres before the
 * first real query, on EVERY request that touches the database. Here they are
 * joined into a single simple query (`begin; SELECT set_config(…)`), with the
 * values written as literals by the driver's own `escapeLiteral`.
 *
 * They are only joined if ALL the stored ones are exactly of those two forms
 * (closed patterns below) and all their values are strings; anything else
 * —another driver, another statement, a non-text value— is sent one by
 * one as before. Postgres runs the statements of a simple query in
 * order and, if one fails, the following ones do not run: the same effect as
 * sending them separately, with the transaction aborted.
 */
const BEGIN_ONLY = /^begin$/i;
const CONTEXT_SET_CONFIG =
  /^SELECT set_config\('app\.[a-z_]+', \$\d+, true\)(?:, set_config\('app\.[a-z_]+', \$\d+, true\))*$/;

function textAndValues(args: unknown[]): { text: string; values: unknown[] } | null {
  const [first, secondItem] = args;
  if (typeof first === "string") {
    return { text: first, values: Array.isArray(secondItem) ? secondItem : [] };
  }
  const text = field(first, "text");
  if (typeof text !== "string") return null;
  // Options that change how the result is read: not touched
  if (field(first, "rowMode") !== undefined || field(first, "name") !== undefined) return null;
  // Drizzle sends `query(config, params)`; pg also accepts `config.values`
  const values = Array.isArray(secondItem) ? secondItem : field(first, "values");
  return { text, values: Array.isArray(values) ? values : [] };
}

export function deferredInOneStatement(deferredOnes: unknown[][], client: unknown): string | null {
  if (deferredOnes.length < 2) return null;
  const escape = field(client, "escapeLiteral");
  if (typeof escape !== "function") return null;
  const parts: string[] = [];
  for (const args of deferredOnes) {
    const s = textAndValues(args);
    if (!s) return null;
    const text = s.text.trim();
    if (BEGIN_ONLY.test(text) && s.values.length === 0) {
      parts.push("begin");
      continue;
    }
    if (!CONTEXT_SET_CONFIG.test(text)) return null;
    if (!s.values.every((v) => typeof v === "string")) return null;
    let bad = false;
    const withValues = text.replace(/\$(\d+)/g, (_t, n: string) => {
      const v = s.values[Number(n) - 1];
      if (typeof v !== "string") {
        bad = true;
        return "NULL";
      }
      return (escape as (x: string) => string).call(client, v);
    });
    if (bad) return null;
    parts.push(withValues);
  }
  return parts.join("; ");
}

function errorClosed(): Error {
  return new Error(
    "This request's transaction is already closed: work that outlives the response goes in background()."
  );
}

/** Who is opening their RLS transaction right now (for `pool.connect`). */
const openingInProgress = new AsyncLocalStorage<RequestStatus>();

/** The minimum of pg-pool that is needed: `connect` with a promise or a callback. */
/**
 * The minimum of pg-pool that is needed: `connect()` with a promise, or with a
 * callback (used by `pool.query` internally). Method syntax on purpose:
 * this way pg's overloaded `connect` fits without casts.
 */
interface ConnectablePool {
  connect(callback?: (...args: never[]) => unknown): unknown;
}

/** Does it have the shape of a pool client (what `connect()` returns)? */
function isPoolClient(value: unknown): value is PoolClient {
  return (
    typeof field(value, "query") === "function" && typeof field(value, "release") === "function"
  );
}

/**
 * Wraps `pool.connect` (pg-pool) so that each request's RLS transaction
 * is lazy. It only changes the connection that `db.transaction()` requests
 * FROM `rlsTransaction`; any other (`pool.query`, a system's own
 * transaction) comes out of the pool as always.
 *
 * Same pattern as `watchPool` (apps/api/src/lib/pool-exhausted.ts), which
 * can go underneath: the real connection is requested with whatever `connect` there was.
 */
export function withLazyTransactions<P extends ConnectablePool>(pool: P): P {
  const original = pool.connect.bind(pool);
  const openReal = async (): Promise<PoolClient> => {
    const client = await original();
    if (!isPoolClient(client)) {
      throw new TypeError("pool.connect() did not return a client with query() and release()");
    }
    return client;
  };
  // It is written through the constraint's type: it is `connect` that is
  // being replaced, not whatever `P` adds.
  const target: ConnectablePool = pool;
  target.connect = (callback) => {
    const status = openingInProgress.getStore();
    if (status?.requestingConnection && callback === undefined) {
      status.requestingConnection = false;
      const connection = new LazyConnection(openReal, status);
      status.connection = connection;
      return Promise.resolve(connection);
    }
    return original(callback);
  };
  return pool;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE REQUEST'S TRANSACTION
// ═══════════════════════════════════════════════════════════════════════════

/** The CURRENT user context in each transaction (to restore it). */
const contextByTx = new WeakMap<object, { userId: string; userRole: string }>();
/** Which request each published `tx` belongs to (root and savepoints). */
const statusByTx = new WeakMap<object, RequestStatus>();

async function set(tx: TransactionalConnection, userId: string, userRole: string) {
  await tx.execute(
    sql`SELECT set_config('app.current_user_id', ${userId}, true), set_config('app.current_user_role', ${userRole}, true)`
  );
}

/**
 * Sets a user's context in an ALREADY-open transaction and remembers it
 * so that `asSystem()` can restore it.
 */
export async function setRlsContext(
  tx: TransactionalConnection,
  user: RlsUser | null | undefined
): Promise<{ userId: string; userRole: string }> {
  const context = rlsContextOf(user);
  contextByTx.set(tx, context);
  await set(tx, context.userId, context.userRole);
  await setAgentDatasets(tx, user);
  return context;
}

/**
 * An agent's SCOPES, for the datasets' RLS.
 *
 * The `data_entries` policies only knew owner, `admin` role and the
 * dataset's `policyJson`: an agent (role `agent`; not an account, with no own
 * rows) could neither see nor write anything in a private dataset even if the
 * application granted it `datasets:<slug>:read`. Its scopes are passed
 * to Postgres in `app.agent_scopes` (local to the transaction) and the
 * `data_entries_agent_*` policies (rls-policies.sql) evaluate them with
 * `kitsuden_agent_opens_dataset()`: the SAME rule as shared
 * (agent-permission.ts: wildcards and denials), written in SQL and
 * compared with the TypeScript one by a test. It opens ONLY the datasets those
 * scopes cover: a handler failure cannot pull rows from another one.
 *
 * No queries here: with the lazy pool, what is sent before the
 * first real query is stored and answered empty.
 */
async function setAgentDatasets(
  tx: TransactionalConnection,
  user: RlsUser | null | undefined
): Promise<void> {
  const scopes = (user as { scopes?: unknown } | null | undefined)?.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return;
  // Validated scopes carry no commas (agent-permission.ts).
  const list = scopes.filter((s): s is string => typeof s === "string" && !s.includes(","));
  await tx.execute(sql`SELECT set_config('app.agent_scopes', ${list.join(",")}, true)`);
}

/**
 * The published `tx`: Drizzle's with `transaction()` turned into an
 * exclusive section (at any depth). Everything else passes through as is.
 */
function wrapTx(tx: TransactionalConnection, status: RequestStatus): TransactionalConnection {
  const wrappedItem = new Proxy(tx, {
    get(target, property) {
      if (property === "transaction") {
        return <R>(fn: (internal: TransactionalConnection) => Promise<R>, config?: unknown) =>
          section(status, () =>
            target.transaction((internal) => fn(wrapTx(internal, status)), config)
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" && property !== "constructor" ? value.bind(target) : value;
    },
  });
  statusByTx.set(wrappedItem, status);
  return wrappedItem;
}

/** Internal signal to roll back the transaction without propagating an error. */
const REVERT = Symbol("rollback-rls-transaction");

/** What is known about a request whose COMMIT Postgres turned into ROLLBACK. */
export interface LostConfirmation {
  method: string;
  route: string;
  status: number;
  /** The request's first SQL error (the one that, swallowed, aborted the transaction). */
  error?: { code?: string; message: string };
  /** Whether the response was replaced by a 500 (writes that responded with success). */
  changedResponse: boolean;
}

export interface RlsTransactionOptions {
  /** Called with the transaction already open and the context set. */
  onOpen?(c: Context, tx: unknown, context: { userId: string; userRole: string }): void;
  /**
   * Called when the transaction ended up aborted by a SQL error that the
   * route caught and continued past: Postgres undid EVERYTHING in the request. For the
   * log; the response has already been corrected if needed.
   */
  onLosingConfirmation?(c: Context, info: LostConfirmation): void;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const afterCommitQueue = new AsyncLocalStorage<Array<() => void>>();

/**
 * Runs `fn` once the request's transaction has committed, and never if it rolled back. Outside a request it
 * runs now. For announcing what happened (a kon's event): whoever reacts must find it written, and a write
 * that was undone must not be announced.
 */
export function afterCommit(fn: () => void): void {
  const queue = afterCommitQueue.getStore();
  if (queue) queue.push(fn);
  else fn();
}

/**
 * Middleware: wraps the request in an RLS transaction on `db`.
 *
 * · Idempotent: if the request is already in an RLS transaction (two
 *   overlapping mounts), it does not open another —it would be another connection with another context—.
 * · Publishes the transaction in the request-scope: `repo()` and the kons'
 *   `db` (`theRequestDb`) use it without passing it by hand.
 * · Rolls back if the route ended in an error or a 5xx. Hono CATCHES errors
 *   inside `next()` (passes them to `onError` and leaves `c.error`), so without
 *   checking it a half-done write from a failed route was committed anyway.
 * · Lazy if the pool is wrapped (`withLazyTransactions`).
 * · A write whose COMMIT ended in ROLLBACK does not respond with success.
 */
export function rlsTransaction(
  db: TransactionalConnection | (() => TransactionalConnection),
  options: RlsTransactionOptions = {}
): MiddlewareHandler {
  const resolverDb = typeof db === "function" ? db : () => db;

  const middleware = async (c: Context, next: Next): Promise<void> => {
    if (c.get("tx" as never) || useRequest()?.tx) {
      await next();
      return;
    }
    // Without a request-scope (an app that does not mount the telemetry one) the `tx`
    // would have nowhere to be published and everything would fall to the global connection WITHOUT context.
    if (!useRequest()) {
      await runInRequestScope({}, () => middleware(c, next));
      return;
    }

    const user = c.get("user" as never) as RlsUser | null | undefined;
    publishUser(c, user);
    const statusValue: RequestStatus = {
      root: new Lane(),
      requestingConnection: true,
      measures: publishedMeasures(),
    };
    const pending: Array<() => void> = [];
    let reverted = false;
    try {
      await afterCommitQueue.run(pending, () =>
        openingInProgress.run(statusValue, () =>
          resolverDb().transaction(async (raw) => {
            // This transaction's connection has already been requested (or the driver does not
            // go through the pool): the following ones, for whoever, are normal.
            statusValue.requestingConnection = false;
            const tx = wrapTx(raw, statusValue);
            const context = await setRlsContext(tx, user);
            statusValue.connection?.activate();
            options.onOpen?.(c, tx, context);
            setRequestTx(tx);
            // If `next()` throws (Hono usually catches first), it is rolled back.
            let revert = true;
            try {
              await next();
              revert = Boolean(c.error || (c.res && c.res.status >= 500));
            } finally {
              clearRequestTx();
              statusValue.connection?.close(revert);
            }
            if (revert) throw REVERT;
          })
        )
      );
    } catch (err) {
      if (err !== REVERT) throw err;
      reverted = true;
    }
    if (!reverted && !statusValue.connection?.lostConfirmation) {
      for (const fn of pending) {
        // A listener's failure is its own: the request already succeeded.
        try {
          fn();
        } catch {
          // Reported by whoever registered it.
        }
      }
    }

    if (statusValue.connection?.lostConfirmation) {
      const status = c.res?.status ?? 200;
      const change = !READ_METHODS.has(c.req.method) && status < 400;
      if (change) {
        c.res = new Response(
          JSON.stringify({
            error: "The changes of this request were not saved.",
            code: "KITSUDEN_E_INTERNAL",
            message:
              "A database error inside the request aborted its transaction; nothing was written.",
          }),
          { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
      options.onLosingConfirmation?.(c, {
        method: c.req.method,
        route: c.req.path,
        status,
        error: statusValue.connection.primerError,
        changedResponse: change,
      });
    }
  };
  return middleware;
}

/**
 * A request's RLS transaction, without a request: for a queue job
 * or any background task that must run with the
 * RLS of a specific actor and not as the system.
 *
 * Same as the middleware: lazy if the pool is wrapped (a job that
 * only sends an email does not request a connection), its own request-scope with the `tx`
 * published (`repo()` and `theRequestDb` use it), exclusive sections, and
 * ROLLBACK if `fn` throws. A COMMIT that Postgres turned into ROLLBACK throws:
 * the job was not done and must be retried.
 */
export async function inRlsTransaction<T>(
  db: TransactionalConnection,
  user: RlsUser | null | undefined,
  fn: () => Promise<T>,
  scope: { requestId?: string; traceId?: string } = {}
): Promise<T> {
  const status: RequestStatus = { root: new Lane(), requestingConnection: true };
  const userValue = (user ?? null) as RequestScopeUser;
  let result: T | undefined;
  await runInRequestScope({ ...scope, user: userValue }, () =>
    openingInProgress.run(status, () =>
      db.transaction(async (raw) => {
        status.requestingConnection = false;
        const tx = wrapTx(raw, status);
        await setRlsContext(tx, user);
        status.connection?.activate();
        setRequestTx(tx);
        let revert = true;
        try {
          result = await fn();
          revert = false;
        } finally {
          clearRequestTx();
          status.connection?.close(revert);
        }
      })
    )
  );
  if (status.connection?.lostConfirmation) {
    const first = status.connection.primerError;
    throw new Error(
      `The transaction was rolled back on commit${first ? `: ${first.message}` : ""}`
    );
  }
  return result as T;
}

type RequestScopeUser = { id?: string; role?: string; scopes?: string[]; keyId?: string } | null;

/**
 * Publishes in the request-scope WHO is asking (if nobody did before): what
 * `useUser()` returns and what `queue.dispatch()` stores as the job's actor.
 * Only id, role, scopes and the agent's key: nothing from the session.
 */
function publishUser(c: Context, user: RlsUser | null | undefined): void {
  const scope = useRequest();
  if (!scope || scope.user !== undefined) return;
  const { userId, userRole } = rlsContextOf(user);
  if (!userId) {
    scope.user = null;
    return;
  }
  const scopes = (user as { scopes?: unknown } | null | undefined)?.scopes;
  const agent = c.get("agent" as never) as { keyId?: unknown } | undefined;
  scope.user = {
    id: userId,
    role: userRole,
    ...(Array.isArray(scopes)
      ? { scopes: scopes.filter((s): s is string => typeof s === "string") }
      : {}),
    ...(typeof agent?.keyId === "string" && agent.keyId ? { keyId: agent.keyId } : {}),
  };
}

/**
 * Runs `fn` as the SYSTEM (id '' and role '') inside the request's
 * transaction, and restores the context when done.
 *
 * For what a route does on behalf of others and the RLS of whoever asks, rightly,
 * does not allow: recounting other people's votes, signing up an anonymous user, processing a
 * signed webhook. ALWAYS after authorizing the action in the application.
 * Outside a transactional request `fn` runs as is: that connection
 * is already the system's.
 *
 * It is an exclusive section: whatever is launched in parallel with `fn` (a
 * mixed `Promise.all`) waits until it finishes and runs with the context of
 * whoever asks, not as the system. Nested in another one, it restores the system.
 */
export async function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  const tx = useRequest()?.tx;
  if (!isTransactionalConnection(tx) || !contextByTx.has(tx)) return fn();
  const body = async (): Promise<T> => {
    const prior = contextByTx.get(tx);
    if (!prior) return fn();
    const system = { userId: "", userRole: "" };
    await set(tx, system.userId, system.userRole);
    contextByTx.set(tx, system);
    let good = false;
    try {
      const result = await fn();
      good = true;
      return result;
    } finally {
      contextByTx.set(tx, prior);
      // If `fn` failed in SQL the transaction is aborted and restoring would also
      // fail, covering up the real error: it is attempted and silenced. The
      // transaction will be rolled back entirely anyway.
      const restore = set(tx, prior.userId, prior.userRole);
      if (good) await restore;
      else await restore.catch(() => {});
    }
  };
  const status = statusByTx.get(tx);
  return status ? section(status, body) : body();
}

/**
 * Runs `fn` in a SAVEPOINT of the request's transaction: if it fails, only its own part is
 * undone and the transaction stays alive for what comes next. The
 * error propagates all the same (that is what `attemptSql` is for).
 *
 * Outside a transactional request it runs `fn` as is: each statement
 * goes in its own transaction and a failure poisons nobody.
 *
 * `fn` can use the usual `db` (same connection, the savepoint is connection
 * state) or the `sp` it receives.
 */
export async function withSavepoint<T>(
  fn: (sp?: TransactionalConnection) => Promise<T>
): Promise<T> {
  const tx = useRequest()?.tx;
  if (!isTransactionalConnection(tx)) return fn(undefined);
  return tx.transaction((sp) => fn(sp));
}

/**
 * "Try and continue" with SQL: `fn` in a SAVEPOINT; if it fails, `onFailure`
 * is called (for the log) and `isDefault` is returned. The replacement for
 * `try { await db… } catch {}` inside a route.
 */
export async function attemptSql<T>(
  fn: (sp?: TransactionalConnection) => Promise<T>,
  defaultValue: T,
  onFailure?: (err: unknown) => void
): Promise<T> {
  try {
    return await withSavepoint(fn);
  } catch (err) {
    onFailure?.(err);
    return defaultValue;
  }
}

/**
 * Runs `fn` OUTSIDE the request's transaction: an empty request-scope,
 * so `theRequestDb` resolves to the global connection (the system), and the
 * timers and promises `fn` creates inherit that empty scope.
 *
 * For work that outlives the response (a `void task()`, a live session, an
 * email that does not need to be awaited): the request's transaction is
 * committed on responding, and a query prepared inside it
 * and run later would go to a connection already returned to the pool.
 */
export function background<T>(fn: () => T): T {
  return runInRequestScope({}, fn);
}

/**
 * A `db` that, on each access, resolves to the executor of the current request
 * (the RLS transaction) or, outside a request, to `db`.
 *
 * A proxy and not a value: kons store `ctx.db.instance` in a constant when
 * creating their router, just once. Resolving on each access is what makes
 * that constant keep pointing at the transaction of WHOEVER is asking.
 *
 * `instance.transaction(fn)` inside a request opens a SAVEPOINT of the
 * request's transaction (Drizzle does it by itself): same context, same
 * connection, and if `fn` throws only its own part is undone.
 */
export function theRequestDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(_target, property) {
      const executor: object = resolveExecutor(db);
      const value: unknown = Reflect.get(executor, property);
      return typeof value === "function" ? value.bind(executor) : value;
    },
  });
}
