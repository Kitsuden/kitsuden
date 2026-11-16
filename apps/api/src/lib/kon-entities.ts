/**
 * Kon entities: datasets a kon owns (docs/kons/entities.md)
 * ============================================================================
 *
 * `defineKon({ entities })` declares them; this module does the two things the
 * declaration needs:
 *
 *   syncKonEntities   at load, creates or updates one dataset per entity, with
 *                     no SQL migration. The kon's declaration WINS at every
 *                     start: a field edited in the panel is put back.
 *
 *   konEntities       `ctx.entities`: read and write records, validated against
 *                     the fields on every write.
 *
 * ── WHY A DATASET AND NOT A NEW TABLE ──────────────────────────────────────
 *
 * Everything an entity needs already exists for datasets: jsonb rows, the
 * field compiler, row policies, per-dataset agent scopes, record history,
 * search, snapshots, REST and MCP. A second store would have to grow all of
 * that again, and reports (lib/aggregate.ts) already read datasets.
 *
 * What was missing was the door for a kon: a way to say "this dataset is
 * mine" (`data_sets.kon_id`) and an API that VALIDATES. The dataset routes
 * store whatever `data` they are given; a kon that declared `plate` as
 * required needs the write without it to fail.
 *
 * ── WHO IS WRITING ─────────────────────────────────────────────────────────
 *
 * Records are read and written on the request's connection: inside a kon's
 * route that is whoever is asking, so the row policies of `data_entries`
 * apply. Outside a request (a rule's step, a startup hook) it is the system.
 * The dataset's definition is always written as the system: declaring an
 * entity is the kon's act, not a visitor's.
 */

// Deep imports, not the facade: the facade reaches the loader, which imports this file.
import {
  FIELD_TYPE_ALIASES,
  FIELD_TYPES,
  KON_ENTITY_FIELD_KEY,
  KON_ENTITY_SLUG,
  KonEntityValidationError,
  konEntityProblem,
  type KonEntities,
  type KonEntityDefinition,
  type KonEntityField,
  type KonEntityListOptions,
  type KonEntityRecord,
  type KonEntityWrite,
} from "@kitsuden/shared";
import { sql, type SQL } from "drizzle-orm";

import { messageOf } from "../../../../packages/engine/src/errors";
import { validateAgainstFields } from "../../../../packages/engine/src/field-compiler";
import {
  DATASET_ENTRY_DIFF,
  DATASET_ENTRY_ENTITY,
  recordChange,
} from "../../../../packages/engine/src/record-history";
import { resolveExecutor, useRequest } from "../../../../packages/engine/src/request-scope";
import { afterCommit } from "../../../../packages/engine/src/rls-request";
import { db } from "../db";

import { events } from "./events";
import { logger } from "./logger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST = 500;

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Row[];
}

/** The request's connection (whoever is asking), or the system outside a request. */
function ex(): typeof db {
  return resolveExecutor(db) as typeof db;
}

