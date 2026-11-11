/**
 * Data Explorer API — "Data Studio" (Pillar 1)
 *
 * Universal table explorer with:
 *   ✅ Whitelist-based table access (security)
 *   ✅ Server-side pagination (limit/offset)
 *   ✅ Server-side sorting (any column, asc/desc)
 *   ✅ Server-side filtering (several fields at once) and search across columns
 *      (the query syntax is in lib/explorer-query.ts)
 *   ✅ Inline edit via PATCH (single cell updates)
 *   ✅ Column metadata (types, editability)
 *   ✅ Smart Views (saved filter presets)
 */

import { messageOf } from "@kitsuden/engine";
import {
  and,
  count,
  eq,
  sql,
  asc,
  desc,
  getTableColumns,
  gt,
  lt,
  gte,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db";
import {
  authUsers as user,
  media,
  dataSets,
  dataEntries,
  siteSettings,
  modules,
} from "../db/schema";
import { TABLES_ONLY_VIA_THEIR_ROUTE } from "../lib/actions-code";
import {
  writeRequiresAdmin,
  withoutSecretColumns,
  tableIsExplorable,
} from "../lib/explorable-tables";
import {
  ExplorerQueryError,
  isTextualPgType,
  likePattern,
  parseExplorerQuery,
  searchableColumns,
  type ExplorerCondition,
  type ExplorerQuery,
} from "../lib/explorer-query";
import { requireAuth } from "../middleware/auth";
import {
  introspectTable,
  getAllTables,
  type IntrospectedColumn,
} from "../services/schema-introspector";

export const explorerRoutes = new Hono();

// Apply authentication to all routes
explorerRoutes.use("/*", requireAuth);

// No explorer response carries a live secret (tokens, passwords,
// key hashes), not even to an admin. See `withoutSecretColumns`.
explorerRoutes.use("/*", async (c, next) => {
  await next();
  if (!(c.res.headers.get("content-type") ?? "").includes("application/json")) return;
  const body = await c.res
    .clone()
    .json()
    .catch(() => undefined);
  if (body === undefined) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(withoutSecretColumns(body)), {
    status: c.res.status,
    headers,
  });
});

type BadRequest = { json: (body: unknown, status: 400) => Response };

function badQuery(c: BadRequest, error: ExplorerQueryError): Response {
  return c.json(
    { error: error.message, ...(error.supported ? { supported: error.supported } : {}) },
    400
  );
}

/** Reads the list query; a 400 response for what `parseExplorerQuery` refuses. */
function readListQuery(
  c: BadRequest & { req: { queries(): Record<string, string[]> } }
): ExplorerQuery | Response {
  try {
    return parseExplorerQuery(c.req.queries());
  } catch (error) {
    if (error instanceof ExplorerQueryError) return badQuery(c, error);
    throw error;
  }
}

// ═══════════════════════════════════════════════
// DYNAMIC TABLE RESOLUTION (fallback for tables not in static registry)
// ═══════════════════════════════════════════════

/**
 * Resolve a table — check static registry first, then fall back to
 * dynamic introspection of any real DB table via information_schema.
 * This allows ALL tables to be explored without manual registration.
 */
/**
 * Denies writing to sensitive tables to anyone who is not `admin`.
 *
 * `auth_users` and `modules` can be LOOKED AT with a session —they are data the panel
 * shows— but modifying them is something else: changing `role` in `auth_users` is
 * privilege escalation, and `modules` is the switch that installs kons.
 *
 * Returns the response to send, or `null` if it may continue.
 */
function denySensitiveWrite(
  c: { get(k: "user"): { role?: string } | undefined; json: (b: unknown, s: 403) => Response },
  table: string
): Response | null {
  // Tables with their own route are not written through here.
  if (TABLES_ONLY_VIA_THEIR_ROUTE.has(table)) {
    return c.json(
      {
        error: "Forbidden",
        code: "KITSUDEN_E_FORBIDDEN",
        message: `'${table}' is not written through the explorer: use its own route (/api/actions or promotion_propose for actions, /api/approvals for approvals and proposals, /api/admin/agents for agents).`,
      },
      403
    );
  }
  if (!writeRequiresAdmin(table)) return null;

  const role = c.get("user")?.role;
  if (role === "admin") return null;

  return c.json(
    {
      error: "Forbidden",
      message: `Modifying '${table}' requires the administrator role.`,
    },
    403
  );
}

