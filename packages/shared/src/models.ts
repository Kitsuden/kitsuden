/**
 * defineModel: declare a model once
 * ============================================================================
 *
 * A kon (or the app) declares a model with its fields and its ACCESS POLICY,
 * and everything else comes out of that declaration:
 *
 *   · the Drizzle table (`modelTable`, in @kitsuden/engine);
 *   · the SQL migration and the `makemigrations`-style diff (`models-sql.ts`):
 *     it is GENERATED in the kon's or the app's migrations folder, and is never
 *     run on its own against anything;
 *   · the kon SDK operations (`defineOperation`): REST, OpenAPI 3.1 and
 *     MCP tools come out of them, with the zod validation from here;
 *   · Postgres RLS according to the declared policy (owner / team /
 *     public), with the core's agent functions;
 *   · the agent scopes `<model>:read` and `<model>:write` (an agent NEVER
 *     writes by default: it needs the write scope, a fine one of the kon,
 *     the broad one of the kon or `admin`) and the sensitivity (DELETE is sensitive);
 *   · the panel view (`modelDescriptor`: list, create and edit).
 *
 * This file is CONTRACT and is pure (no database, no Hono, no Drizzle): the
 * engine, the API, the panel, the CLI (`kitsuden makemigrations`, which
 * loads it with bun) and the tests read it.
 *
 * Safe by default: there is no model without `access`. `defineModel` throws if
 * it is missing or if it asks for something that does not exist; there is no "open for now".
 *
 * Public guide: docs/agents/models.md.
 */

import { z, type ZodTypeAny } from "zod";

import { dateSchema } from "./operations";

/** Version of the model format (descriptor and snapshot). Integer. */
export const MODELS_VERSION = 1;

// ── Fields ──────────────────────────────────────────────────────────────────

export type FieldType =
  "text" | "longText" | "integer" | "number" | "boolean" | "date" | "enum" | "json" | "uuid";

export const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "longText",
  "integer",
  "number",
  "boolean",
  "date",
  "enum",
  "json",
  "uuid",
];

/** A default value that can be written in SQL and in JSON. */
export type DefaultValue = string | number | boolean | null | Record<string, unknown> | unknown[];

/** The declaration of a field (what the `field` constructors return). */
export interface Field {
  type: FieldType;
  /** NOT NULL and required on create (unless it has `defaultValue`). */
  required: boolean;
  /** UNIQUE in the table (409 KITSUDEN_E_CONFLICT on repeat). */
  unique: boolean;
  /**
   * Default value. It lives in the COLUMN (`DEFAULT`), not in zod: that way rows
   * that come in through SQL respect it too. In `date`, `"now"` is
   * `now()`.
   */
  defaultValue?: DefaultValue;
  /** Text: minimum/maximum length. Integer/number: minimum/maximum value. */
  min?: number;
  max?: number;
  /** `enum` only. */
  values?: readonly string[];
  /** For the panel (by default, the key). */
  tag?: string;
  /** For humans and agents (OpenAPI, MCP, panel). */
  description?: string;
  /** Simple index on the column. */
  index?: boolean;
  /**
   * PREVIOUS name of the field: `makemigrations` renames it (RENAME COLUMN)
   * instead of dropping and creating. Remove it once the migration is already applied.
   */
  before?: string;
}

type CommonOptions = Partial<
  Pick<Field, "required" | "unique" | "tag" | "description" | "index" | "before">
>;

/** Field constructors: `field.text({ max: 200, required: true })`. */
export const field = {
  text: (o: CommonOptions & { min?: number; max?: number; defaultValue?: string } = {}): Field =>
    base("text", o),
  longText: (o: CommonOptions & { max?: number; defaultValue?: string } = {}): Field =>
    base("longText", o),
  integer: (o: CommonOptions & { min?: number; max?: number; defaultValue?: number } = {}): Field =>
    base("integer", o),
  number: (o: CommonOptions & { min?: number; max?: number; defaultValue?: number } = {}): Field =>
    base("number", o),
  boolean: (o: CommonOptions & { defaultValue?: boolean } = {}): Field => base("boolean", o),
  date: (o: CommonOptions & { defaultValue?: "now" } = {}): Field => base("date", o),
  enum: (values: readonly string[], o: CommonOptions & { defaultValue?: string } = {}): Field =>
    base("enum", { ...o, values: [...values] }),
  json: (o: CommonOptions & { defaultValue?: Record<string, unknown> | unknown[] } = {}): Field =>
    base("json", o),
  uuid: (o: CommonOptions = {}): Field => base("uuid", o),
};