function knownFieldType(type: string): boolean {
  return type in FIELD_TYPES || type in (FIELD_TYPE_ALIASES as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Declaration → dataset
// ─────────────────────────────────────────────────────────────────────────────

function storedFields(fields: KonEntityField[]): Row[] {
  return fields.map((field) => {
    // Everything the kon wrote is kept (limits, patterns, its own marks): the field compiler reads
    // `minValue`, `maxValue`, `minLength`, `maxLength`, `validationRegex`, `showIf`, and a kon may
    // keep keys of its own next to them.
    const { key, type, label, required, ...rest } = field;
    return { ...rest, key, type, label: label ?? key, required: required === true };
  });
}

/**
 * Creates the dataset of one entity or brings it up to date. Returns why it
 * could not, or `null`.
 *
 * A slug that already belongs to a dataset a person made, or to another kon,
 * is NOT taken over: the entity is refused and the dataset left alone.
 */
async function storeEntity(konId: string, entity: KonEntityDefinition): Promise<string | null> {
  const shape = konEntityProblem(entity);
  if (shape) return shape;
  const unknownType = entity.fields.find((field) => !knownFieldType(field.type));
  if (unknownType) {
    return `"${entity.slug}": field "${unknownType.key}" has an unknown type "${unknownType.type}"`;
  }
  if (
    entity.settings !== undefined &&
    (entity.settings === null ||
      typeof entity.settings !== "object" ||
      Array.isArray(entity.settings))
  ) {
    return `"${entity.slug}": settings must be an object`;
  }

  const schema = JSON.stringify(storedFields(entity.fields));
  const policy = JSON.stringify({
    readAccess: entity.access?.read ?? "admin",
    writeAccess: entity.access?.write ?? "admin",
    enableRLS: false,
  });
  const settings = entity.settings === undefined ? null : JSON.stringify(entity.settings);
  try {
    const existing = rowsOf(
      await db.execute(sql`SELECT id, kon_id FROM data_sets WHERE slug = ${entity.slug} LIMIT 1`)
    )[0];
    if (existing && existing.kon_id !== konId) {
      return existing.kon_id
        ? `the slug "${entity.slug}" belongs to ${String(existing.kon_id)}`
        : `there is already a dataset "${entity.slug}" that no kon owns; choose another slug`;
    }
    if (existing) {
      await db.execute(sql`
        UPDATE data_sets
           SET name = ${entity.name},
               description = ${entity.description ?? null},
               icon = ${entity.icon ?? null},
               schema = ${schema}::jsonb,
               policy_json = ${policy}::jsonb,
               kon_settings = ${settings}::jsonb,
               updated_at = now()
         WHERE id = ${existing.id}
           AND (name, description, icon, schema, policy_json, kon_settings) IS DISTINCT FROM
               (${entity.name}, ${entity.description ?? null}, ${entity.icon ?? null},
                ${schema}::jsonb, ${policy}::jsonb, ${settings}::jsonb)`);
    } else {
      await db.execute(sql`
        INSERT INTO data_sets (name, slug, description, icon, schema, policy_json, kon_id, kon_settings)
        VALUES (${entity.name}, ${entity.slug}, ${entity.description ?? null},
                ${entity.icon ?? null}, ${schema}::jsonb, ${policy}::jsonb, ${konId},
                ${settings}::jsonb)`);
    }
    return null;
  } catch (err: unknown) {
    return `"${entity.slug}" could not be stored (${messageOf(err)})`;
  }
}

/**
 * Creates or updates the datasets the kon declared in `defineKon({ entities })`.
 * Returns the problems, one sentence each; a well-formed entity is synced
 * regardless of the others. Entities the kon defined at runtime
 * (`ctx.entities.define`) are not in the declaration and are left as they are.
 */
export async function syncKonEntities(
  konId: string,
  entities: readonly KonEntityDefinition[] | undefined
): Promise<string[]> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities ?? []) {
    if (entity && seen.has(entity.slug)) {
      problems.push(`entities: "${entity.slug}" is declared twice`);
      continue;
    }
    if (entity?.slug) seen.add(entity.slug);
    const problem = await storeEntity(konId, entity);
    if (problem) problems.push(`entities: ${problem}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────────
// ctx.entities
// ─────────────────────────────────────────────────────────────────────────────

interface Entity {
  konId: string;
  settings: Record<string, unknown> | null;
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  fields: Row[];
  policy: { readAccess?: string; writeAccess?: string } | null;
}

/**
 * The entity's definition, read as the system: whether an entity EXISTS is not
 * a row-policy question, and a visitor's request must still be validated
 * against the fields.
 */
async function entity(slug: string): Promise<Entity | null> {
  if (typeof slug !== "string" || !KON_ENTITY_SLUG.test(slug)) return null;
  const row = rowsOf(
    await db.execute(sql`
      SELECT id, slug, name, description, icon, schema, policy_json, kon_id, kon_settings
        FROM data_sets
       WHERE slug = ${slug} AND kon_id IS NOT NULL
       LIMIT 1`)
  )[0];
  return row ? entityOf(row) : null;
}

function entityOf(row: Row): Entity {
  return {
    konId: String(row.kon_id),
    settings: (row.kon_settings as Record<string, unknown> | null) ?? null,
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    icon: (row.icon as string | null) ?? null,
    fields: Array.isArray(row.schema) ? (row.schema as Row[]) : [],
    policy: (row.policy_json as Entity["policy"]) ?? null,
  };
}

async function requireEntity(slug: string): Promise<Entity> {
  const found = await entity(slug);
  if (!found) {
    throw new Error(
      `entities: no kon owns an entity "${String(slug)}" (defineKon({ entities }) or ctx.entities.define)`
    );
  }
  return found;
}

function record(row: Row): KonEntityRecord {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    data: (row.data as Record<string, unknown>) ?? {},
    status: (row.status as string | null) ?? null,
    ownerId: (row.owner_id as string | null) ?? null,
    createdAt: row.created_at as Date | string,
    updatedAt: row.updated_at as Date | string,
  };
}

/** The row as the history and the events name its columns. */
function entryShape(row: Row): Row {
  return {
    id: row.id,
    title: row.title,
    dataSetId: row.data_set_id,
    data: row.data,
    ownerId: row.owner_id,
    status: row.status,
    createdById: row.created_by_id,
    updatedById: row.updated_by_id,
  };
}

function validated(found: Entity, data: Record<string, unknown>): Record<string, unknown> {
  const result = validateAgainstFields(found.fields, data);
  if (result.success) return result.data;
  throw new KonEntityValidationError(
    found.slug,
    result.error.issues.map((issue) => ({
      field: issue.path.map(String).join("."),
      message: issue.message,
    }))
  );
}

function plainData(data: unknown): Record<string, unknown> {
  if (data === undefined) return {};
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("entities: data must be an object");
  }
  return data as Record<string, unknown>;
}

const ENTRY_COLUMNS = sql`id, title, data_set_id, data, owner_id, status, created_by_id, updated_by_id, created_at, updated_at`;

function history(action: "create" | "update" | "delete", before: Row | null, after: Row | null) {
  const rowId = (after ?? before)?.id;
  return recordChange(ex(), {
    entity: DATASET_ENTRY_ENTITY,
    rowId,
    action,
    before: before ? entryShape(before) : null,
    after: after ? entryShape(after) : null,
    user: useRequest()?.user ?? null,
    diff: DATASET_ENTRY_DIFF,
    onFailure: (err) =>
      logger.warn({ err: messageOf(err) }, "[entities] could not record the entry's history"),
  });
}

function definitionOf(found: Entity): KonEntityDefinition {
  return {
    slug: found.slug,
    name: found.name,
    ...(found.description ? { description: found.description } : {}),
    ...(found.icon ? { icon: found.icon } : {}),
    fields: found.fields as unknown as KonEntityField[],
    access: {
      read: (found.policy?.readAccess as "admin" | "authenticated" | "public") ?? "admin",
      write: (found.policy?.writeAccess as "admin" | "authenticated" | "public") ?? "admin",
    },
    ...(found.settings ? { settings: found.settings } : {}),
  };
}

const KON_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

function requireKonId(konId: unknown): asserts konId is string {
  if (typeof konId !== "string" || !KON_ID.test(konId)) {
    throw new Error("entities: the kon id is required (the id of the kon itself)");
  }
}

export const konEntities: KonEntities = {
  async describe(slug) {
    const found = await entity(slug);
    return found ? definitionOf(found) : null;
  },

  async define(konId, definition) {
    requireKonId(konId);
    const problem = await storeEntity(konId, definition);
    if (problem) throw new Error(`entities: ${problem}`);
    const stored = await entity(definition.slug);
    if (!stored) throw new Error(`entities: "${definition.slug}" was not stored`);
    return definitionOf(stored);
  },

  async undefine(konId, slug, options = {}) {
    requireKonId(konId);
    const found = await entity(slug);
    if (!found || found.konId !== konId) return false;
    if (!options.withRecords) {
      const counted = rowsOf(
        await db.execute(
          sql`SELECT count(*)::int AS n FROM data_entries WHERE data_set_id = ${found.id}`
        )
      )[0];
      const records = Number(counted?.n ?? 0);
      if (records > 0) {
        throw new Error(
          `entities: "${slug}" still has ${records} record(s); remove them first or pass { withRecords: true }`
        );
      }
    }
    await db.execute(sql`DELETE FROM data_sets WHERE id = ${found.id} AND kon_id = ${konId}`);
    return true;
  },

  async definitions(konId) {
    requireKonId(konId);
    const rows = rowsOf(
      await db.execute(sql`
        SELECT id, slug, name, description, icon, schema, policy_json, kon_id, kon_settings
          FROM data_sets WHERE kon_id = ${konId} ORDER BY slug`)
    );
    return rows.map((row) => definitionOf(entityOf(row)));
  },

  async validate(slug, data) {
    return validated(await requireEntity(slug), plainData(data));
  },

  async list(slug, options: KonEntityListOptions = {}) {
    const found = await requireEntity(slug);
    const conditions: SQL[] = [sql`data_set_id = ${found.id}`];
    for (const [key, value] of Object.entries(options.where ?? {})) {
      if (!KON_ENTITY_FIELD_KEY.test(key))
        throw new Error(`entities: "${key}" is not a field name`);
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(`entities: where.${key} must be a text, a number or true/false`);
      }
      // Compared as text: `data ->>` gives text whatever was stored.
      conditions.push(sql`(data ->> ${key}) = ${String(value)}`);
    }
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), MAX_LIST);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const rows = rowsOf(
      await ex().execute(sql`
        SELECT ${ENTRY_COLUMNS} FROM data_entries
         WHERE ${sql.join(conditions, sql` AND `)}
         ORDER BY created_at DESC, id
         LIMIT ${limit} OFFSET ${offset}`)
    );
    return rows.map(record);
  },

  async get(slug, id) {
    const found = await requireEntity(slug);
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const row = rowsOf(
      await ex().execute(sql`
        SELECT ${ENTRY_COLUMNS} FROM data_entries
         WHERE id = ${id} AND data_set_id = ${found.id} LIMIT 1`)
    )[0];
    return row ? record(row) : null;
  },

  async create(slug, input) {
    const found = await requireEntity(slug);
    if (typeof input?.title !== "string" || input.title.trim() === "") {
      throw new Error("entities: title is required");
    }
    const data = validated(found, plainData(input.data));
    const actor = useRequest()?.user?.id ?? null;
    const row = rowsOf(
      await ex().execute(sql`
        INSERT INTO data_entries (title, data_set_id, data, owner_id, status, created_by_id, updated_by_id)
        VALUES (${input.title.slice(0, 500)}, ${found.id}, ${JSON.stringify(data)}::jsonb,
                ${input.ownerId ?? null}, ${input.status ?? "published"}, ${actor}, ${actor})
        RETURNING ${ENTRY_COLUMNS}`)
    )[0];
    await history("create", null, row);
    afterCommit(() =>
      events.emit("entry:created", { datasetId: found.id, entries: [entryShape(row)] })
    );
    return record(row);
  },

  async update(slug, id, input: KonEntityWrite) {
    const found = await requireEntity(slug);
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const before = rowsOf(
      await ex().execute(sql`
        SELECT ${ENTRY_COLUMNS} FROM data_entries
         WHERE id = ${id} AND data_set_id = ${found.id} LIMIT 1 FOR UPDATE`)
    )[0];
    if (!before) return null;

    // MERGED, then validated as a whole: a patch that leaves a required field empty must fail.
    let data = (before.data as Record<string, unknown>) ?? {};
    if (input.data !== undefined) {
      const merged: Record<string, unknown> = { ...data };
      for (const [key, value] of Object.entries(plainData(input.data))) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      data = validated(found, merged);
    }
    const title =
      typeof input.title === "string" && input.title.trim() !== ""
        ? input.title.slice(0, 500)
        : String(before.title);
    const row = rowsOf(
      await ex().execute(sql`
        UPDATE data_entries
           SET title = ${title},
               data = ${JSON.stringify(data)}::jsonb,
               status = ${input.status ?? (before.status as string | null)},
               owner_id = ${input.ownerId === undefined ? (before.owner_id as string | null) : input.ownerId},
               updated_by_id = ${useRequest()?.user?.id ?? null},
               updated_at = now()
         WHERE id = ${id} AND data_set_id = ${found.id}
        RETURNING ${ENTRY_COLUMNS}`)
    )[0];
    if (!row) return null;
    await history("update", before, row);
    afterCommit(() => events.emit("entry:updated", entryShape(row)));
    return record(row);
  },

  async remove(slug, id) {
    const found = await requireEntity(slug);
    if (typeof id !== "string" || !UUID.test(id)) return false;
    const row = rowsOf(
      await ex().execute(sql`
        DELETE FROM data_entries
         WHERE id = ${id} AND data_set_id = ${found.id}
        RETURNING ${ENTRY_COLUMNS}`)
    )[0];
    if (!row) return false;
    await history("delete", row, null);
    afterCommit(() => events.emit("entry:deleted", { id, datasetId: found.id }));
    return true;
  },
};