async function resolveTable(name: string): Promise<TableMeta | null> {
  /**
   * The access policy lives HERE because every data route passes through here
   * —list, create, modify, delete and options—. Putting it in each handler
   * would have left the gap where someone forgot it.
   *
   * Before, this resolved any table in the database by introspection, and the
   * whole router was protected only with `requireAuth`, which does not look at the role.
   * An `editor` reached `kitsuden_secrets`, `auth_accounts` and
   * `kitsuden_migrations`, with write access. See `lib/explorable-tables.ts`.
   *
   * `null` is returned —the same as for a nonexistent table— on purpose: a 403
   * would confirm that the table exists.
   */
  const verdict = await tableIsExplorable(name, Object.keys(tableRegistry));
  if (!verdict.allowed) {
    if (verdict.reason === "forbidden") {
      console.warn(`[Explorer] Access denied to protected table: ${name}`);
    }
    return null;
  }

  // 1. Static registry (fast, typed Drizzle references)
  if (tableRegistry[name]) return tableRegistry[name];

  // 2. Dynamic introspection (any DB table)
  const introspected = await introspectTable(name);
  if (!introspected) return null;

  // Build a dynamic TableMeta using raw SQL
  const pk = introspected.primaryKey[0] || "id";
  const readonlyFields = [
    pk,
    ...introspected.columns
      .filter((c) => c.name.endsWith("_at") || c.name === "createdAt" || c.name === "updatedAt")
      .map((c) => c.name),
  ];

  return {
    table: name as any, // Will use raw SQL, not Drizzle reference
    label: humanizeTableNameLocal(name),
    icon: "📋",
    readonlyFields,
    pk,
    _dynamic: true, // Flag: use raw SQL instead of Drizzle ORM
  } as TableMeta;
}

function humanizeTableNameLocal(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// ═══════════════════════════════════════════════
// SCHEMA INTROSPECTION — For Admin UI generation
// ═══════════════════════════════════════════════

/**
 * GET /schema/json/:table — JSON Schema of a table
 * ----------------------------------------------------------------------------
 *
 * It is the endpoint the panel asks for FIRST to know which fields a
 * form has. It had two failures that added up, and both looked the same from
 * the browser: "No fields available".
 *
 * ── 1. IT NEVER RAN ────────────────────────────────────────────────────────
 *
 * It was registered AFTER `/schema/:kon/:table`. Hono resolves by registration
 * order among patterns of the same shape, so `/schema/json/courses`
 * went in through the other one with `kon="json"` and `table="courses"`. That is why it now goes
 * first: a literal route has to be registered before the wildcard that
 * covers it. Guarded by `tests/unit/shadowed-routes.test.ts`.
 *
 * ── 2. IT DEDUCED THE COLUMNS FROM A SAMPLE ROW ────────────────────────────
 *
 * It did `SELECT … LIMIT 1` and took the fields from the returned object. On an
 * EMPTY table there is no row, so it returned `properties: {}` — zero fields.
 *
 * That is: the "create the first record" form had no fields
 * precisely when there were no records. And the diagnostic the panel showed
 * —"Total columns received: 0"— described the symptom without revealing the
 * cause.
 *
 * Now `information_schema` is read, which answers the same with an empty table
 * and also brings the real type, whether it accepts nulls and the real foreign keys instead
 * of guessing them from the column name.
 */
explorerRoutes.get("/schema/json/:table", async (c) => {
  const tableName = c.req.param("table");

  // The same gate as `resolveTable`: this endpoint introspects on its own
  // and without this it would still hand over the SCHEMA of `kitsuden_secrets` or
  // `auth_accounts` —column names included— to anyone with a session.
  const verdict = await tableIsExplorable(tableName, Object.keys(tableRegistry));
  const introspected = verdict.allowed ? await introspectTable(tableName) : null;
  if (!introspected) {
    return c.json(
      {
        error: `Table '${tableName}' not found`,
        /**
         * Only what is EXPLORABLE.
         *
         * Before, this listed the entire `getAllTables()`, so the 404 response
         * for any table enumerated `kitsuden_secrets`, `auth_accounts`
         * and the others. A "not found" message cannot be an index of
         * what exists.
         */
        available: (
          await Promise.all(
            [...new Set([...Object.keys(tableRegistry), ...(await getAllTables())])].map(
              async (t) =>
                (await tableIsExplorable(t, Object.keys(tableRegistry))).allowed ? t : null
            )
          )
        )
          .filter((t): t is string => t !== null)
          .sort(),
      },
      404
    );
  }

  const meta = tableRegistry[tableName];
  const pk = introspected.primaryKey[0] || meta?.pk || "id";
  const readOnly = new Set(
    meta?.readonlyFields ?? [
      pk,
      ...introspected.columns
        .filter(
          (col) => col.name.endsWith("_at") || col.name === "createdAt" || col.name === "updatedAt"
        )
        .map((col) => col.name),
    ]
  );

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const col of introspected.columns) {
    const colType = columnType(col);
    // The foreign key declared in the database wins over the name: `author_id`
    // can point to any table, and the name map only gets it right with
    // the conventions that someone remembered to write.
    const relatedTable = col.foreignTable ?? getRelatedTable(col.name);

    const prop: Record<string, unknown> = { type: jsonSchemaType(colType, col.type) };

    if (colType === "date") prop.format = "date-time";
    if (colType === "email") prop.format = "email";
    if (colType === "url") prop.format = "uri";
    if (colType === "id") prop.format = "uuid";

    if (colType === "relation" && relatedTable) {
      prop.format = "uuid";
      prop["x-relation"] = {
        table: relatedTable,
        optionsEndpoint: `/api/explorer/${relatedTable}/options`,
      };
    }

    if (readOnly.has(col.name)) prop.readOnly = true;
    if (col.maxLength) prop.maxLength = col.maxLength;
    prop.description = generateFieldDescription(col.name, colType, relatedTable);

    properties[col.name] = prop;

    // Required = the database demands it and it has no default value. Before, it was
    // marked required "everything that had a value in the sample row", which
    // has no relation to what the table allows.
    if (!col.nullable && col.defaultValue === null && !readOnly.has(col.name)) {
      required.push(col.name);
    }
  }

  return c.json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `kitsuden://tables/${tableName}`,
    title: meta?.label ?? humanizeTableNameLocal(tableName),
    description: `Schema for the ${meta?.label ?? tableName} table in Kitsuden`,
    type: "object",
    properties,
    required,
    "x-kitsuden": {
      table: tableName,
      primaryKey: pk,
      icon: meta?.icon ?? "📋",
      readonlyFields: [...readOnly],
      rowCount: introspected.estimatedRowCount,
      endpoints: {
        list: `/api/explorer/${tableName}`,
        create: `/api/explorer/${tableName}`,
        update: `/api/explorer/${tableName}/{id}`,
        delete: `/api/explorer/${tableName}/{id}`,
        options: `/api/explorer/${tableName}/options`,
      },
    },
  });
});

