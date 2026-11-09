/**
 * defineModel → SQL: the table, the RLS and the `makemigrations` diff (pure)
 * ============================================================================
 *
 * `kitsuden makemigrations` stores next to the migrations a SNAPSHOT of
 * the models as they stood after the last generated migration
 * (`migrations/models.snapshot.json`). The next time it compares the
 * snapshot with the declared models and writes ONLY the difference:
 *
 *   new model               CREATE TABLE + indexes + RLS
 *   new field               ADD COLUMN (required without a default: it is
 *                           refused, like Django, because it would fail with rows)
 *   `before: "oldKey"`       RENAME COLUMN (instead of dropping and creating)
 *   type / length           ALTER COLUMN … TYPE … USING
 *   required                SET / DROP NOT NULL (filling in the default
 *                           before SET NOT NULL, if there is one)
 *   default value           SET / DROP DEFAULT
 *   values, min, max        the named CHECK is rebuilt
 *   unique / index          ADD / DROP CONSTRAINT, CREATE / DROP INDEX
 *   access policy           the four RLS policies are rebuilt
 *   removed field or model  DESTRUCTIVE: comes out COMMENTED unless
 *                           `allowDestructive` (and the required column
 *                           that is left behind becomes NULL, so the app can
 *                           keep inserting)
 *
 * Nothing is ever executed here: the text is returned. It is applied by the usual runner
 * (`bun run scripts/migrate.ts`, or the panel when enabling the kon) with the
 * DDL connection, in file order.
 *
 * The RLS uses the core functions `kitsuden_effective_admin(kon)` and
 * `kitsuden_effective_staff(kon)` (apps/api/src/db/agent-functions.sql, which
 * the runner applies BEFORE each kon's migrations): so an agent that
 * opens the whole kon (`<kon>:*`, `admin`) is treated the same as in TypeScript.
 */

import { fieldColumn, hasOwner, type ModelAccess, type Field, type Model } from "./models";

export const SNAPSHOT_VERSION = 1;

export interface SnapshotColumn {
  /** Key of the field (camelCase). */
  key: string;
  column: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  check: string | null;
  unique: boolean;
  index: boolean;
}

export interface ModelSnapshot {
  name: string;
  table: string;
  kon: string;
  access: ModelAccess;
  columns: SnapshotColumn[];
  /** Semantic search. Absent = without it (so old snapshots do not change). */
  semantics?: { fields: string[]; dimensions: number };
}

export interface Snapshot {
  version: number;
  models: Record<string, ModelSnapshot>;
}

/** A persisted snapshot, or an empty one. */
export function normalizeSnapshot(raw: unknown): Snapshot {
  const source = (raw ?? {}) as Partial<Snapshot>;
  return { version: source.version ?? SNAPSHOT_VERSION, models: source.models ?? {} };
}

export function emptySnapshot(): Snapshot {
  return { version: SNAPSHOT_VERSION, models: {} };
}

// ── SQL of a field ─────────────────────────────────────────────────────────

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;

export function sqlType(c: Field): string {
  switch (c.type) {
    case "text":
      return c.max !== undefined ? `varchar(${c.max})` : "text";
    case "longText":
      return "text";
    case "integer":
      return "integer";
    case "number":
      return "double precision";
    case "boolean":
      return "boolean";
    case "date":
      return "timestamp with time zone";
    case "enum":
      return "text";
    case "json":
      return "jsonb";
    case "uuid":
      return "uuid";
  }
}

function sqlDefault(c: Field): string | null {
  const v = c.defaultValue;
  if (v === undefined || v === null) return null;
  if (c.type === "date") return "now()";
  if (c.type === "json") return `${literal(JSON.stringify(v))}::jsonb`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return literal(String(v));
}

