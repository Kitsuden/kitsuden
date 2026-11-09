/**
 * defineModel — the ENGINE: from the model to the Drizzle table and the operations
 * ============================================================================
 *
 * The contract (fields, access policy, schemas, names, SQL) lives in
 * `@kitsuden/shared` (`models.ts`, `models-sql.ts`). Here is what
 * executes it, fitted into the kon SDK (not beside it):
 *
 *   modelTable(m)                the Drizzle table (the same shape as the
 *                                   migration that `makemigrations` generates)
 *   modelOperations(kon, m)     six `defineOperation`s (describe, list,
 *                                   get, create, update, delete): REST, OpenAPI 3.1
 *                                   and MCP come out of them
 *   defineModelsKon({…})         a `defineKonSdk` with the operations of
 *                                   its models (and any of its own it adds)
 *
 * ── THE THREE WALLS ────────────────────────────────────────────────────────
 *
 *   1. The operation's PERMISSION (before reading the body): the model's scope
 *      (`<model>:read|write`), a fine-grained or broad one of the kon, `admin`, or
 *      the `<model>` policy for human accounts. The policy opens NOTHING
 *      to an agent: an agent writes only with a write scope.
 *   2. The handler's row FILTER (owner), the same as RLS.
 *   3. Postgres RLS (the generated migration), with FORCE. The route runs
 *      in the RLS transaction the host opens for every kon route.
 *
 * Inherited from the host for free: idempotency (`Idempotency-Key`
 * on POST/PATCH; DELETE is already idempotent), the `KITSUDEN_E_*` problem+json
 * errors (a repeated UNIQUE is 409 CONFLICT), human approval of
 * sensitive operations (DELETE) and request limits.
 */