// ── GET /schema/:kon — Get schema for a kon's tables ──
explorerRoutes.get("/schema/:kon", async (c) => {
  const konId = c.req.param("kon");

  // A kon's own tables come from its manifest (see the kon detail route below).
  const tables = [konId];

  // Return schema info for each table
  const schema = tables.map((tableName) => {
    const meta = tableRegistry[tableName];
    return {
      name: tableName,
      label: meta?.label || tableName,
      icon: meta?.icon || "📄",
      exists: !!meta,
    };
  });

  return c.json({ kon: konId, tables: schema });
});

// ── GET /schema/:kon/:table — Get detailed column info ──
explorerRoutes.get("/schema/:kon/:table", async (c) => {
  const tableName = c.req.param("table");
  const meta = tableRegistry[tableName];

  if (!meta) {
    return c.json(
      {
        error: `Table '${tableName}' not found`,
        available: Object.keys(tableRegistry),
      },
      404
    );
  }

  // Get sample row to infer columns
  try {
    const [sample] = await db.select().from(meta.table).limit(1);

    const columns = sample
      ? Object.entries(sample).map(([key, value]) => ({
          name: key,
          type: inferColumnType(key, value),
          editable: !meta.readonlyFields.includes(key),
          nullable: value === null,
        }))
      : [];

    return c.json({
      table: tableName,
      label: meta.label,
      icon: meta.icon,
      primaryKey: meta.pk,
      columns,
    });
  } catch (error: unknown) {
    return c.json({ error: messageOf(error) }, 500);
  }
});

// ═══════════════════════════════════════════════
// TABLE REGISTRY (Security whitelist + metadata)
// ═══════════════════════════════════════════════

interface TableMeta {
  table: any;
  label: string;
  icon: string;
  /** Columns that cannot be edited inline */
  readonlyFields: string[];
  /** Primary key column name */
  pk: string;
  /** If true, use raw SQL queries instead of Drizzle ORM (dynamically discovered table) */
  _dynamic?: boolean;
}

const tableRegistry: Record<string, TableMeta> = {
  auth_users: {
    table: user,
    label: "Auth Users",
    icon: "🔐",
    readonlyFields: ["id", "created_at", "updated_at"],
    pk: "id",
  },
  media: {
    table: media,
    label: "Media",
    icon: "🖼️",
    readonlyFields: ["id", "created_at", "s3_key"],
    pk: "id",
  },
  datasets: {
    table: dataSets,
    label: "Data Sets",
    icon: "📊",
    readonlyFields: ["id", "created_at"],
    pk: "id",
  },
  entries: {
    table: dataEntries,
    label: "Data Entries",
    icon: "📋",
    readonlyFields: ["id", "created_at", "updated_at"],
    pk: "id",
  },
  settings: {
    table: siteSettings,
    label: "Site Settings",
    icon: "⚙️",
    readonlyFields: ["id"],
    pk: "id",
  },
  modules: {
    table: modules,
    label: "Modules",
    icon: "🧩",
    readonlyFields: ["created_at"],
    pk: "key",
  },
};

// ── GET /tables — List ALL available tables (static + dynamic from DB) ──
explorerRoutes.get("/tables", async (c) => {
  // Start with static registry
  const staticTables = await Promise.all(
    Object.entries(tableRegistry).map(async ([key, meta]) => {
      try {
        const [result] = await db.select({ value: count() }).from(meta.table);
        return {
          key,
          label: meta.label,
          icon: meta.icon,
          rowCount: Number(result?.value ?? 0),
          source: "static" as const,
        };
      } catch {
        return { key, label: meta.label, icon: meta.icon, rowCount: 0, source: "static" as const };
      }
    })
  );

  // Discover additional tables from DB that aren't in static registry
  const allDbTables = await getAllTables();
  const staticKeys = new Set(Object.keys(tableRegistry));
  /**
   * Filtered by the SAME policy as the rest of the explorer.
   *
   * There was a hand-written filter here —`!t.startsWith("auth_") && !t.startsWith("_")`—
   * that hid the auth ones and nothing else: `kitsuden_secrets`, `api_keys` and
   * `kitsuden_migrations` showed up in the list. A prefix filter written in
   * one place knows nothing about what is decided in another.
   */
  const explorable = await Promise.all(
    allDbTables.map(async (t) => ((await tableIsExplorable(t, staticKeys)).allowed ? t : null))
  );
  const dynamicTables = explorable
    .filter((t): t is string => t !== null)
    .filter((t) => !staticKeys.has(t))
    .map((t) => ({
      key: t,
      label: humanizeTableNameLocal(t),
      icon: "📋",
      rowCount: 0, // Avoid N queries — count on demand
      source: "dynamic" as const,
    }));

  return c.json({ tables: [...staticTables, ...dynamicTables] });
});