function base(type: FieldType, o: Partial<Field>): Field {
  const c: Field = { type, required: o.required ?? false, unique: o.unique ?? false };
  for (const k of [
    "defaultValue",
    "min",
    "max",
    "values",
    "tag",
    "description",
    "index",
    "before",
  ] as const) {
    if (o[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = o[k];
  }
  return c;
}

// ── Access (required) ───────────────────────────────────────────────────────

/**
 * Who READS the rows:
 *   public   anyone, including without a session (and any agent).
 *   owner    each account sees its own (`owner_id` column); the admin (or the
 *            agent that opens the whole kon) sees them all.
 *   staff    admin and editor (or the agent that opens the whole kon).
 *
 * There is no "any signed-in account sees everything": `verify-rls` treats as
 * a leak whatever an unknown user sees and the anonymous one does not, and it is right.
 */
export type ModelRead = "public" | "owner" | "staff";

/**
 * Who WRITES (create, edit, delete):
 *   owner   any account creates; edits and deletes only its own (admin: everything).
 *   staff   admin and editor (or the agent that opens the whole kon).
 *
 * Never "public": a model is not written without a session. An agent additionally
 * needs `<model>:write` (or a fine/broad scope of the kon, or `admin`).
 */
export type ModelWrite = "owner" | "staff";

export interface ModelAccess {
  read: ModelRead;
  write: ModelWrite;
}

export const MODEL_READS: readonly ModelRead[] = ["public", "owner", "staff"];
export const MODEL_WRITES: readonly ModelWrite[] = ["owner", "staff"];

// ── The model ───────────────────────────────────────────────────────────────

export interface ModelDeclaration<C extends Record<string, Field> = Record<string, Field>> {
  /** Singular, kebab-case: `note`, `task-item`. It is contract (scopes, tools). */
  name: string;
  /** Plural, kebab-case (by default `name + "s"`): routes and the list operation. */
  plural?: string;
  /** Table (by default, the plural in snake_case). */
  table?: string;
  /** For humans and agents: what a row is. */
  description: string;
  /** For the panel (by default, the name). */
  tag?: string;
  fields: C;
  /** REQUIRED. Without an access policy there is no model. */
  access: ModelAccess;
  /** The field shown as the title of a row in the panel (by default, the first text one). */
  title?: Extract<keyof C, string>;
  /**
   * Which operations end up as a PROPOSAL when an agent requests them in
   * selective mode. By default only delete (like the SDK: DELETE is sensitive).
   */
  sensitive?: { create?: boolean; update?: boolean; remove?: boolean };
  /**
   * SEMANTIC search : one embedding per row, computed in the
   * background (the Postgres queue) from these text fields, in
   * an `embedding vector(dimensions)` pgvector column with an HNSW index. It gives
   * the operation `search-<plural>` (`GET /<plural>/search?q=`), with the same
   * access policy as listing. `dimensions` (default 1536) must
   * match the embeddings model configured in the API.
   */
  semantics?: { fields: Extract<keyof C, string>[]; dimensions?: number };
}

const MARK = Symbol.for("kitsuden.model");

/** A model already checked, with everything resolved. It is a data object (JSON-able except for the mark). */
export interface Model<C extends Record<string, Field> = Record<string, Field>> {
  readonly [MARK]: true;
  readonly version: typeof MODELS_VERSION;
  readonly name: string;
  readonly plural: string;
  readonly table: string;
  readonly description: string;
  readonly tag: string;
  readonly fields: C;
  readonly access: ModelAccess;
  readonly title: string | null;
  readonly sensitive: { create: boolean; update: boolean; remove: boolean };
  /** `null` = no semantic search. */
  readonly semantics: { fields: string[]; dimensions: number } | null;
}

export function isModel(x: unknown): x is Model {
  return !!x && typeof x === "object" && (x as Record<symbol, unknown>)[MARK] === true;
}

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KEY = /^[a-z][a-zA-Z0-9]*$/;
const TABLE = /^[a-z][a-z0-9_]*$/;

/** Columns the model adds: they cannot be declared as fields. */
export const SYSTEM_COLUMNS = ["id", "owner_id", "created_at", "updated_at"] as const;
/** Keys (camelCase) of those columns in the API. */
export const SYSTEM_KEYS = ["id", "ownerId", "createdAt", "updatedAt"] as const;

/**
 * Names that cannot be models: their scope (`<name>:read`) would clash with
 * a broad one of the core (`admin:*`, `mcp:read`, `datasets:*`…).
 */
export const RESERVED_NAMES = [
  "admin",
  "mcp",
  "kon",
  "datasets",
  "user",
  "content",
  "memory",
  "brain",
  "promotion",
  "mail",
  "gate",
  "models",
  "model",
] as const;

/** `dueDate` → `due_date`. */
export function fieldColumn(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `task-items` → `task_items`. */
function snake(s: string): string {
  return s.replace(/-/g, "_");
}

const MAX_IDENTIFIER = 63;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/**
 * Declares a model. It checks AT DECLARATION what would later be a silent
 * failure or an open door: well-formed names, access policy
 * present and known, typed fields, valid default values,
 * SQL identifiers that fit in 63 characters.
 */
function semanticsOf(
  d: ModelDeclaration<Record<string, Field>>,
  where: string
): { fields: string[]; dimensions: number } | null {
  if (!d.semantics) return null;
  const fields = [...new Set(d.semantics.fields ?? [])];
  if (fields.length === 0)
    throw new Error(`${where}: semantics.fields needs at least one text field`);
  for (const c of fields) {
    const def = d.fields[c];
    if (!def) throw new Error(`${where}: semantics.fields names '${c}', which is not a field`);
    if (def.type !== "text" && def.type !== "longText") {
      throw new Error(
        `${where}: semantics.fields only accepts text or longText ('${c}' is ${def.type})`
      );
    }
  }
  const dimensions = d.semantics.dimensions ?? 1536;
  // pgvector's HNSW index supports up to 2,000 dimensions in `vector`.
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 2000) {
    throw new Error(
      `${where}: semantics.dimensions is an integer between 1 and 2000 (the limit of pgvector's HNSW index)`
    );
  }
  return { fields, dimensions };
}

/** The id of a model's semantic search operation. */
export function modelSearchId(m: Pick<Model, "plural">): string {
  return `search-${m.plural}`;
}

export function defineModel<C extends Record<string, Field>>(d: ModelDeclaration<C>): Model<C> {
  const where = `model '${String(d?.name)}'`;
  if (!d || typeof d !== "object") throw new Error("defineModel: missing declaration");
  if (!KEBAB.test(d.name ?? ""))
    throw new Error(`${where}: the name must be singular kebab-case ([a-z0-9-])`);
  if ((RESERVED_NAMES as readonly string[]).includes(d.name)) {
    throw new Error(`${where}: '${d.name}' is reserved (its scope would clash with a core one)`);
  }
  const plural = d.plural ?? `${d.name}s`;
  if (!KEBAB.test(plural)) throw new Error(`${where}: the plural must be kebab-case`);
  if (plural === d.name) throw new Error(`${where}: the plural must differ from the name`);
  const table = d.table ?? snake(plural);
  if (!TABLE.test(table) || table.length > 40) {
    throw new Error(`${where}: table '${table}' must be snake_case and at most 40 characters`);
  }
  if (!d.description?.trim())
    throw new Error(`${where}: a description is required (humans and agents read it)`);

  // The access policy: required, and only with known values.
  const declaredAccess = d.access as ModelAccess | undefined;
  const access =
    declaredAccess && typeof declaredAccess === "object"
      ? { ...declaredAccess, read: declaredAccess.read, write: declaredAccess.write }
      : undefined;
  if (!access || typeof access !== "object") {
    throw new Error(
      `${where}: 'access' is missing. A model without an access policy cannot be declared ` +
        `(e.g. access: { read: "owner", write: "owner" }).`
    );
  }
  if (!MODEL_READS.includes(access.read)) {
    throw new Error(
      `${where}: access.read is ${MODEL_READS.join(" | ")} (got '${String(access.read)}')`
    );
  }
  if (!MODEL_WRITES.includes(access.write)) {
    throw new Error(
      `${where}: access.write is ${MODEL_WRITES.join(" | ")} (got '${String(access.write)}'); ` +
        `public write access does not exist`
    );
  }
  if (access.read === "staff" && access.write === "owner") {
    throw new Error(
      `${where}: with read "staff" and write "owner" the owner could not read what they write; use read "owner"`
    );
  }
  const extra = Object.keys(access).filter((k) => k !== "read" && k !== "write");
  if (extra.length) throw new Error(`${where}: access does not know ${extra.join(", ")}`);

  const fields = (d.fields ?? {}) as C;
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new Error(`${where}: declare at least one field`);
  const columns = new Set<string>();
  for (const key of keys) {
    const c = fields[key]!;
    const at = `${where}, field '${key}'`;
    if (!KEY.test(key))
      throw new Error(
        `${at}: the key must be camelCase ([a-zA-Z0-9], starting with a lowercase letter)`
      );
    if ((SYSTEM_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${at}: '${key}' is set by the model; choose another name`);
    }
    const column = fieldColumn(key);
    if ((SYSTEM_COLUMNS as readonly string[]).includes(column) || columns.has(column)) {
      throw new Error(`${at}: column '${column}' already exists`);
    }
    columns.add(column);
    if (`${table}_${column}_check`.length > MAX_IDENTIFIER) {
      throw new Error(
        `${at}: '${table}_${column}_check' exceeds ${MAX_IDENTIFIER} characters; shorten the table or the key`
      );
    }
    if (!c || !FIELD_TYPES.includes(c.type))
      throw new Error(`${at}: unknown type (use field.text(), field.integer()…)`);
    if (c.type === "enum") {
      if (!c.values?.length) throw new Error(`${at}: an enum needs values`);
      if (new Set(c.values).size !== c.values.length) throw new Error(`${at}: repeated values`);
      for (const v of c.values) {
        if (typeof v !== "string" || !v || v.length > 100)
          throw new Error(`${at}: each value is text of 1 to 100 characters`);
      }
    } else if (c.values) {
      throw new Error(`${at}: 'values' only applies to an enum`);
    }
    if (
      (c.min !== undefined || c.max !== undefined) &&
      !["text", "longText", "integer", "number"].includes(c.type)
    ) {
      throw new Error(`${at}: min/max only apply to text and numbers`);
    }
    for (const lim of [c.min, c.max]) {
      if (lim !== undefined && !Number.isFinite(lim)) throw new Error(`${at}: min/max are numbers`);
    }
    if (c.min !== undefined && c.max !== undefined && c.min > c.max)
      throw new Error(`${at}: min > max`);
    if ((c.type === "text" || c.type === "longText") && c.max !== undefined) {
      if (!Number.isInteger(c.max) || c.max < 1 || c.max > 10_485_760)
        throw new Error(`${at}: max of a text is an integer between 1 and 10485760`);
    }
    if (c.type === "integer") {
      if ((c.min ?? 0) < INT_MIN || (c.max ?? 0) > INT_MAX)
        throw new Error(`${at}: an integer fits in 32 bits`);
    }
    if (c.before !== undefined && (!KEY.test(c.before) || c.before === key)) {
      throw new Error(`${at}: 'before' is the field's previous key, in camelCase`);
    }
    if (c.defaultValue !== undefined) {
      if (c.type === "date") {
        if (c.defaultValue !== "now")
          throw new Error(`${at}: the only default value of a date is "now"`);
      } else if (c.type === "uuid") {
        throw new Error(`${at}: a uuid has no default value`);
      } else {
        const r = fieldSchema(c).safeParse(c.defaultValue);
        if (!r.success)
          throw new Error(
            `${at}: the default value does not validate (${r.error.issues[0]?.message ?? "invalid"})`
          );
      }
    }
  }
  if (d.title !== undefined && !keys.includes(d.title)) {
    throw new Error(`${where}: title '${String(d.title)}' is not a field`);
  }
  const title =
    d.title ??
    keys.find((k) => fields[k]!.type === "text") ??
    keys.find((k) => fields[k]!.type === "longText") ??
    null;

  const model = {
    [MARK]: true as const,
    version: MODELS_VERSION,
    name: d.name,
    plural,
    table,
    description: d.description.trim(),
    tag: d.tag ?? d.name,
    fields,
    access: { read: access.read, write: access.write },
    title,
    semantics: semanticsOf(
      { ...d, fields } as unknown as ModelDeclaration<Record<string, Field>>,
      where
    ),
    sensitive: {
      create: d.sensitive?.create ?? false,
      update: d.sensitive?.update ?? false,
      remove: d.sensitive?.remove ?? true,
    },
  };
  return Object.freeze(model) as Model<C>;
}

// ── What is derived (pure) ─────────────────────────────────────────────────

/** Does it carry an `owner_id` column? Whenever any rule talks about the owner. */
export function hasOwner(m: Pick<Model, "access">): boolean {
  return m.access.read === "owner" || m.access.write === "owner";
}

/**
 * Can the creator choose the owner? Only in "the team writes rows that
 * each owner reads" (e.g. the team assigns tasks): the team says whose it is.
 */
export function choosesOwner(m: Pick<Model, "access">): boolean {
  return m.access.read === "owner" && m.access.write === "staff";
}

/** The model's agent scopes. They are contract. */
export function modelScopes(m: Pick<Model, "name">): { read: string; write: string } {
  return { read: `${m.name}:read`, write: `${m.name}:write` };
}

/** The ids (kebab-case, they are contract) of the model's operations. */
export function modelOperationIds(m: Pick<Model, "name" | "plural">) {
  return {
    describe: `describe-${m.name}`,
    list: `list-${m.plural}`,
    get: `get-${m.name}`,
    create: `create-${m.name}`,
    update: `update-${m.name}`,
    remove: `delete-${m.name}`,
  } as const;
}

/** The routes, relative to the kon's mount. */
export function modelRoutes(m: Pick<Model, "plural">) {
  return {
    describe: `/${m.plural}/_model`,
    collection: `/${m.plural}`,
    row: `/${m.plural}/:id`,
  } as const;
}

/** The zod schema of a field value (input), without optionality. */
export function fieldSchema(c: Field): ZodTypeAny {
  let s: ZodTypeAny;
  switch (c.type) {
    case "text":
    case "longText": {
      let t = z.string();
      if (c.min !== undefined) t = t.min(c.min);
      else if (c.required) t = t.min(1);
      if (c.max !== undefined) t = t.max(c.max);
      s = t;
      break;
    }
    case "integer": {
      s = z
        .number()
        .int()
        .min(c.min ?? INT_MIN)
        .max(c.max ?? INT_MAX);
      break;
    }
    case "number": {
      let n = z.number();
      if (c.min !== undefined) n = n.min(c.min);
      if (c.max !== undefined) n = n.max(c.max);
      s = n;
      break;
    }
    case "boolean":
      s = z.boolean();
      break;
    case "date":
      s = dateSchema();
      break;
    case "enum":
      s = z.enum(c.values as [string, ...string[]]);
      break;
    case "json":
      s = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);
      break;
    case "uuid":
      s = z.guid();
      break;
  }
  return c.description ? s.describe(c.description) : s;
}

/** The OUTPUT schema of a value (how it travels in JSON). */
function outputSchema(c: Field): ZodTypeAny {
  switch (c.type) {
    case "date":
      return z.iso.datetime({ offset: true });
    case "json":
      return z.unknown();
    case "uuid":
      return z.guid();
    case "enum":
      return z.enum(c.values as [string, ...string[]]);
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    default:
      return z.string();
  }
}

function optionalOnCreate(c: Field): boolean {
  return !c.required || c.defaultValue !== undefined;
}

/** Sortable fields in the list (everything except json and long text). */
export function sortableFields(m: Pick<Model, "fields">): string[] {
  return Object.entries(m.fields)
    .filter(([, c]) => c.type !== "json" && c.type !== "longText")
    .map(([k]) => k);
}

/** Fields filtered by equality in the list. */
export function filterableFields(m: Pick<Model, "fields">): string[] {
  return Object.entries(m.fields)
    .filter(([, c]) => c.type === "enum" || c.type === "boolean" || c.type === "uuid")
    .map(([k]) => k);
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * The model's zod schemas. No `.default()` after a `transform` (a zod 4
 * trap): default values are set by the column, and the list applies
 * its own in the handler.
 */
export function modelSchemas(m: Model) {
  const create: Record<string, ZodTypeAny> = {};
  const update: Record<string, ZodTypeAny> = {};
  const row: Record<string, ZodTypeAny> = { id: z.guid() };
  if (hasOwner(m)) row.ownerId = z.string().nullable();
  for (const [key, c] of Object.entries(m.fields)) {
    const v = fieldSchema(c);
    const nullable = c.required ? v : v.nullable();
    create[key] = optionalOnCreate(c) ? nullable.optional() : nullable;
    update[key] = nullable.optional();
    const output = outputSchema(c);
    row[key] = c.required ? output : output.nullable();
  }
  if (choosesOwner(m)) {
    create.ownerId = z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Owner account id (defaults to the creator)");
  }
  row.createdAt = z.iso.datetime({ offset: true });
  row.updatedAt = z.iso.datetime({ offset: true });

  const sortable = sortableFields(m);
  const order = ["createdAt", "updatedAt", ...sortable];
  const query: Record<string, ZodTypeAny> = {
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Page size (default ${DEFAULT_LIMIT})`),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe("Rows to skip (default 0)"),
    sort: z
      .enum([...order, ...order.map((o) => `-${o}`)] as [string, ...string[]])
      .optional()
      .describe("Field to sort by; prefix with '-' for descending (default -createdAt)"),
  };
  for (const key of filterableFields(m)) {
    const c = m.fields[key]!;
    query[key] =
      c.type === "boolean"
        ? z.enum(["true", "false"]).optional().describe(`Only rows whose ${key} is this`)
        : fieldSchema(c).optional().describe(`Only rows whose ${key} is this`);
  }
  const rowSchema = z.object(row);
  return {
    create: z.object(create),
    update: z.object(update),
    row: rowSchema,
    list: z.object({
      data: z.array(rowSchema),
      total: z.number().int(),
      limit: z.number().int(),
      offset: z.number().int(),
    }),
    query: z.object(query),
    params: z.object({ id: z.guid() }),
  };
}

// ── Descriptor (what the panel draws and an agent reads) ───────────────────

export interface DescribedField {
  key: string;
  column: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  tag: string;
  description?: string;
  min?: number;
  max?: number;
  values?: string[];
  defaultValue?: DefaultValue;
}

export interface ModelDescriptor {
  version: number;
  name: string;
  plural: string;
  table: string;
  tag: string;
  description: string;
  title: string | null;
  access: ModelAccess;
  withOwner: boolean;
  choosesOwner: boolean;
  scopes: { read: string; write: string };
  operations: ReturnType<typeof modelOperationIds>;
  fields: DescribedField[];
  sortable: string[];
  filterable: string[];
}

export function modelDescriptor(m: Model): ModelDescriptor {
  return {
    version: MODELS_VERSION,
    name: m.name,
    plural: m.plural,
    table: m.table,
    tag: m.tag,
    description: m.description,
    title: m.title,
    access: { ...m.access },
    withOwner: hasOwner(m),
    choosesOwner: choosesOwner(m),
    scopes: modelScopes(m),
    operations: modelOperationIds(m),
    fields: Object.entries(m.fields).map(([key, c]) => ({
      key,
      column: fieldColumn(key),
      type: c.type,
      required: c.required,
      unique: c.unique,
      tag: c.tag ?? key,
      ...(c.description ? { description: c.description } : {}),
      ...(c.min !== undefined ? { min: c.min } : {}),
      ...(c.max !== undefined ? { max: c.max } : {}),
      ...(c.values ? { values: [...c.values] } : {}),
      ...(c.defaultValue !== undefined ? { defaultValue: c.defaultValue } : {}),
    })),
    sortable: sortableFields(m),
    filterable: filterableFields(m),
  };
}

/** The descriptor's schema (output of `describe-<model>` and of `/api/models`). */
export const modelDescriptorSchema = z.looseObject({
  version: z.number().int(),
  name: z.string(),
  plural: z.string(),
  table: z.string(),
  tag: z.string(),
  description: z.string(),
  title: z.string().nullable(),
  access: z.object({
    read: z.enum(MODEL_READS as [ModelRead, ...ModelRead[]]),
    write: z.enum(MODEL_WRITES as [ModelWrite, ...ModelWrite[]]),
  }),
  withOwner: z.boolean(),
  choosesOwner: z.boolean(),
  scopes: z.object({ read: z.string(), write: z.string() }),
  operations: z.record(z.string(), z.string()),
  fields: z.array(
    z.looseObject({
      key: z.string(),
      column: z.string(),
      type: z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]),
      required: z.boolean(),
      unique: z.boolean(),
      tag: z.string(),
    })
  ),
  sortable: z.array(z.string()),
  filterable: z.array(z.string()),
});