import {
  modelDescriptor,
  choosesOwner,
  modelDescriptorSchema,
  modelSchemas,
  modelOperationIds,
  konShortName,
  modelRoutes,
  modelScopes,
  hasOwner,
  DEFAULT_LIMIT,
  type Field,
  type KonContext,
  type KonDefinition,
  type Model,
  type OperationUser,
  type ModelDescriptor,
  defineOperation,
  fieldColumn,
} from "@kitsuden/shared";
import { and, asc, count, desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { z } from "zod";

import { definePolicy } from "./authz";
import { agentCanInKon, isEffectiveAdmin, isAgent, isEffectiveStaff } from "./effective-actor";
import { AppError } from "./errors";
import {
  defineKonSdk,
  mountedOperations,
  type SdkKonDefinition,
  type AnyOperation,
} from "./operations";
import { queue } from "./queue";
import { EMBEDDINGS_QUEUE, embed, vectorLiteral, type EmbeddingJob } from "./semantics";

// ── The table ───────────────────────────────────────────────────────────────

function column(key: string, c: Field) {
  const name = fieldColumn(key);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each Drizzle builder has its own type; the table is dynamic
  let col: any;
  switch (c.type) {
    case "text":
      col = c.max !== undefined ? varchar(name, { length: c.max }) : text(name);
      break;
    case "longText":
    case "enum":
      col = text(name);
      break;
    case "integer":
      col = integer(name);
      break;
    case "number":
      col = doublePrecision(name);
      break;
    case "boolean":
      col = boolean(name);
      break;
    case "date":
      col = timestamp(name, { withTimezone: true });
      break;
    case "json":
      col = jsonb(name);
      break;
    case "uuid":
      col = uuid(name);
      break;
  }
  if (c.required) col = col.notNull();
  return col;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- table built at runtime
export type ModelTable = any;

const tables = new WeakMap<Model, ModelTable>();

/** The model's Drizzle table (one per model: it is cached). */
export function modelTable(m: Model): ModelTable {
  const done = tables.get(m);
  if (done) return done;
  const columns: Record<string, unknown> = {
    id: uuid("id").primaryKey().defaultRandom(),
  };
  if (hasOwner(m)) columns.ownerId = text("owner_id");
  for (const [key, c] of Object.entries(m.fields)) columns[key] = column(key, c);
  columns.createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
  columns.updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ver ModelTable
  const table = pgTable(m.table, columns as any);
  tables.set(m, table);
  return table;
}

// ── Policy (human accounts) ─────────────────────────────────────────────────

const policyOwners = new Map<string, string>();

/**
 * Registers the `<model>` policy (`read` and `write` actions). It only decides for
 * HUMAN accounts: for an agent it returns `false` and the agent gets in only through its
 * scopes (`can()` grants `<model>:<action>` by scope; the SDK, the kon's fine-grained
 * and broad ones). This way an agent never writes "just for being a user".
 *
 * Tests that call `resetAuthz()` register it again with
 * `registerModelPolicies`.
 */
export function registerModelPolicy(konId: string, m: Model): void {
  const other = policyOwners.get(m.name);
  if (other && other !== konId) {
    throw new Error(
      `model '${m.name}': already declared by ${other}; a model's name is its scope and cannot be repeated across kons`
    );
  }
  policyOwners.set(m.name, konId);
  const kon = konShortName(konId);
  const human = (u: OperationUser | null) =>
    !!u && !isAgent(u) && typeof u.id === "string" && u.id !== "";
  definePolicy(m.name, {
    read: (u) => {
      if (m.access.read === "public") return true;
      if (!human(u)) return false;
      if (m.access.read === "owner") return true;
      return isEffectiveStaff(u, kon);
    },
    write: (u) => {
      if (!human(u)) return false;
      return m.access.write === "owner" ? true : isEffectiveStaff(u, kon);
    },
  });
}

export function registerModelPolicies(konId: string, models: readonly Model[]): void {
  for (const m of models) registerModelPolicy(konId, m);
}

// ── Row filters (the second wall; the same as RLS) ─────────────────────────

/** Does this user see ALL rows (not only their own)? */
function seesAll(m: Model, u: OperationUser | null, kon: string): boolean {
  if (m.access.read === "public") return true;
  if (m.access.read === "staff") return true; // the permission already required staff or the scope
  if (isEffectiveAdmin(u, kon)) return true;
  if (m.access.write === "staff") {
    return isEffectiveStaff(u, kon) || agentCanInKon(u, kon, modelScopes(m).write);
  }
  return false;
}

/** Does it write to ALL rows? */
function writesAll(m: Model, u: OperationUser | null, kon: string): boolean {
  return m.access.write === "staff" || isEffectiveAdmin(u, kon);
}

function idOf(u: OperationUser | null): string {
  if (!u || typeof u.id !== "string" || !u.id) throw AppError.unauthenticated();
  return u.id;
}

// ── The operations ──────────────────────────────────────────────────────────

const modelPerOperation = new WeakMap<object, { konId: string; model: Model }>();

/** The model an operation came from (or `null` if it is not from a model). */
export function operationModel(op: object): { konId: string; model: Model } | null {
  return modelPerOperation.get(op) ?? null;
}

type Row = Record<string, unknown>;

/**
 * The six operations of a model, in the order Hono requires (literals,
 * `/_model`, before `/:id`).
 */
export function modelOperations(konId: string, m: Model): AnyOperation[] {
  const kon = konShortName(konId);
  const table = modelTable(m);
  const esq = modelSchemas(m);
  const ids = modelOperationIds(m);
  const routes = modelRoutes(m);
  const scopes = modelScopes(m);
  const tags = [`model:${m.name}`];
  const audience = m.access.read === "public";
  const withOwner = hasOwner(m);
  const hasUnique = Object.values(m.fields).some((c) => c.unique);

  // The check BEFORE the body (the SDK's) does not see the resource scope
  // (`resourceScope` needs the input); `h.authorize()` at the start of each
  // handler does, and so `!<model>:write` closes it even if the key carries `admin`.
  const readPermission = {
    scopes: [scopes.read],
    policy: { resource: m.name, action: "read" },
    resourceScope: () => scopes.read,
  };
  const writePermission = {
    scopes: [scopes.write],
    policy: { resource: m.name, action: "write" },
    resourceScope: () => scopes.write,
  };
  const accessRead = audience ? ("optional" as const) : ("session" as const);
  const before = [`Row ids come from ${konId.replace(/^kon-/, "")}__${ids.list} (data[].id).`];

  const db = (h: { ctx: KonContext }) => h.ctx.db.instance;

  /**
   * D5: after writing a row of a model with `semantics`, its embedding is
   * enqueued in the SAME transaction (if the write is rolled back, there is no
   * job). The host's worker computes it.
   */
  const enqueueEmbedding = async (row: Row | undefined): Promise<void> => {
    if (!m.semantics || !row?.id) return;
    const job: EmbeddingJob = {
      table: m.table,
      id: String(row.id),
      columns: m.semantics.fields.map(fieldColumn),
      dimensions: m.semantics.dimensions,
    };
    await queue.dispatch(EMBEDDINGS_QUEUE, `embed:${m.table}`, job, { attempts: 5 });
  };

  const readFilter = (u: OperationUser | null): SQL | undefined =>
    withOwner && !seesAll(m, u, kon) ? eq(table.ownerId, idOf(u)) : undefined;
  const writeFilter = (u: OperationUser | null): SQL | undefined =>
    withOwner && !writesAll(m, u, kon) ? eq(table.ownerId, idOf(u)) : undefined;

  const describe = defineOperation({
    id: ids.describe,
    method: "GET",
    route: routes.describe,
    summary: `Describe the ${m.tag} model`,
    description: `Fields, types, access policy and scopes of the '${m.name}' model (${m.description}). The admin panel builds its list and forms from this.`,
    tags,
    output: { schema: modelDescriptorSchema, description: "The model descriptor" },
    access: accessRead,
    permission: readPermission,
    handle: async (_e, h): Promise<ModelDescriptor> => {
      await h.authorize();
      return modelDescriptor(m);
    },
  });

  const list = defineOperation({
    id: ids.list,
    method: "GET",
    route: routes.collection,
    summary: `List ${m.plural}`,
    description: `Lists ${m.plural} (${m.description}) you can see, newest first, paginated with limit/offset.${
      withOwner && m.access.read === "owner"
        ? " Only your own rows unless you administer this kon."
        : ""
    }`,
    tags,
    input: { query: esq.query },
    output: { schema: esq.list, description: "A page of rows" },
    access: accessRead,
    permission: readPermission,
    guide: {
      whenToUse: `To find ${m.plural} or get their ids. To read one by id use ${ids.get}.`,
      examples: [{ title: "First page", args: { limit: 10 } }],
    },
    handle: async ({ query }, h) => {
      await h.authorize();
      const qy = (query ?? {}) as Record<string, unknown>;
      const limit = (qy.limit as number | undefined) ?? DEFAULT_LIMIT;
      const offset = (qy.offset as number | undefined) ?? 0;
      const order = (qy.sort as string | undefined) ?? "-createdAt";
      const conditions: SQL[] = [];
      const ownValue = readFilter(h.user);
      if (ownValue) conditions.push(ownValue);
      for (const [key, value] of Object.entries(qy)) {
        if (key === "limit" || key === "offset" || key === "sort" || value === undefined) continue;
        const c = m.fields[key];
        if (!c) continue;
        conditions.push(eq(table[key], c.type === "boolean" ? value === "true" : value));
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const orderField = order.replace(/^-/, "");
      const byOrder = order.startsWith("-") ? desc(table[orderField]) : asc(table[orderField]);
      // In series: one transaction, one query at a time (SDK rule 1).
      const data = (await db(h)
        .select()
        .from(table)
        .where(where)
        .orderBy(byOrder, desc(table.id))
        .limit(limit)
        .offset(offset)) as Row[];
      const [{ n }] = (await db(h).select({ n: count() }).from(table).where(where)) as {
        n: number;
      }[];
      return { data, total: Number(n), limit, offset };
    },
  });

  const get = defineOperation({
    id: ids.get,
    method: "GET",
    route: routes.row,
    summary: `Get a ${m.tag}`,
    description: `Reads one ${m.name} by id. 404 if it does not exist or you cannot see it (the API never says which).`,
    tags,
    input: { params: esq.params },
    output: { schema: esq.row },
    access: accessRead,
    permission: readPermission,
    errors: ["KITSUDEN_E_NOT_FOUND"],
    guide: { before },
    handle: async ({ params }, h) => {
      await h.authorize();
      const ownValue = readFilter(h.user);
      const [row] = (await db(h)
        .select()
        .from(table)
        .where(and(eq(table.id, (params as { id: string }).id), ownValue))
        .limit(1)) as Row[];
      if (!row) throw AppError.notFound(`${m.name} not found`);
      return row;
    },
  });

  const create = defineOperation({
    id: ids.create,
    method: "POST",
    route: routes.collection,
    summary: `Create a ${m.tag}`,
    description: `Creates a ${m.name} (${m.description}).${
      withOwner ? " You become its owner." : ""
    } Send Idempotency-Key to retry safely. Agents need the '${scopes.write}' scope.`,
    tags,
    input: { body: esq.create },
    output: { status: 201, schema: esq.row, description: "The created row" },
    access: "session",
    permission: writePermission,
    sensitive: m.sensitive.create,
    errors: hasUnique ? ["KITSUDEN_E_CONFLICT"] : [],
    handle: async ({ body: body }, h) => {
      await h.authorize();
      const values: Row = { ...(body as Row) };
      if (withOwner) {
        const chosenItem = choosesOwner(m) ? (values.ownerId as string | undefined) : undefined;
        values.ownerId = chosenItem ?? idOf(h.user);
      } else {
        delete values.ownerId;
      }
      const [row] = (await db(h).insert(table).values(values).returning()) as Row[];
      await enqueueEmbedding(row);
      return row;
    },
  });

  const update = defineOperation({
    id: ids.update,
    method: "PATCH",
    route: routes.row,
    summary: `Update a ${m.tag}`,
    description: `Changes the fields you send of one ${m.name}; the rest stay as they are. 404 if it does not exist or is not yours to change. Agents need the '${scopes.write}' scope.`,
    tags,
    input: { params: esq.params, body: esq.update },
    output: { schema: esq.row, description: "The updated row" },
    access: "session",
    permission: writePermission,
    sensitive: m.sensitive.update,
    errors: ["KITSUDEN_E_NOT_FOUND", ...(hasUnique ? (["KITSUDEN_E_CONFLICT"] as const) : [])],
    guide: { before },
    handle: async ({ params, body: body }, h) => {
      await h.authorize();
      const ownValue = writeFilter(h.user);
      const [row] = (await db(h)
        .update(table)
        .set({ ...(body as Row), updatedAt: new Date() })
        .where(and(eq(table.id, (params as { id: string }).id), ownValue))
        .returning()) as Row[];
      if (!row) throw AppError.notFound(`${m.name} not found`);
      await enqueueEmbedding(row);
      return row;
    },
  });

  const remove = defineOperation({
    id: ids.remove,
    method: "DELETE",
    route: routes.row,
    summary: `Delete a ${m.tag}`,
    description: `Deletes one ${m.name}. Sensitive by default: an agent in approval mode gets 202 KITSUDEN_E_APPROVAL_REQUIRED and a human decides. 404 if it does not exist or is not yours.`,
    tags,
    input: { params: esq.params },
    output: { status: 204, description: "Deleted" },
    access: "session",
    permission: writePermission,
    sensitive: m.sensitive.remove,
    errors: ["KITSUDEN_E_NOT_FOUND"],
    guide: { before },
    handle: async ({ params }, h) => {
      await h.authorize();
      const ownValue = writeFilter(h.user);
      const deleted = (await db(h)
        .delete(table)
        .where(and(eq(table.id, (params as { id: string }).id), ownValue))
        .returning({ id: table.id })) as Row[];
      if (deleted.length === 0) throw AppError.notFound(`${m.name} not found`);
      return null;
    },
  });

  // D5: semantic search. It goes BEFORE `get`: `/<plural>/search`
  // would otherwise match `/<plural>/:id`.
  const search = m.semantics
    ? defineOperation({
        id: `search-${m.plural}`,
        method: "GET",
        route: `/${m.plural}/search`,
        summary: `Semantic search over ${m.plural}`,
        description: `The ${m.plural} you can see whose meaning is closest to \`q\` (embeddings of ${m.semantics.fields.join(", ")}), best first, with \`score\` (1 = identical). Rows written moments ago may not be searchable yet: their embedding is computed in the background.`,
        tags,
        input: {
          query: z.object({
            q: z.string().trim().min(1).max(2000),
            limit: z.coerce.number().int().min(1).max(50).default(10),
          }),
        },
        output: {
          schema: z.object({ data: z.array(esq.row.extend({ score: z.number() })) }),
          description: "The closest rows",
        },
        access: accessRead,
        permission: readPermission,
        guide: {
          whenToUse: `To find ${m.plural} by meaning rather than exact words. For exact filters use ${ids.list}.`,
          examples: [{ title: "Search", args: { q: "example", limit: 5 } }],
        },
        handle: async ({ query }, h) => {
          await h.authorize();
          const qy = query as { q: string; limit: number };
          const vector = vectorLiteral(await embed(qy.q, m.semantics!.dimensions));
          const distance = sql`"embedding" <=> ${vector}::vector`;
          const conditions: SQL[] = [sql`"embedding" IS NOT NULL`];
          const ownValue = readFilter(h.user);
          if (ownValue) conditions.push(ownValue);
          const data = (await db(h)
            .select({ ...getTableColumns(table), score: sql<number>`1 - (${distance})` })
            .from(table)
            .where(and(...conditions))
            .orderBy(distance)
            .limit(qy.limit)) as Row[];
          return { data: data.map((f) => ({ ...f, score: Number(f.score) })) };
        },
      })
    : null;

  const ops = (
    search
      ? [describe, list, search, get, create, update, remove]
      : [describe, list, get, create, update, remove]
  ) as AnyOperation[];
  for (const op of ops) modelPerOperation.set(op, { konId, model: m });
  return ops;
}

// ── El kon ──────────────────────────────────────────────────────────────────

export type ModelsKonDefinition = Omit<SdkKonDefinition, "operations"> & {
  models: Model[];
  /** The kon's own operations, in addition to those of its models (they go last). */
  operations?: SdkKonDefinition["operations"];
};

/**
 * A kon whose models generate its operations. It is a normal `defineKonSdk`:
 * the loader mounts it, per-request RLS and idempotency are inherited, and
 * its operations appear in OpenAPI and MCP like those of any kon.
 */
export function defineModelsKon(def: ModelsKonDefinition): KonDefinition {
  const { models: models, operations: ownItems, ...rest } = def;
  if (!models?.length) throw new Error(`${def.id}: defineModelsKon needs at least one model`);
  registerModelPolicies(def.id, models);
  const ofModels = models.flatMap((m) => modelOperations(def.id, m));
  const modelTables = models.map((m) => m.table);
  const kon = defineKonSdk({
    ...rest,
    tables: [...new Set([...(rest.tables ?? []), ...modelTables])],
    operations: (ctx: KonContext) => [
      ...ofModels,
      ...(typeof ownItems === "function" ? ownItems(ctx) : (ownItems ?? [])),
    ],
  });
  const createRouter = kon.createRouter;
  return {
    ...kon,
    createRouter: (ctx: KonContext) => {
      // After a `resetAuthz()` (tests) the policy has to come back.
      registerModelPolicies(def.id, models);
      return createRouter(ctx);
    },
  };
}

// ── What is mounted (read by GET /api/models) ───────────────────────────────

export interface MountedModel {
  konId: string;
  /** No trailing slash: `/api/notes`. */
  mountPath: string;
  /** Where the collection lives: `/api/notes/notes`. */
  base: string;
  descriptor: ModelDescriptor;
}

/** The models of the mounted kons (by their `describe-*` operations). */
export function mountedModels(): MountedModel[] {
  const list: MountedModel[] = [];
  for (const { konId, mountPath, operations } of mountedOperations()) {
    for (const op of operations) {
      const described = operationModel(op);
      if (!described || op.id !== modelOperationIds(described.model).describe) continue;
      list.push({
        konId,
        mountPath,
        base: `${mountPath}${modelRoutes(described.model).collection}`,
        descriptor: modelDescriptor(described.model),
      });
    }
  }
  return list;
}