// ── GET /discover/:konId — Discover tables owned by a kon ──
// Reads kon.json tables[] AND cross-refs with real DB tables
explorerRoutes.get("/discover/:konId", async (c) => {
  const konId = c.req.param("konId");
  const allDbTables = await getAllTables();

  // Strategy 1: Check kon.json for declared tables
  const { scanPackages } = await import("../services/scanner");
  const kons = await scanPackages("kons");
  const manifest = kons.find((g) => g.id === konId || g.id === `kon-${konId}`);

  let declaredTables: string[] = [];
  if (manifest?.tables) {
    declaredTables = (manifest.tables as any[])
      .map((t) => (typeof t === "string" ? t : t.name))
      .filter(Boolean);
  }

  // Strategy 2: Pattern-match DB tables by kon name prefix
  const shortId = konId.replace(/^kon-/, "").replace(/-/g, "_");
  const patternMatches = allDbTables.filter(
    (t) => t.startsWith(shortId + "_") || t === shortId || t === shortId + "s"
  );

  // Strategy 3: Check for well-known table name patterns
  const knownPatterns: Record<string, string[]> = {
    webhooks: ["webhooks_config", "webhooks_log"],
    connectors: ["data_connectors"],
    "media-library": ["media"],
    "ai-memories": ["ai_memories", "ai_memory_chunks"],
    workers: ["kitsuden_functions", "function_executions"],
  };
  const knownTables = knownPatterns[shortId] || knownPatterns[konId] || [];

  /**
   * The three sources are gathered and filtered by the SAME policy.
   *
   * Strategies 2 and 3 guess by prefix and by a hand-written list,
   * so a kon called `kitsuden` would have matched `kitsuden_secrets`
   * and `kitsuden_migrations` by "starts the same". Discovering tables by name
   * similarity cannot bypass what is decided in a single place.
   */
  const unfilteredCandidates = new Set([...declaredTables, ...patternMatches, ...knownTables]);
  const allowedOnes = await Promise.all(
    [...unfilteredCandidates].map(async (t) =>
      (await tableIsExplorable(t, Object.keys(tableRegistry))).allowed ? t : null
    )
  );
  const allCandidates = new Set(allowedOnes.filter((t): t is string => t !== null));
  const verified: Array<{ name: string; exists: boolean; rowCount: number; source: string }> = [];

  for (const tableName of allCandidates) {
    const exists = allDbTables.includes(tableName);
    let rowCount = 0;
    if (exists) {
      try {
        const result = await db.execute(sql`SELECT count(*) as c FROM "${sql.raw(tableName)}"`);
        rowCount = Number((result.rows[0] as any)?.c ?? 0);
      } catch {}
    }
    const source = declaredTables.includes(tableName)
      ? "kon.json"
      : knownTables.includes(tableName)
        ? "known-pattern"
        : "prefix-match";
    verified.push({ name: tableName, exists, rowCount, source });
  }

  return c.json({
    konId,
    tables: verified.filter((t) => t.exists),
    missing: verified.filter((t) => !t.exists).map((t) => t.name),
    manifestFound: !!manifest,
  });
});