function checkSql(c: Field, column: string): string | null {
  const col = q(column);
  const parts: string[] = [];
  if (c.type === "enum" && c.values?.length) {
    parts.push(`${col} IN (${c.values.map(literal).join(", ")})`);
  }
  if ((c.type === "text" || c.type === "longText") && c.min !== undefined && c.min > 0) {
    parts.push(`char_length(${col}) >= ${c.min}`);
  }
  if (c.type === "longText" && c.max !== undefined) parts.push(`char_length(${col}) <= ${c.max}`);
  if ((c.type === "integer" || c.type === "number") && c.min !== undefined)
    parts.push(`${col} >= ${c.min}`);
  if ((c.type === "integer" || c.type === "number") && c.max !== undefined)
    parts.push(`${col} <= ${c.max}`);
  return parts.length ? parts.join(" AND ") : null;
}

/** The snapshot of ONE model (what is stored and compared). */
export function modelSnapshot(m: Model, kon: string): ModelSnapshot {
  return {
    name: m.name,
    table: m.table,
    kon,
    access: { ...m.access },
    columns: Object.entries(m.fields).map(([key, c]) => {
      const column = fieldColumn(key);
      return {
        key,
        column,
        type: sqlType(c),
        nullable: !c.required,
        defaultValue: sqlDefault(c),
        check: checkSql(c, column),
        unique: c.unique,
        index: c.index ?? false,
      };
    }),
    ...(m.semantics
      ? { semantics: { fields: [...m.semantics.fields], dimensions: m.semantics.dimensions } }
      : {}),
  };
}

/** The embedding column and its HNSW index (cosine distance). */
function semanticsSql(table: string, dimensions: number): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS vector;`,
    `ALTER TABLE ${q(table)} ADD COLUMN IF NOT EXISTS "embedding" vector(${dimensions});`,
    `CREATE INDEX IF NOT EXISTS ${q(`${table}_embedding_idx`)} ON ${q(table)} USING hnsw ("embedding" vector_cosine_ops);`,
  ];
}

export function modelsSnapshot(models: readonly Model[], kon: string): Snapshot {
  const output = emptySnapshot();
  for (const m of models) {
    if (output.models[m.name]) throw new Error(`model '${m.name}' declared twice`);
    output.models[m.name] = modelSnapshot(m, kon);
  }
  const tables = new Set<string>();
  for (const m of Object.values(output.models)) {
    if (tables.has(m.table)) throw new Error(`two models use table '${m.table}'`);
    tables.add(m.table);
  }
  return output;
}

// ── Constraint names (stable: the diff uses them to rebuild them) ──

const checkName = (table: string, col: string) => `${table}_${col}_check`;
const uniqueName = (table: string, col: string) => `${table}_${col}_key`;
const indexName = (table: string, col: string) => `${table}_${col}_idx`;

// ── CREATE ──────────────────────────────────────────────────────────────────

function columnDefinition(c: SnapshotColumn): string {
  return [
    q(c.column),
    c.type,
    c.nullable ? null : "NOT NULL",
    c.defaultValue !== null ? `DEFAULT ${c.defaultValue}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function createTable(m: ModelSnapshot): string[] {
  const withOwner = hasOwner({ access: m.access });
  const lines = [
    `  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
    ...(withOwner ? [`  "owner_id" text`] : []),
    ...m.columns.map((c) => `  ${columnDefinition(c)}`),
    `  "created_at" timestamp with time zone NOT NULL DEFAULT now()`,
    `  "updated_at" timestamp with time zone NOT NULL DEFAULT now()`,
    ...m.columns
      .filter((c) => c.check)
      .map((c) => `  CONSTRAINT ${q(checkName(m.table, c.column))} CHECK (${c.check})`),
    ...m.columns
      .filter((c) => c.unique)
      .map((c) => `  CONSTRAINT ${q(uniqueName(m.table, c.column))} UNIQUE (${q(c.column)})`),
  ];
  const statements = [`CREATE TABLE IF NOT EXISTS ${q(m.table)} (\n${lines.join(",\n")}\n);`];
  if (withOwner) statements.push(ownerIndex(m.table));
  statements.push(
    `CREATE INDEX IF NOT EXISTS ${q(`${m.table}_created_at_idx`)} ON ${q(m.table)} ("created_at");`
  );
  for (const c of m.columns.filter((x) => x.index)) statements.push(createIndex(m.table, c.column));
  return statements;
}

const ownerIndex = (table: string) =>
  `CREATE INDEX IF NOT EXISTS ${q(`${table}_owner_id_idx`)} ON ${q(table)} ("owner_id");`;
const createIndex = (table: string, col: string) =>
  `CREATE INDEX IF NOT EXISTS ${q(indexName(table, col))} ON ${q(table)} (${q(col)});`;

// ── RLS ─────────────────────────────────────────────────────────────────────

/** The system: empty id AND role (migrations, loaders, background tasks). */
const SYSTEM =
  "(COALESCE(current_setting('app.current_user_id', true), '') = '' " +
  "AND COALESCE(current_setting('app.current_user_role', true), '') = '')";

const OWNER =
  "(COALESCE(current_setting('app.current_user_id', true), '') <> '' " +
  "AND \"owner_id\" = current_setting('app.current_user_id', true))";

/**
 * The expressions of an access policy. `write` is who can touch
 * a row; whoever can touch it can also read it.
 *
 * In "staff", an agent with the model's scope (`<model>:read|write`) gets in
 * too (`kitsuden_agent_can_in_kon`): the scope that opens the operation has to
 * open the rows, or the agent would get 200 with an empty list. In "owner"
 * the scope opens the door, not the rows: the agent sees ITS OWN.
 */
export function rlsExpressions(
  access: ModelAccess,
  kon: string,
  name: string
): { read: string; write: string } {
  const admin = `kitsuden_effective_admin(${literal(kon)})`;
  const staff = `kitsuden_effective_staff(${literal(kon)})`;
  const agent = (action: "read" | "write") =>
    `kitsuden_agent_can_in_kon(${literal(kon)}, ${literal(`${name}:${action}`)})`;
  const write =
    access.write === "owner" ? `(${OWNER} OR ${admin})` : `(${staff} OR ${agent("write")})`;
  const readBase =
    access.read === "public"
      ? "true"
      : access.read === "owner"
        ? `(${OWNER} OR ${admin})`
        : `(${staff} OR ${agent("read")})`;
  const read =
    readBase === "true" ? "true" : readBase === write ? readBase : `(${readBase} OR ${write})`;
  return { read, write };
}

/** The table's policies: ENABLE + FORCE and the four (idempotent). */
export function rlsPolicies(m: Pick<ModelSnapshot, "name" | "table" | "access" | "kon">): string[] {
  const t = q(m.table);
  const { read: read, write: write } = rlsExpressions(m.access, m.kon, m.name);
  const p = (suffix: string) => q(`${m.table}_${suffix}`);
  return [
    `-- RLS (${m.table}): read=${m.access.read}, write=${m.access.write}. FORCE: without it the table owner is exempt.`,
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${p("select")} ON ${t};`,
    `CREATE POLICY ${p("select")} ON ${t} FOR SELECT TO PUBLIC USING (${SYSTEM} OR ${read});`,
    `DROP POLICY IF EXISTS ${p("insert")} ON ${t};`,
    `CREATE POLICY ${p("insert")} ON ${t} FOR INSERT TO PUBLIC WITH CHECK (${SYSTEM} OR ${write});`,
    `DROP POLICY IF EXISTS ${p("update")} ON ${t};`,
    `CREATE POLICY ${p("update")} ON ${t} FOR UPDATE TO PUBLIC USING (${SYSTEM} OR ${write}) WITH CHECK (${SYSTEM} OR ${write});`,
    `DROP POLICY IF EXISTS ${p("delete")} ON ${t};`,
    `CREATE POLICY ${p("delete")} ON ${t} FOR DELETE TO PUBLIC USING (${SYSTEM} OR ${write});`,
  ];
}

// ── The diff ─────────────────────────────────────────────────────────────────

export interface MigrationOptions {
  /** Short name of the kon (`notes` for `kon-notes`; `app` for the app). */
  kon: string;
  /** Actually emit the DROPs (by default they come out commented). */
  allowDestructive?: boolean;
}