// ── GET /:collection — Paginated, sorted, filtered list ──
explorerRoutes.get("/:collection", async (c) => {
  const collectionName = c.req.param("collection");
  const meta = await resolveTable(collectionName);

  if (!meta) {
    return c.json(
      { error: `Collection '${collectionName}' not found.`, available: Object.keys(tableRegistry) },
      404
    );
  }

  // Dynamic tables use raw SQL
  if (meta._dynamic) {
    return handleDynamicQuery(c, collectionName, meta);
  }

  // Parse query params
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const offset = (page - 1) * limit;
  const sortField = c.req.query("sort") || null;
  const sortDir = c.req.query("dir") === "asc" ? "asc" : "desc";

  // Filters and search: the syntax is in lib/explorer-query.ts.
  const listQuery = readListQuery(c);
  if (listQuery instanceof Response) return listQuery;

  try {
    /**
     * The filter is built ONCE and both queries use it: written twice (once for the page,
     * once for the count) is the exact way to end up with a counter that says 400 over a
     * table that shows 12.
     */
    let filter: SQL | undefined;
    try {
      filter = typedWhere(meta, listQuery);
    } catch (error) {
      if (error instanceof ExplorerQueryError) return badQuery(c, error);
      throw error;
    }

    let query = db.select().from(meta.table).where(filter).$dynamic();

    const [countResult] = await db
      .select({ value: count() })
      .from(meta.table)
      .where(filter)
      .$dynamic();
    const total = Number(countResult?.value ?? 0);

    // Apply sort
    if (sortField && meta.table[sortField]) {
      query = query.orderBy(
        sortDir === "asc" ? asc(meta.table[sortField]) : desc(meta.table[sortField])
      );
    }

    // Apply pagination
    query = query.limit(limit).offset(offset);

    const data = await query;

    // Column metadata (derived from first row or table definition)
    const columns =
      data.length > 0
        ? Object.keys(data[0]).map((key) => ({
            field: key,
            editable: !meta.readonlyFields.includes(key),
            type: inferColumnType(key, data[0][key]),
          }))
        : [];

    const totalPages = Math.ceil(total / limit);

    return c.json({
      data,
      columns,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error: unknown) {
    console.error(`Explorer Error [${collectionName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
});

// ── PATCH /:collection/:id — Inline cell update ──
explorerRoutes.patch("/:collection/:id", async (c) => {
  const collectionName = c.req.param("collection");
  const id = c.req.param("id");
  const meta = await resolveTable(collectionName);

  if (!meta) {
    return c.json({ error: `Collection '${collectionName}' not found.` }, 404);
  }

  // Write to a sensitive table: `admin` only. See the helper.
  const deniedOne = denySensitiveWrite(c, collectionName);
  if (deniedOne) return deniedOne;

  if (meta._dynamic) {
    return handleDynamicUpdate(c, collectionName, meta, id);
  }

  try {
    const body = await c.req.json();

    // Security: strip readonly fields
    for (const field of meta.readonlyFields) {
      delete body[field];
    }

    if (Object.keys(body).length === 0) {
      return c.json({ error: "No editable fields provided" }, 400);
    }

    // Add updated_at if the table has it
    if (meta.table.updated_at || meta.table.updatedAt) {
      body.updated_at = new Date();
    }

    const pkCol = meta.table[meta.pk];
    const [updated] = await db.update(meta.table).set(body).where(eq(pkCol, id)).returning();

    if (!updated) {
      return c.json({ error: "Record not found" }, 404);
    }

    return c.json(updated);
  } catch (error: unknown) {
    console.error(`Explorer Update [${collectionName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
});

// ── POST /:collection — Create a new record ──
explorerRoutes.post("/:collection", async (c) => {
  const collectionName = c.req.param("collection");
  const meta = await resolveTable(collectionName);

  if (!meta) {
    return c.json({ error: `Collection '${collectionName}' not found.` }, 404);
  }

  // Write to a sensitive table: `admin` only. See the helper.
  const deniedOne = denySensitiveWrite(c, collectionName);
  if (deniedOne) return deniedOne;

  if (meta._dynamic) {
    return handleDynamicCreate(c, collectionName, meta);
  }

  try {
    const body = await c.req.json();

    // Security: strip readonly fields
    for (const field of meta.readonlyFields) {
      delete body[field];
    }

    if (Object.keys(body).length === 0) {
      return c.json({ error: "No fields provided" }, 400);
    }

    const result = await db.insert(meta.table).values(body).returning();

    const created = Array.isArray(result) ? result[0] : result;

    return c.json(created, 201);
  } catch (error: unknown) {
    console.error(`Explorer Create [${collectionName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
});

// ── DELETE /:collection/:id — Delete a record ──
explorerRoutes.delete("/:collection/:id", async (c) => {
  const collectionName = c.req.param("collection");
  const id = c.req.param("id");
  const meta = await resolveTable(collectionName);

  if (!meta) {
    return c.json({ error: `Collection '${collectionName}' not found.` }, 404);
  }

  // Write to a sensitive table: `admin` only. See the helper.
  const deniedOne = denySensitiveWrite(c, collectionName);
  if (deniedOne) return deniedOne;

  if (meta._dynamic) {
    return handleDynamicDelete(c, collectionName, meta, id);
  }

  try {
    const pkCol = meta.table[meta.pk];
    const [deleted] = (await db.delete(meta.table).where(eq(pkCol, id)).returning()) as any[];

    if (!deleted) {
      return c.json({ error: "Record not found" }, 404);
    }

    return c.json({ deleted: true, id });
  } catch (error: unknown) {
    console.error(`Explorer Delete [${collectionName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
});

// ── GET /:collection/options — FK dropdown options ──
// Returns { value, label } pairs for populating relation dropdowns
explorerRoutes.get("/:collection/options", async (c) => {
  const collectionName = c.req.param("collection");
  const meta = await resolveTable(collectionName);

  if (!meta) {
    return c.json({ error: `Collection '${collectionName}' not found.` }, 404);
  }

  if (meta._dynamic) {
    return handleDynamicOptions(c, collectionName, meta);
  }

  try {
    const rows = await db.select().from(meta.table).limit(200);

    // Find the best display field: name > title > label > email > slug > first text column
    const displayPriority = ["name", "title", "label", "email", "slug", "siteName"];
    let displayField = "id";

    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      for (const prio of displayPriority) {
        if (keys.includes(prio)) {
          displayField = prio;
          break;
        }
      }
      // Fallback: first string column that isn't the PK
      if (displayField === "id") {
        const textCol = keys.find((k) => k !== meta.pk && typeof rows[0][k] === "string");
        if (textCol) displayField = textCol;
      }
    }

    const options = rows.map((row) => ({
      value: (row as any)[meta.pk],
      label: String((row as any)[displayField] || (row as any)[meta.pk]),
    }));

    return c.json({ options, displayField, collection: collectionName });
  } catch (error: unknown) {
    return c.json({ error: messageOf(error) }, 500);
  }
});

// ═══════════════════════════════════════════════
// DYNAMIC TABLE HANDLERS (raw SQL for auto-discovered tables)
// ═══════════════════════════════════════════════

async function handleDynamicQuery(c: any, tableName: string, meta: TableMeta) {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const offset = (page - 1) * limit;
  const sortField = c.req.query("sort") || meta.pk;
  const sortDir = c.req.query("dir") === "asc" ? "ASC" : "DESC";
  const listQuery = readListQuery(c);
  if (listQuery instanceof Response) return listQuery;

  try {
    const safeSort = sortField.replace(/[^a-zA-Z0-9_]/g, "");
    const table = sql.raw(`"${tableName}"`);

    let where: SQL | undefined;
    try {
      where = await dynamicWhere(tableName, listQuery);
    } catch (error) {
      if (error instanceof ExplorerQueryError) return badQuery(c, error);
      throw error;
    }
    const whereSql = where ? sql` WHERE ${where}` : sql``;

    // The same WHERE in both queries, so the total and the page cannot disagree.
    const countSql = sql`SELECT count(*) as total FROM ${table}${whereSql}`;
    const dataSql = sql`SELECT * FROM ${table}${whereSql} ORDER BY "${sql.raw(safeSort)}" ${sql.raw(sortDir)} LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(offset))}`;

    const countResult = await db.execute(countSql);
    const total = Number((countResult.rows[0] as any)?.total ?? 0);

    const dataResult = await db.execute(dataSql);
    const data = dataResult.rows;
    const columns =
      data.length > 0
        ? Object.keys(data[0]).map((key) => ({
            field: key,
            editable: !meta.readonlyFields.includes(key),
            type: inferColumnType(key, (data[0] as any)[key]),
          }))
        : [];

    const totalPages = Math.ceil(total / limit);
    return c.json({
      data,
      columns,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    });
  } catch (error: unknown) {
    console.error(`Explorer Dynamic Query [${tableName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
}

async function handleDynamicCreate(c: any, tableName: string, meta: TableMeta) {
  try {
    const body = await c.req.json();
    for (const field of meta.readonlyFields) delete body[field];
    if (Object.keys(body).length === 0) return c.json({ error: "No fields provided" }, 400);

    const keys = Object.keys(body);
    const safeKeys = keys.map((k) => `"${k.replace(/[^a-zA-Z0-9_]/g, "")}"`);
    const values = keys.map((k) => pgLiteral(body[k]));

    const result = await db.execute(
      sql.raw(
        `INSERT INTO "${tableName}" (${safeKeys.join(", ")}) VALUES (${values.join(", ")}) RETURNING *`
      )
    );
    return c.json(result.rows[0], 201);
  } catch (error: unknown) {
    console.error(`Explorer Dynamic Create [${tableName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
}

async function handleDynamicUpdate(c: any, tableName: string, meta: TableMeta, id: string) {
  try {
    const body = await c.req.json();
    for (const field of meta.readonlyFields) delete body[field];
    if (Object.keys(body).length === 0)
      return c.json({ error: "No editable fields provided" }, 400);

    const keys = Object.keys(body);
    const setClauses = keys.map(
      (k) => `"${k.replace(/[^a-zA-Z0-9_]/g, "")}" = ${pgLiteral(body[k])}`
    );
    const safePk = meta.pk.replace(/[^a-zA-Z0-9_]/g, "");

    const result = await db.execute(
      sql.raw(
        `UPDATE "${tableName}" SET ${setClauses.join(", ")} WHERE "${safePk}" = ${pgLiteral(id)} RETURNING *`
      )
    );
    if (result.rows.length === 0) return c.json({ error: "Record not found" }, 404);
    return c.json(result.rows[0]);
  } catch (error: unknown) {
    console.error(`Explorer Dynamic Update [${tableName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
}

async function handleDynamicDelete(c: any, tableName: string, meta: TableMeta, id: string) {
  try {
    const safePk = meta.pk.replace(/[^a-zA-Z0-9_]/g, "");
    const result = await db.execute(
      sql.raw(`DELETE FROM "${tableName}" WHERE "${safePk}" = ${pgLiteral(id)} RETURNING *`)
    );
    if (result.rows.length === 0) return c.json({ error: "Record not found" }, 404);
    return c.json({ deleted: true, id });
  } catch (error: unknown) {
    console.error(`Explorer Dynamic Delete [${tableName}]:`, error);
    return c.json({ error: messageOf(error) }, 500);
  }
}

async function handleDynamicOptions(c: any, tableName: string, meta: TableMeta) {
  try {
    const result = await db.execute(sql.raw(`SELECT * FROM "${tableName}" LIMIT 200`));
    const rows = result.rows as any[];
    const displayPriority = ["name", "title", "label", "email", "slug", "display_name"];
    let displayField = meta.pk;
    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      for (const prio of displayPriority) {
        if (keys.includes(prio)) {
          displayField = prio;
          break;
        }
      }
      if (displayField === meta.pk) {
        const textCol = keys.find((k) => k !== meta.pk && typeof rows[0][k] === "string");
        if (textCol) displayField = textCol;
      }
    }
    const options = rows.map((row) => ({
      value: row[meta.pk],
      label: String(row[displayField] || row[meta.pk]),
    }));
    return c.json({ options, displayField, collection: tableName });
  } catch (error: unknown) {
    return c.json({ error: messageOf(error) }, 500);
  }
}

// ═══════════════════════════════════════════════
// SMART VIEWS (Saved filter presets)
// ═══════════════════════════════════════════════

// In-memory store (upgrade to DB table later for persistence)
// For now this is per-server-restart. The frontend will also
// persist to localStorage as backup.
const smartViews = new Map<string, SmartView[]>();

interface SmartView {
  id: string;
  name: string;
  collection: string;
  filters: { field: string; op: string; value: string }[];
  sort?: { field: string; dir: string };
  createdAt: string;
}

// ── GET /:collection/views — List saved views ──
explorerRoutes.get("/:collection/views", async (c) => {
  const collection = c.req.param("collection");
  const views = smartViews.get(collection) || [];
  return c.json({ views });
});

// ── POST /:collection/views — Save a new view ──
explorerRoutes.post("/:collection/views", async (c) => {
  const collection = c.req.param("collection");
  const body = await c.req.json();

  const view: SmartView = {
    id: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: body.name || "Untitled View",
    collection,
    filters: body.filters || [],
    sort: body.sort,
    createdAt: new Date().toISOString(),
  };

  const existing = smartViews.get(collection) || [];
  existing.push(view);
  smartViews.set(collection, existing);

  return c.json(view, 201);
});

// ── DELETE /:collection/views/:viewId — Delete a view ──
explorerRoutes.delete("/:collection/views/:viewId", async (c) => {
  const collection = c.req.param("collection");
  const viewId = c.req.param("viewId");

  const existing = smartViews.get(collection) || [];
  const filtered = existing.filter((v) => v.id !== viewId);
  smartViews.set(collection, filtered);

  return c.json({ deleted: true });
});

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

// ── The WHERE of a list ─────────────────────────────────────────────────────

function compare(left: SQL, op: ExplorerCondition["op"], value: string): SQL {
  switch (op) {
    case "contains":
      return sql`${left}::text ILIKE ${likePattern(value)}`;
    case "equals":
      return sql`${left}::text = ${value}`;
    case "gt":
      return sql`${left} > ${value}`;
    case "lt":
      return sql`${left} < ${value}`;
    case "gte":
      return sql`${left} >= ${value}`;
    case "lte":
      return sql`${left} <= ${value}`;
  }
}

/** Every part must hold (AND); nothing when there are no parts. */
function joinWhere(parts: SQL[]): SQL | undefined {
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

/** For a table of the static registry: Drizzle columns, by their property name. */
function typedWhere(meta: TableMeta, query: ExplorerQuery): SQL | undefined {
  const parts: SQL[] = [];
  for (const cond of query.conditions) {
    const col = meta.table[cond.field];
    if (!col) {
      // The older triple on a column this table lacks was skipped; that stays.
      if (cond.legacy) continue;
      throw new ExplorerQueryError(`Unknown column: "${cond.field}"`);
    }
    switch (cond.op) {
      // The typed comparisons keep Drizzle's own operators (and its value mapping).
      case "equals":
        parts.push(eq(col, cond.value));
        break;
      case "gt":
        parts.push(gt(col, cond.value));
        break;
      case "lt":
        parts.push(lt(col, cond.value));
        break;
      case "gte":
        parts.push(gte(col, cond.value));
        break;
      case "lte":
        parts.push(lte(col, cond.value));
        break;
      default:
        parts.push(compare(sql`${col}`, cond.op, cond.value));
    }
  }

  if (query.search) {
    const columns = getTableColumns(meta.table) as Record<string, { dataType?: string }>;
    const textual = Object.entries(columns)
      .filter(([, column]) => column.dataType === "string")
      .map(([name]) => name);
    const fields = searchableColumns(textual, query.searchFields);
    const pattern = likePattern(query.search);
    const matches = fields.map((name) => sql`${meta.table[name]}::text ILIKE ${pattern}`);
    // No textual column: a search matches nothing (never "everything").
    parts.push(matches.length > 0 ? or(...matches)! : sql`false`);
  }
  return joinWhere(parts);
}

/** For a table found by introspection: column names checked against the real ones. */
async function dynamicWhere(tableName: string, query: ExplorerQuery): Promise<SQL | undefined> {
  if (query.conditions.length === 0 && !query.search) return undefined;
  const introspected = await introspectTable(tableName);
  const names = new Set((introspected?.columns ?? []).map((col) => col.name));
  const ident = (name: string) => sql.raw(`"${name.replace(/[^a-zA-Z0-9_]/g, "")}"`);

  const parts: SQL[] = [];
  for (const cond of query.conditions) {
    if (!cond.legacy && !names.has(cond.field)) {
      throw new ExplorerQueryError(`Unknown column: "${cond.field}"`);
    }
    parts.push(compare(sql`${ident(cond.field)}`, cond.op, cond.value));
  }

  if (query.search) {
    const textual = (introspected?.columns ?? [])
      .filter((col) => isTextualPgType(col.type))
      .map((col) => col.name);
    const fields = searchableColumns(textual, query.searchFields);
    const pattern = likePattern(query.search);
    const matches = fields.map((name) => sql`${ident(name)}::text ILIKE ${pattern}`);
    parts.push(matches.length > 0 ? or(...matches)! : sql`false`);
  }
  return joinWhere(parts);
}

/**
 * Safely format a JS value for use as a PostgreSQL literal in raw SQL.
 */
function pgLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Map of known FK column → table name patterns */
const FK_TABLE_MAP: Record<string, string> = {
  tag_id: "tags",
  tagId: "tags",
  user_id: "auth_users",
  userId: "auth_users",
  author_id: "auth_users",
  authorId: "auth_users",
  assigned_to_id: "auth_users",
  assignedToId: "auth_users",
  contact_id: "contacts",
  contactId: "contacts",
  dataset_id: "datasets",
  datasetId: "datasets",
};

function inferColumnType(key: string, value: any): string {
  if (key === "id") return "id";
  if (key.endsWith("_id") || (key.endsWith("Id") && key !== "id")) return "relation";
  if (key.includes("at") || key.includes("At") || key.includes("date") || key.includes("Date")) {
    if (value instanceof Date || (typeof value === "string" && !isNaN(Date.parse(value))))
      return "date";
  }
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "object" && value !== null) return "json";
  if (key.includes("url") || key.includes("Url")) return "url";
  if (key.includes("email")) return "email";
  if (key.includes("color") || key.includes("Color")) return "color";
  return "text";
}

/**
 * Field type from the REAL column, not from a sample value.
 *
 * `inferColumnType` (further down, still used by the endpoints that do have
 * a row at hand) looks at the value: `typeof value === "boolean"`. With an empty table
 * there is no value, and with a null column there isn't either — a `timestamp` set to NULL
 * was classified as text and the form painted a text box where
 * a date picker was needed.
 *
 * Here the catalog rules: `information_schema.columns.data_type` plus the declared
 * foreign key.
 */
function columnType(col: IntrospectedColumn): string {
  if (col.isPrimaryKey && col.name === "id") return "id";
  if (col.isForeignKey) return "relation";

  const t = (col.type || "").toLowerCase();
  if (t.includes("bool")) return "boolean";
  if (
    t.includes("int") ||
    t.includes("numeric") ||
    t.includes("decimal") ||
    t.includes("real") ||
    t.includes("double")
  ) {
    return "number";
  }
  if (t.includes("timestamp") || t === "date" || t.includes("time")) return "date";
  if (t.includes("json")) return "json";
  if (t === "uuid") return col.name.endsWith("_id") ? "relation" : "id";

  // The name is only used when the type does not decide it.
  if (col.name.includes("email")) return "email";
  if (/url$/i.test(col.name) || col.name.includes("Url")) return "url";
  if (col.name.includes("color") || col.name.includes("Color")) return "color";
  return "text";
}

/** Same as `mapToJsonSchemaType`, but deciding integer/decimal by the database type. */
function jsonSchemaType(colType: string, pgType: string): string {
  if (colType === "number") {
    return /int/i.test(pgType) ? "integer" : "number";
  }
  if (colType === "boolean") return "boolean";
  if (colType === "json") return "object";
  return "string";
}

/** Get the related table for a FK column name */
function getRelatedTable(columnName: string): string | undefined {
  if (FK_TABLE_MAP[columnName]) return FK_TABLE_MAP[columnName];
  // Infer from column name: strip _id suffix → pluralize
  const base = columnName.replace(/_id$/, "").replace(/Id$/, "");
  const plural = base.endsWith("s") ? base : base + "s";
  if (tableRegistry[plural]) return plural;
  if (tableRegistry[base]) return base;
  return undefined;
}

/** Map internal column types to JSON Schema types */
function mapToJsonSchemaType(colType: string, value: any): string {
  switch (colType) {
    case "id":
    case "text":
    case "email":
    case "url":
    case "color":
    case "date":
    case "relation":
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "json":
      return "object";
    default:
      return "string";
  }
}

/** Generate a human-readable field description */
function generateFieldDescription(key: string, colType: string, relatedTable?: string): string {
  if (colType === "relation" && relatedTable) {
    return `Foreign key to ${relatedTable} table`;
  }
  if (colType === "id") return "Unique identifier (UUID)";
  if (colType === "date") return `Timestamp field`;
  if (key === "createdAt") return "Record creation timestamp";
  if (key === "updatedAt") return "Last modification timestamp";
  // Convert camelCase to human-readable
  const readable = key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
  return readable;
}