export interface ModelMigration {
  /** The SQL (empty if there are no changes). */
  sql: string;
  /** The new snapshot (the one that is stored if the file is written). */
  snapshot: Snapshot;
  /** Readable summary, one line per change. */
  changes: string[];
  /** What is worth reviewing (destructive omitted, lossy types…). */
  warnings: string[];
}

/**
 * Compares the previous snapshot with the declared models and returns the
 * migration. Throws if the change cannot be made without deciding something (a new
 * required field with no default on a table that already exists).
 */
export function generateModelMigration(
  previous: unknown,
  models: readonly Model[],
  options: MigrationOptions
): ModelMigration {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.kon)) {
    throw new Error(`kon '${options.kon}': short lowercase name (without 'kon-')`);
  }
  const earlier = previous ? normalizeSnapshot(previous) : emptySnapshot();
  if (earlier.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `snapshot of version ${earlier.version}; this version of Kitsuden reads ${SNAPSHOT_VERSION}`
    );
  }
  const next = modelsSnapshot(models, options.kon);
  const sql: string[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];
  const destructiveOne = (statement: string, reason: string, target: string[] = sql) => {
    if (options.allowDestructive) {
      target.push(statement);
      warnings.push(`destructive: ${reason}`);
    } else {
      target.push(
        `-- DESTRUCTIVE (skipped; re-run with --allow-destructive to emit it): ${statement}`
      );
      warnings.push(`destructive change skipped: ${reason}`);
    }
  };

  // Removed models.
  for (const [name, old] of Object.entries(earlier.models)) {
    if (next.models[name]) continue;
    changes.push(`remove model ${name} (${old.table})`);
    destructiveOne(
      `DROP TABLE IF EXISTS ${q(old.table)};`,
      `model '${name}' removed: table ${old.table} would be dropped`
    );
  }

  for (const [name, m] of Object.entries(next.models)) {
    const oldValue = earlier.models[name];
    if (!oldValue) {
      changes.push(`create model ${name} (${m.table})`);
      sql.push(`-- Model ${name}`, ...createTable(m), ...rlsPolicies(m));
      if (m.semantics) sql.push(...semanticsSql(m.table, m.semantics.dimensions));
      continue;
    }
    const t = q(m.table);
    const part: string[] = [];
    let table = oldValue.table;
    if (oldValue.table !== m.table) {
      part.push(`ALTER TABLE ${q(oldValue.table)} RENAME TO ${t};`);
      changes.push(`rename table ${oldValue.table} → ${m.table}`);
      table = m.table;
    }
    // Columns: renames first (by `before`).
    const declaredModel = models.find((x) => x.name === name)!;
    const old = new Map(oldValue.columns.map((c) => [c.key, { ...c }]));
    const used = new Set<string>();
    for (const c of m.columns) {
      const before = declaredModel.fields[c.key]?.before;
      if (!old.has(c.key) && before && old.has(before)) {
        const v = old.get(before)!;
        if (v.column !== c.column)
          part.push(`ALTER TABLE ${t} RENAME COLUMN ${q(v.column)} TO ${q(c.column)};`);
        changes.push(`rename field ${name}.${before} → ${c.key}`);
        old.delete(before);
        // Named constraints follow the old name: they are rebuilt.
        if (v.check)
          part.push(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(checkName(table, v.column))};`);
        if (v.unique)
          part.push(
            `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(uniqueName(table, v.column))};`
          );
        if (v.index) part.push(`DROP INDEX IF EXISTS ${q(indexName(table, v.column))};`);
        // Compared with the old one already renamed and without its constraints (which
        // carried the old name): whatever is needed is created again below.
        old.set(c.key, {
          ...v,
          key: c.key,
          column: c.column,
          check: null,
          unique: false,
          index: false,
        });
      }
    }
    // Owner.
    const beforeWithOwner = hasOwner({ access: oldValue.access });
    const nowWithOwner = hasOwner({ access: m.access });
    if (!beforeWithOwner && nowWithOwner) {
      part.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "owner_id" text;`, ownerIndex(m.table));
      changes.push(`add owner column to ${name}`);
      warnings.push(
        `${name}: existing rows have owner_id NULL; only the system and admins see them until you set it`
      );
    }
    for (const c of m.columns) {
      const v = old.get(c.key);
      used.add(c.key);
      if (!v) {
        if (!c.nullable && c.defaultValue === null) {
          throw new Error(
            `${name}.${c.key}: a new REQUIRED field needs a default (defaultValue) on an existing table, ` +
              `or add it optional first, fill it, then make it required`
          );
        }
        part.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${columnDefinition(c)};`);
        if (c.check)
          part.push(
            `ALTER TABLE ${t} ADD CONSTRAINT ${q(checkName(m.table, c.column))} CHECK (${c.check});`
          );
        if (c.unique)
          part.push(
            `ALTER TABLE ${t} ADD CONSTRAINT ${q(uniqueName(m.table, c.column))} UNIQUE (${q(c.column)});`
          );
        if (c.index) part.push(createIndex(m.table, c.column));
        changes.push(`add field ${name}.${c.key}`);
        continue;
      }
      const col = q(c.column);
      if (v.type !== c.type) {
        // Whatever has a CHECK is removed first (it may depend on the type).
        if (v.check) {
          part.push(
            `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(checkName(m.table, c.column))};`
          );
          v.check = null;
        }
        part.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${c.type} USING ${col}::${c.type};`);
        changes.push(`change type of ${name}.${c.key}: ${v.type} → ${c.type}`);
        if (!(v.type.startsWith("varchar") && (c.type === "text" || widens(v.type, c.type)))) {
          warnings.push(
            `${name}.${c.key}: ${v.type} → ${c.type} may fail or lose data on existing rows; review the USING cast`
          );
        }
      }
      if (v.defaultValue !== c.defaultValue) {
        part.push(
          c.defaultValue === null
            ? `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT;`
            : `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${c.defaultValue};`
        );
        changes.push(`change default of ${name}.${c.key}`);
      }
      if (v.nullable !== c.nullable) {
        if (c.nullable) part.push(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP NOT NULL;`);
        else {
          if (c.defaultValue !== null)
            part.push(`UPDATE ${t} SET ${col} = ${c.defaultValue} WHERE ${col} IS NULL;`);
          else
            warnings.push(
              `${name}.${c.key}: SET NOT NULL fails if any row has NULL; fill them first`
            );
          part.push(`ALTER TABLE ${t} ALTER COLUMN ${col} SET NOT NULL;`);
        }
        changes.push(`${c.nullable ? "make optional" : "make required"} ${name}.${c.key}`);
      }
      if (v.check !== c.check) {
        part.push(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(checkName(m.table, c.column))};`);
        if (c.check)
          part.push(
            `ALTER TABLE ${t} ADD CONSTRAINT ${q(checkName(m.table, c.column))} CHECK (${c.check});`
          );
        changes.push(`change constraint of ${name}.${c.key}`);
      }
      if (v.unique !== c.unique) {
        part.push(
          c.unique
            ? `ALTER TABLE ${t} ADD CONSTRAINT ${q(uniqueName(m.table, c.column))} UNIQUE (${col});`
            : `ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${q(uniqueName(m.table, c.column))};`
        );
        changes.push(`${c.unique ? "add" : "drop"} unique on ${name}.${c.key}`);
      }
      if (v.index !== c.index) {
        part.push(
          c.index
            ? createIndex(m.table, c.column)
            : `DROP INDEX IF EXISTS ${q(indexName(m.table, c.column))};`
        );
        changes.push(`${c.index ? "add" : "drop"} index on ${name}.${c.key}`);
      }
    }
    // Removed fields.
    for (const [key, v] of old) {
      if (used.has(key)) continue;
      changes.push(`remove field ${name}.${key}`);
      if (!v.nullable && !options.allowDestructive) {
        // The column stays, but without NOT NULL: the app no longer sends it.
        part.push(`ALTER TABLE ${t} ALTER COLUMN ${q(v.column)} DROP NOT NULL;`);
      }
      destructiveOne(
        `ALTER TABLE ${t} DROP COLUMN IF EXISTS ${q(v.column)};`,
        `field ${name}.${key} removed`,
        part
      );
    }
    if (beforeWithOwner && !nowWithOwner) {
      changes.push(`remove owner column from ${name}`);
      destructiveOne(
        `ALTER TABLE ${t} DROP COLUMN IF EXISTS "owner_id";`,
        `${name} no longer has an owner`,
        part
      );
    }
    // Semantic search.
    const dimBefore = oldValue.semantics?.dimensions;
    const dimNow = m.semantics?.dimensions;
    if (dimNow !== undefined && dimBefore === undefined) {
      part.push(...semanticsSql(m.table, dimNow));
      changes.push(`add semantic search to ${name} (${dimNow} dimensions)`);
      warnings.push(
        `${name}: existing rows have no embedding until they are written again (or re-queued)`
      );
    } else if (dimNow !== undefined && dimBefore !== undefined && dimNow !== dimBefore) {
      part.push(
        `DROP INDEX IF EXISTS ${q(`${m.table}_embedding_idx`)};`,
        `ALTER TABLE ${t} ALTER COLUMN "embedding" TYPE vector(${dimNow}) USING NULL;`,
        `CREATE INDEX IF NOT EXISTS ${q(`${m.table}_embedding_idx`)} ON ${t} USING hnsw ("embedding" vector_cosine_ops);`
      );
      changes.push(`change embedding dimensions of ${name}: ${dimBefore} → ${dimNow}`);
      warnings.push(`${name}: every embedding is cleared and must be computed again`);
    } else if (dimNow === undefined && dimBefore !== undefined) {
      changes.push(`remove semantic search from ${name}`);
      destructiveOne(
        `ALTER TABLE ${t} DROP COLUMN IF EXISTS "embedding";`,
        `${name} no longer has semantic search`,
        part
      );
    } else if (
      dimNow !== undefined &&
      JSON.stringify(oldValue.semantics?.fields) !== JSON.stringify(m.semantics?.fields)
    ) {
      changes.push(`semantic fields of ${name}: ${m.semantics!.fields.join(", ")}`);
      warnings.push(`${name}: existing embeddings were computed from the old fields`);
    }
    const policyChanges =
      oldValue.access.read !== m.access.read ||
      oldValue.access.write !== m.access.write ||
      oldValue.kon !== m.kon ||
      oldValue.table !== m.table;
    if (policyChanges) {
      changes.push(`access policy of ${name}: read=${m.access.read}, write=${m.access.write}`);
      if (oldValue.table !== m.table) {
        for (const s of ["select", "insert", "update", "delete"]) {
          part.push(`DROP POLICY IF EXISTS ${q(`${oldValue.table}_${s}`)} ON ${t};`);
        }
      }
      part.push(...rlsPolicies(m));
    }
    if (part.length) sql.push(`-- Model ${name}`, ...part);
  }

  const body = sql.join("\n");
  return {
    sql: changes.length ? body : "",
    snapshot: next,
    changes,
    warnings,
  };
}

function widens(from: string, to: string): boolean {
  const n = (t: string) => Number(/varchar\((\d+)\)/.exec(t)?.[1] ?? NaN);
  return from.startsWith("varchar") && to.startsWith("varchar") && n(to) >= n(from);
}

/** The header of a generated migration file. */
export function migrationHeader(changes: string[], warnings: string[]): string {
  return [
    "-- Generated by `kitsuden makemigrations` from defineModel (docs/agents/models.md).",
    "-- Review it before applying. Nothing applies it automatically; the migration runner",
    "-- (bun run scripts/migrate.ts) does, in file order, with the DDL connection.",
    ...changes.map((c) => `--   ${c}`),
    ...warnings.map((a) => `-- ! ${a}`),
    "",
  ].join("\n");
}
