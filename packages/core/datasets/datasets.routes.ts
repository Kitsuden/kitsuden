/**
 * DataSets — its operations (kon SDK)
 *
 * Dynamic collections: definition, entries, import/export,
 * snapshots, search and indexes. Each route is a DECLARED operation
 * (`defineOperation`): the REST route, its OpenAPI and its
 * MCP tool come from it (docs/kons/README.md); the schemas are in
 * `datasets.wire-schemas.ts`.
 *
 * Authorization for almost everything depends on the DATASET (its `policyJson`) or on the
 * entry (its owner): `permission.policy.inHandler` is declared and the handler
 * checks it with `authorize(resource)` after loading them, with the same
 * responses as before (404 if it can't see it, 401/403 if it can't write).
 */

import {
  can,
  defineOperation,
  postgresInputError,
  isUuid,
  messageOf,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import {
  buildDatasetWhere,
  droppedSensitivity,
  agentSignature,
  publishedOrOwn,
  type KonContext,
  type DatasetAction,
  type PolicyJson,
  type RLSUser,
} from "@kitsuden/shared";
import { eq, and, asc, inArray, type SQL } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";

import {
  evaluateCalculatedField,
  formatCalculatedValue,
  type EvaluationContext,
} from "./datasets.calculated";
import { computedFieldOperations } from "./datasets.calculated.routes";
import { dataSetCalculatedFields } from "./datasets.calculated.schema";
import {
  exportDatasets,
  importToDataset,
  importPackage,
  exportConfigSchema,
  importConfigSchema,
  type ExportConfig,
  type ImportConfig,
} from "./datasets.import-export";
import {
  suggestIndexesForDataset,
  getIndexStats,
  applyAutoIndexes,
  generateIndexReport,
  applyIndexConfig,
  indexConfigSchema,
} from "./datasets.indexes";
import { isStaff, canViewDataset, datasetScopeOf } from "./datasets.policy";
import { dataSets, dataEntries } from "./datasets.schema";
import {
  searchEntries,
  compareInputs,
  readFilters,
  SEARCH_LIMITS,
  type FieldFilter,
} from "./datasets.search";
import {
  getCurrentSnapshot,
  getSnapshotHistory,
  createManualSnapshot,
  restoreToSnapshot,
  compareSnapshots,
  detectSnapshotConfig,
} from "./datasets.snapshots";
import {
  ApplyIndexes,
  Search,
  Comparison,
  CompareInputs,
  CompareSnapshots,
  Dataset,
  DatasetEntry,
  Input,
  InputInput,
  InputOrInputs,
  InputsInput,
  Success,
  Export,
  Generic,
  Import,
  ImportPackage,
  IndicesAuto,
  DatasetsList,
  EntriesList,
  InputParam,
  ParamId,
  ParamSlug,
  SearchQuery,
  InputQuery,
  InputsQuery,
  LimitQuery,
  Restore,
  SnapshotManual,
} from "./datasets.wire-schemas";

/** The kon's id: part of each operation's fine-grained scope (`kon:datasets:<op>`). */
export const KON_ID = "kon-datasets";

/**
 * The response of a handler `catch`, according to what really happened: a
 * schema that does not match is 422, data Postgres does not accept (text with U+0000,
 * an id that is not a uuid, a duplicate) is 4xx, a "does not exist" is 404. Before, everything
 * came out as 500 with Drizzle's message, query included (found by
 * Schemathesis). What really is a server failure stays 500.
 */
export function failureResponse(
  c: Context,
  error: unknown,
  register: (message: string, data: Record<string, unknown>) => void,
  tag: string
): Response {
  if (error instanceof z.ZodError) {
    return c.json(
      {
        error: "Validation failed",
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
      422
    );
  }
  const ofInput = postgresInputError(error);
  if (ofInput) return c.json({ error: ofInput.message }, ofInput.status as 400 | 409 | 422);
  const message = messageOf(error);
  if (/not found/i.test(message)) return c.json({ error: message }, 404);
  register(tag, { error: message });
  return c.json({ error: message }, 500);
}

/**
 * The datasets operations, with the kon context injected.
 */
export function datasetOperations(ctx: KonContext): AnyOperation[] {
  const ops: AnyOperation[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHORIZATION (see datasets.policy.ts)
  //
  // The kon authorizes each operation by itself with `can()`. Before it only asked for a
  // session, and sign-up is public: any account rewrote game data,
  // changed other people's policies and saved formulas that were executed.
  // ═══════════════════════════════════════════════════════════════════════════

  type Dataset = typeof dataSets.$inferSelect;
  type Input = typeof dataEntries.$inferSelect;

  const userOf = (c: Context): AuthzUser | null =>
    ((c as unknown as { get(k: string): unknown }).get("user") ?? null) as AuthzUser | null;
  const asRls = (user: AuthzUser | null): RLSUser =>
    user?.id ? { id: String(user.id), role: user.role } : null;

  /** 401 without a session, 403 with one. */
  const deny = (c: Context, user: AuthzUser | null) =>
    user ? c.json({ error: "Forbidden" }, 403) : c.json({ error: "Unauthorized" }, 401);

  async function datasetById(id: string): Promise<Dataset | null> {
    if (!isUuid(id)) return null;
    const [doc] = await ctx.db.instance.select().from(dataSets).where(eq(dataSets.id, id)).limit(1);
    return (doc as Dataset | undefined) ?? null;
  }

  /** The dataset if it exists AND this user can see it; otherwise `null` (→ 404). */
  async function datasetVisible(
    c: Context,
    id: string,
    forAction?: DatasetAction
  ): Promise<Dataset | null> {
    const ds = await datasetById(id);
    if (!ds) return null;
    return (await canViewDataset(userOf(c), ds, forAction)) ? ds : null;
  }

  /**
   * The WHERE for entries this user can see in the dataset: the team
   * all of them; everyone else, filtered by the policy's `rlsRules`.
   */
  function whereVisible(ds: Dataset, user: AuthzUser | null): SQL {
    const rules = isStaff(user) ? undefined : (ds.policyJson as PolicyJson | null)?.rlsRules;
    return buildDatasetWhere(ds.id, rules, asRls(user)).where as SQL;
  }

  /** An entry OF THIS dataset (not of another with the same id in the URL). */
  async function inputOf(
    ds: Dataset,
    entryId: string,
    user?: AuthzUser | null
  ): Promise<Input | null> {
    if (!isUuid(entryId)) return null;
    // With a user and not on the team: published or their own (earlier audit)
    const visible =
      user === undefined
        ? eq(dataEntries.dataSetId, ds.id)
        : isStaff(user)
          ? whereVisible(ds, user)
          : and(whereVisible(ds, user), publishedOrOwn((user as { id?: string } | null)?.id));
    const [doc] = await ctx.db.instance
      .select()
      .from(dataEntries)
      .where(and(visible, eq(dataEntries.id, entryId)))
      .limit(1);
    return (doc as Input | undefined) ?? null;
  }

  const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,198}$/;

  /**
   * What can be written for a dataset. `PATCH` did `set({...body})`: anyone's
   * `id`, dates or `policyJson` could be changed.
   */
  function datasetChanges(body: Record<string, unknown>, canPolicy: boolean) {
    const changes: Record<string, unknown> = {};
    const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
    if (body.name !== undefined) {
      if (!text(body.name, 200) || !(body.name as string).trim())
        throw new Error("name is not valid");
      changes.name = body.name;
    }
    if (body.slug !== undefined) {
      if (typeof body.slug !== "string" || !VALID_SLUG.test(body.slug))
        throw new Error("slug is not valid");
      changes.slug = body.slug;
    }
    if (body.description !== undefined) changes.description = body.description;
    if (body.icon !== undefined) {
      if (body.icon !== null && !text(body.icon, 50)) throw new Error("icon is not valid");
      changes.icon = body.icon;
    }
    const schema = body.schema ?? body.fields;
    if (schema !== undefined) changes.schema = schema;
    if (body.displayConfig !== undefined) changes.displayConfig = body.displayConfig;
    if (body.workflowJson !== undefined) changes.workflowJson = body.workflowJson;
    if (body.contentConfig !== undefined) changes.contentConfig = body.contentConfig;
    for (const k of [
      "sourceName",
      "sourceUrl",
      "sourceLicense",
      "sourceVersion",
      "sourceCaveats",
    ] as const) {
      if (body[k] !== undefined) changes[k] = body[k];
    }
    if (body.policyJson !== undefined) {
      if (!canPolicy) throw new PolicyPermission();
      changes.policyJson = body.policyJson;
    }
    return changes;
  }
  class PolicyPermission extends Error {}

  /** Maximum entries per request when creating in bulk. */
  const MAX_ENTRIES_PER_REQUEST = 1000;

  /**
   * What can be written for an entry. The team, everything editorial;
   * everyone else only `title` and `data` (no status, no order, no owner, and not the
   * dataset it belongs to: `PATCH` with `{dataSetId}` moved it elsewhere).
   */
  function inputFields(e: Record<string, unknown>, staff: boolean) {
    const row: Record<string, unknown> = {};
    if (e.title !== undefined)
      row.title = typeof e.title === "string" ? e.title.slice(0, 500) : String(e.title);
    if (e.data !== undefined) {
      if (typeof e.data !== "object" || e.data === null || Array.isArray(e.data)) {
        throw new Error("data must be an object");
      }
      row.data = e.data;
    }
    if (staff) {
      if (e.status !== undefined) row.status = String(e.status).slice(0, 50);
      if (e.sortOrder !== undefined) row.sortOrder = Number(e.sortOrder) || 0;
      if (e.thumbnailId !== undefined) {
        if (e.thumbnailId !== null && !isUuid(String(e.thumbnailId)))
          throw new Error("thumbnailId is not valid");
        row.thumbnailId = e.thumbnailId;
      }
      if (e.ownerId !== undefined) row.ownerId = e.ownerId === null ? null : String(e.ownerId);
    }
    return row;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATASETS CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET / - List all datasets
   */
  ops.push(
    defineOperation({
      id: "list-datasets",
      method: "GET",
      route: "/",
      summary: "List datasets",
      description:
        "The datasets this caller can read (each dataset's policyJson.readAccess decides; staff see all), ordered by name, with their field schema.",
      access: "public",
      input: { query: LimitQuery },
      output: { schema: DatasetsList },
      handle: async (_input, { c }) => {
        const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

        const user = userOf(c);

        const rows = await ctx.db.instance
          .select()
          .from(dataSets)
          .orderBy(asc(dataSets.name))
          .limit(limit);

        // Only those this user can see: before, all were listed, with their
        // schema and their policy, including the admin-only ones.
        const docs = [];
        for (const ds of rows) if (await canViewDataset(user, ds)) docs.push(ds);

        return c.json({ docs, totalDocs: docs.length });
      },
    })
  );

  /**
   * POST / - Create dataset
   */
  ops.push(
    defineOperation({
      id: "create-dataset",
      method: "POST",
      route: "/",
      summary: "Create a dataset",
      description:
        "Creates a dataset (a typed collection) with its field schema. New datasets are admin-only to read and write unless an admin sets policyJson.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "create" } },
      input: { body: DatasetEntry },
      output: { status: 201, schema: Dataset },
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async (input, { c }) => {
        const user = userOf(c);

        const body = input.body ?? {};

        // Validate required fields
        if (!body.name || typeof body.name !== "string") {
          return c.json({ error: "name is required" }, 400);
        }

        // Generate slug
        const slug =
          body.slug ||
          body.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "");

        if (typeof slug !== "string" || !VALID_SLUG.test(slug)) {
          return c.json({ error: "slug is not valid (a-z, 0-9 and hyphens)" }, 400);
        }
        // The policy decides who reads and writes: an editor creates with the default
        // one (admin only); setting it is for `admin`.
        if (body.policyJson !== undefined && !(await can(user, "change-policy", {}, "dataset"))) {
          return c.json({ error: "Only admins can set a dataset's policy" }, 403);
        }

        // Check slug uniqueness
        const existing = await ctx.db.instance
          .select({ id: dataSets.id })
          .from(dataSets)
          .where(eq(dataSets.slug, slug))
          .limit(1);

        if (existing.length > 0) {
          return c.json({ error: "Slug already exists" }, 409);
        }

        const [doc] = await ctx.db.instance
          .insert(dataSets)
          .values({
            name: body.name,
            slug,
            description: body.description,
            icon: body.icon,
            /**
             * ── THE COLUMNS ARE CALLED `schema` HERE AND `fields` IN THE PANEL ──
             *
             * The database column is `schema` and holds an ARRAY of field
             * definitions, which is what the loader, the public site and the
             * entries screen read. But `DatasetDefinition` from `@kitsuden/shared`
             * calls that same array `fields`, and the panel sends that: when creating a
             * dataset from the panel, `body.schema` was `undefined` and the
             * default value was saved. Result: **a new dataset was born with
             * no columns at all**, and as an object where everything else expects
             * an array.
             *
             * Both names are accepted and an array is always saved.
             */
            schema: body.schema ?? body.fields ?? [],
            displayConfig: body.displayConfig,
            policyJson: body.policyJson || {
              readAccess: "admin",
              writeAccess: "admin",
              enableRLS: false,
            },
            workflowJson: body.workflowJson,
          })
          .returning();

        ctx.events.emit("dataset:created", doc);

        return c.json(doc, 201);
      },
    })
  );

  /**
   * GET /:id - Get dataset by ID
   */
  ops.push(
    defineOperation({
      id: "get-dataset",
      method: "GET",
      route: "/:id",
      summary: "Get a dataset",
      description:
        "One dataset by uuid, if this caller can read it (otherwise 404: existence is not confirmed).",
      access: "public",
      input: { params: ParamId },
      output: { schema: Dataset },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const id = input.params.id;
        // An id that is not a UUID cannot exist: passing it to the query makes
        // Postgres throw `invalid input syntax for type uuid`, which comes out as a 500.
        // It happened to the home panel requesting `/api/datasets/count`, which matched
        // here with id="count".
        if (!isUuid(id)) return c.json({ error: "DataSet not found" }, 404);

        // 404 also without permission: existence is not confirmed.
        const doc = await datasetVisible(c, id);

        if (!doc) {
          return c.json({ error: "Dataset not found" }, 404);
        }

        return c.json(doc);
      },
    })
  );

  /**
   * GET /slug/:slug - Get dataset by slug
   */
  ops.push(
    defineOperation({
      id: "get-dataset-by-slug",
      method: "GET",
      route: "/slug/:slug",
      summary: "Get a dataset by slug",
      description: "One dataset by slug, if this caller can read it (otherwise 404).",
      access: "public",
      input: { params: ParamSlug },
      output: { schema: Dataset },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const slug = input.params.slug;

        const [doc] = await ctx.db.instance
          .select()
          .from(dataSets)
          .where(eq(dataSets.slug, slug))
          .limit(1);

        if (!doc || !(await canViewDataset(userOf(c), doc))) {
          return c.json({ error: "Dataset not found" }, 404);
        }

        return c.json(doc);
      },
    })
  );

  /**
   * PATCH /:id - Update dataset
   */
  ops.push(
    defineOperation({
      id: "update-dataset",
      method: "PATCH",
      route: "/:id",
      summary: "Update a dataset",
      description:
        "Changes the definition of a dataset (name, slug, schema, display, source…). Changing policyJson needs an admin.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update", inHandler: true } },
      input: { params: ParamId, body: DatasetEntry },
      output: { schema: Dataset },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c, authorize }) => {
        const id = input.params.id;
        // An id that is not a UUID cannot exist: passing it to the query makes
        // Postgres throw `invalid input syntax for type uuid`, which comes out as a 500.
        // It happened to the home panel requesting `/api/datasets/count`, which matched
        // here with id="count".
        if (!isUuid(id)) return c.json({ error: "DataSet not found" }, 404);
        const body = input.body ?? {};

        const [existing] = await ctx.db.instance
          .select()
          .from(dataSets)
          .where(eq(dataSets.id, id))
          .limit(1);

        const user = userOf(c);
        if (!existing || !(await canViewDataset(user, existing))) {
          return c.json({ error: "Dataset not found" }, 404);
        }
        await authorize(existing);

        let changes: Record<string, unknown>;
        try {
          changes = datasetChanges(
            (body ?? {}) as Record<string, unknown>,
            await can(user, "change-policy", existing, "dataset")
          );
        } catch (err) {
          if (err instanceof PolicyPermission) {
            return c.json({ error: "Only admins can change a dataset's policy" }, 403);
          }
          return c.json({ error: messageOf(err) }, 400);
        }

        // An agent cannot unmark customer data (docs/agents/egress.md): with the
        // mark gone, the values it reads would leave like any other.
        const getter = c as unknown as { get(k: string): unknown };
        const isAgent =
          Boolean(getter.get("agent")) ||
          user?.role === "agent" ||
          String(user?.id ?? "").startsWith("machine-");
        if (isAgent && changes.schema !== undefined) {
          const dropped = droppedSensitivity(existing.schema, changes.schema);
          if (dropped.length) {
            return c.json(
              {
                error: `Agents cannot remove the customer-data mark of a field (${dropped.join(", ")}): a person does that.`,
                code: "KITSUDEN_E_FORBIDDEN",
              },
              403
            );
          }
        }

        // Check slug uniqueness if changing
        if (body.slug && body.slug !== existing.slug) {
          const conflict = await ctx.db.instance
            .select({ id: dataSets.id })
            .from(dataSets)
            .where(eq(dataSets.slug, body.slug))
            .limit(1);

          if (conflict.length > 0) {
            return c.json({ error: "Slug already exists" }, 409);
          }
        }

        const [updated] = await ctx.db.instance
          .update(dataSets)
          .set({
            ...changes,
            updatedAt: new Date(),
          })
          .where(eq(dataSets.id, id))
          .returning();

        ctx.events.emit("dataset:updated", updated);

        return c.json(updated);
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CALCULATED FIELDS
  // ═══════════════════════════════════════════════════════════════════════════

  // The calculated fields (/:id/calculated-fields), in the same spot of the
  // registration order their sub-router had.
  ops.push(...computedFieldOperations(ctx));

  /**
   * DELETE /:id - Delete dataset
   */
  ops.push(
    defineOperation({
      id: "delete-dataset",
      method: "DELETE",
      route: "/:id",
      summary: "Delete a dataset",
      description: "Deletes a dataset and all its entries. Admin only; cannot be undone.",
      access: "session",
      permission: { roles: ["admin"] },
      input: { params: ParamId },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const id = input.params.id;
        // An id that is not a UUID cannot exist: passing it to the query makes
        // Postgres throw `invalid input syntax for type uuid`, which comes out as a 500.
        // It happened to the home panel requesting `/api/datasets/count`, which matched
        // here with id="count".
        if (!isUuid(id)) return c.json({ error: "DataSet not found" }, 404);

        const [existing] = await ctx.db.instance
          .select({ id: dataSets.id })
          .from(dataSets)
          .where(eq(dataSets.id, id))
          .limit(1);

        if (!existing) {
          return c.json({ error: "Dataset not found" }, 404);
        }

        await ctx.db.instance.delete(dataSets).where(eq(dataSets.id, id));

        ctx.events.emit("dataset:deleted", { id });

        return c.json({ success: true });
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // ENTRIES CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /:id/entries - List entries
   *
   * Query params:
   *   - includeCalculated: "true" to include calculated fields
   *   - calculatedFields: list of specific fields (e.g. "total,subtotal")
   *   - includeThumbnailUrl: "true" to include the transformed thumbnail URL
   */
  ops.push(
    defineOperation({
      id: "list-entries",
      method: "GET",
      route: "/:id/entries",
      summary: "List the entries of a dataset",
      description:
        "Entries in sortOrder (up to 1000), filtered by the dataset's row rules for this caller. Optionally with calculated fields evaluated and thumbnail URLs.",
      access: "public",
      input: { params: ParamId, query: InputsQuery },
      output: { schema: EntriesList },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const dataSetId = input.params.id;

        /**
         * An id that is not a UUID is a dataset that does not exist, not a server
         * error.
         *
         * Without this check, `eq(dataSets.id, dataSetId)` hands the text to
         * Postgres, which answers `invalid input syntax for type uuid` and the request
         * ends in a 500. It showed up with any old or mistyped link:
         * `GET /api/data-sets/does-not-exist/entries` returned a server error where
         * a 404 belongs.
         *
         * It was detected by `scripts/smoke-routes.ts`, which requests all registered routes and
         * flags any 5xx.
         */
        if (!isUuid(dataSetId)) {
          return c.json({ error: "Dataset not found" }, 404);
        }

        const limit = Math.min(Number(c.req.query("limit")) || 500, 1000);
        const status = c.req.query("status");
        const includeCalculated = c.req.query("includeCalculated") === "true";
        const includeThumbnailUrl = c.req.query("includeThumbnailUrl") === "true";
        const calculatedFieldsParam = c.req.query("calculatedFields");

        // SECURITY (Level 1): the "dataset" policy decides whether the user can
        // read it (`readAccess`, or being on the team) and `whereVisible` translates its
        // rlsRules into a WHERE (e.g. ownerId = current_user). 404 instead of 403
        // so as not to leak the dataset's existence.
        const user = userOf(c);
        const dataset = await datasetVisible(c, dataSetId);
        if (!dataset) {
          return c.json({ error: "Dataset not found" }, 404);
        }

        // Without being on the team: only what is published, or their own. Before, any
        // reader saw drafts (or requested them with `?status=draft`)
        // (security audit).
        const rlsWhere = isStaff(user)
          ? whereVisible(dataset, user)
          : and(whereVisible(dataset, user), publishedOrOwn(user?.id));

        let query = ctx.db.instance.select().from(dataEntries).where(rlsWhere);

        if (status) {
          query = query.where(and(rlsWhere, eq(dataEntries.status, status)));
        }

        const docs = await query.orderBy(asc(dataEntries.sortOrder)).limit(limit);

        // Compute calculated fields if requested
        let calculatedFields: any[] = [];
        let docsWithCalculated = docs;

        if (includeCalculated) {
          // Load the dataset's active calculated fields
          const cfQuery = ctx.db.instance
            .select()
            .from(dataSetCalculatedFields)
            .where(
              and(
                eq(dataSetCalculatedFields.dataSetId, dataSetId),
                eq(dataSetCalculatedFields.isActive, true)
              )
            );

          // Filter specific fields if provided
          if (calculatedFieldsParam) {
            const fieldNames = calculatedFieldsParam.split(",");
            calculatedFields = await cfQuery;
            calculatedFields = calculatedFields.filter((f) => fieldNames.includes(f.name));
          } else {
            calculatedFields = await cfQuery;
          }

          // Evaluate calculated fields for each entry
          docsWithCalculated = docs.map((doc: any) => {
            const calculated: Record<string, unknown> = {};

            // Merge data with the entry for evaluation
            const row = {
              ...doc.data,
              id: doc.id,
              title: doc.title,
              status: doc.status,
              createdAt: doc.createdAt,
              updatedAt: doc.updatedAt,
            };

            const evalContext: EvaluationContext = {
              row,
              now: new Date(),
            };

            for (const field of calculatedFields) {
              try {
                const value = evaluateCalculatedField(field, evalContext);
                calculated[field.name] = formatCalculatedValue(value, field.format || undefined);
              } catch (err) {
                ctx.logger.warn(`Error evaluating calculated field "${field.name}":`, err as any);
                calculated[field.name] = null;
              }
            }

            return {
              ...doc,
              _calculated: calculated,
            };
          });
        }

        // Add thumbnail URLs if requested
        let docsWithThumbnails = docsWithCalculated;
        if (includeThumbnailUrl) {
          docsWithThumbnails = docsWithCalculated.map((doc: any) => {
            if (doc.thumbnailId) {
              return {
                ...doc,
                thumbnailUrl: `/api/media/preset/${doc.thumbnailId}/thumbnail`,
              };
            }
            return doc;
          });
        }

        return c.json({
          docs: docsWithThumbnails,
          totalDocs: docs.length,
          calculatedFields: includeCalculated
            ? calculatedFields.map((f) => ({
                id: f.id,
                name: f.name,
                label: f.label,
                type: f.type,
                format: f.format,
              }))
            : undefined,
          dataset: {
            id: dataset.id,
            name: dataset.name,
            slug: dataset.slug,
          },
        });
      },
    })
  );

  /**
   * POST /:id/entries - Create entry
   */
  ops.push(
    defineOperation({
      id: "create-entry",
      method: "POST",
      route: "/:id/entries",
      summary: "Create entries",
      description:
        "Creates one entry, or up to 1000 when the body is an array. The owner is the caller (staff can set ownerId); status, order and owner are staff-only fields.",
      access: "session",
      permission: {
        policy: { resource: "dataset-entry", action: "create", inHandler: true },
        resourceScope: (_e, resource) => datasetScopeOf(resource, "write"),
      },
      input: { params: ParamId, body: InputsInput },
      output: { status: 201, schema: InputOrInputs },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c, authorize }) => {
        const dataSetId = input.params.id;

        // Same reason as in the GET: an id that is not a UUID blows up the query.
        if (!isUuid(dataSetId)) {
          return c.json({ error: "Dataset not found" }, 404);
        }

        const body = input.body ?? {};
        const user = userOf(c);

        // Verify dataset exists (and that this user sees it: 404 if not)
        const dataset = await datasetVisible(c, dataSetId, "write");

        if (!dataset) {
          return c.json({ error: "Dataset not found" }, 404);
        }
        // Before, a session was enough: any account wrote to any dataset.
        await authorize({ dataset });

        // Support bulk creation
        const entries = Array.isArray(body) ? body : [body];
        if (entries.length === 0 || entries.length > MAX_ENTRIES_PER_REQUEST) {
          return c.json(
            { error: `Between 1 and ${MAX_ENTRIES_PER_REQUEST} entries per request` },
            400
          );
        }

        const staff = isStaff(user);
        let values: Record<string, unknown>[];
        try {
          // The owner of what an AGENT creates is its human signer
          // (no signer, no owner, as before). See @kitsuden/shared signer.ts.
          const agentRequest = (e: unknown) =>
            (e as { ownerId?: unknown } | null)?.ownerId as string | undefined;
          values = entries.map((e: unknown) => {
            if (user?.role === "agent") {
              const signature = agentSignature(user as never, agentRequest(e), "nobody");
              if (!signature.ok) throw new SignatureRejected(signature.code, signature.message);
            }
            if (typeof e !== "object" || e === null)
              throw new Error("Each entry must be an object");
            const fields = inputFields(e as Record<string, unknown>, staff);
            return {
              title: (fields.title as string | undefined) || "Untitled",
              dataSetId,
              data: fields.data ?? {},
              // Without being on the team, the status is not chosen: the dataset's
              // flow decides it (with `requireApproval`, draft). Before it came out published
              // without review (earlier audit).
              status:
                fields.status ??
                (!staff &&
                (dataset as { workflowJson?: { requireApproval?: boolean } | null }).workflowJson
                  ?.requireApproval
                  ? "draft"
                  : "published"),
              sortOrder: fields.sortOrder ?? 0,
              thumbnailId: fields.thumbnailId,
              // The owner is whoever writes. Only the team can assign it to someone else
              // (editorial loads); without this, owner-based `rlsRules` isolated nothing.
              // An AGENT is not an account (`owner_id` points to auth_users): its row
              // is left without an owner and `createdById` says who wrote it.
              ownerId:
                staff && fields.ownerId !== undefined
                  ? fields.ownerId
                  : user?.role === "agent"
                    ? ((
                        agentSignature(user as never, agentRequest(e), "nobody") as {
                          author?: string | null;
                        }
                      ).author ?? null)
                    : (user?.id ?? null),
              createdById: user?.id ?? null,
              updatedById: user?.id ?? null,
            };
          });
        } catch (err) {
          if (err instanceof SignatureRejected) {
            return c.json({ error: "Forbidden", message: err.message, code: err.code }, 403);
          }
          return c.json({ error: messageOf(err) }, 400);
        }

        const rows = await ctx.db.instance
          .insert(dataEntries)
          .values(values as never)
          .returning();

        ctx.events.emit("entry:created", { datasetId: dataSetId, entries: rows });

        return c.json(Array.isArray(body) ? rows : rows[0], 201);
      },
    })
  );

  /**
   * GET /:id/entries/:entryId - Get single entry
   *
   * Query params:
   *   - includeThumbnailUrl: "true" to include the transformed thumbnail URL
   *
   * It used to look up the entry ONLY by its id: it neither checked that it belonged to this
   * dataset nor applied its policy, so any entry of a private dataset
   * could be read by id from the URL of a public one.
   */
  ops.push(
    defineOperation({
      id: "get-entry",
      method: "GET",
      route: "/:id/entries/:entryId",
      summary: "Get an entry",
      description:
        "One entry of THIS dataset, if the dataset and its row rules let this caller see it (otherwise 404).",
      access: "public",
      input: { params: InputParam, query: InputQuery },
      output: { schema: Input },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const entryId = input.params.entryId;
        const includeThumbnailUrl = c.req.query("includeThumbnailUrl") === "true";

        const dataset = await datasetVisible(c, input.params.id);
        const doc = dataset ? await inputOf(dataset, entryId, userOf(c)) : null;

        if (!doc) {
          return c.json({ error: "Entry not found" }, 404);
        }

        // Add thumbnail URL if requested
        if (includeThumbnailUrl && doc.thumbnailId) {
          return c.json({
            ...doc,
            thumbnailUrl: `/api/media/preset/${doc.thumbnailId}/thumbnail`,
          });
        }

        return c.json(doc);
      },
    })
  );

  /**
   * PATCH /:id/entries/:entryId - Update entry
   *
   * It did `set({...body})` on the entry with that id, from ANY dataset and
   * any owner: someone else's entry could be rewritten, moved to another dataset or
   * reassigned to another owner.
   */
  ops.push(
    defineOperation({
      id: "update-entry",
      method: "PATCH",
      route: "/:id/entries/:entryId",
      summary: "Update an entry",
      description:
        "Changes title/data (and, for staff, the editorial fields). Outside the staff, only the owner can edit, and only where the dataset policy lets them write.",
      access: "session",
      permission: {
        policy: { resource: "dataset-entry", action: "update", inHandler: true },
        resourceScope: (_e, resource) => datasetScopeOf(resource, "write"),
      },
      input: { params: InputParam, body: InputInput.optional() },
      output: { schema: Input },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c, authorize }) => {
        const entryId = input.params.entryId;
        const body = input.body ?? {};
        const user = userOf(c);

        const dataset = await datasetVisible(c, input.params.id, "write");
        const existing = dataset ? await inputOf(dataset, entryId, user) : null;

        if (!dataset || !existing) {
          return c.json({ error: "Entry not found" }, 404);
        }
        await authorize({ dataset, entry: existing });

        let changes: Record<string, unknown>;
        try {
          if (typeof body !== "object" || body === null || Array.isArray(body))
            throw new Error("Invalid body");
          changes = inputFields(body as Record<string, unknown>, isStaff(user));
        } catch (err) {
          return c.json({ error: messageOf(err) }, 400);
        }

        const [updated] = await ctx.db.instance
          .update(dataEntries)
          .set({
            ...changes,
            updatedById: user?.id ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(dataEntries.id, entryId), eq(dataEntries.dataSetId, dataset.id)))
          .returning();

        ctx.events.emit("entry:updated", updated);

        return c.json(updated);
      },
    })
  );

  /**
   * DELETE /:id/entries/:entryId - Delete entry
   */
  ops.push(
    defineOperation({
      id: "delete-entry",
      method: "DELETE",
      route: "/:id/entries/:entryId",
      summary: "Delete an entry",
      description:
        "Deletes one entry of this dataset. Outside the staff, only the owner can, where the policy allows writing.",
      access: "session",
      permission: {
        policy: { resource: "dataset-entry", action: "delete", inHandler: true },
        resourceScope: (_e, resource) => datasetScopeOf(resource, "delete"),
      },
      input: { params: InputParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c, authorize }) => {
        const entryId = input.params.entryId;
        const user = userOf(c);

        const dataset = await datasetVisible(c, input.params.id, "delete");
        const existing = dataset ? await inputOf(dataset, entryId, user) : null;

        if (!dataset || !existing) {
          return c.json({ error: "Entry not found" }, 404);
        }
        await authorize({ dataset, entry: existing });

        await ctx.db.instance
          .delete(dataEntries)
          .where(and(eq(dataEntries.id, entryId), eq(dataEntries.dataSetId, dataset.id)));

        ctx.events.emit("entry:deleted", { id: entryId });

        return c.json({ success: true });
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // IMPORT / EXPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /export - Export datasets
   */
  ops.push(
    defineOperation({
      id: "export-datasets",
      method: "POST",
      route: "/export",
      summary: "Export datasets",
      description:
        "Exports whole datasets (schema, entries, optionally calculated fields) ignoring their read policy: staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "export" } },
      idempotent: true,
      input: { body: Export },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        // Exporting means taking ENTIRE datasets out, without looking at their read policy:
        // team only. Before, any session was enough (and sign-up is public), so
        // the site's `/data` guard protected nothing.
        try {
          const body = input.body ?? {};
          const config = exportConfigSchema.parse(body) as ExportConfig;

          const exportPackage = await exportDatasets(
            ctx,
            config,
            userOf(c)?.id ? String(userOf(c)!.id) : undefined
          );

          return c.json(exportPackage);
        } catch (error: unknown) {
          return failureResponse(c, error, (m, d) => ctx.logger.error(m, d), "Export failed:");
        }
      },
    })
  );

  /**
   * POST /import - Import data to datasets
   */
  ops.push(
    defineOperation({
      id: "import-to-dataset",
      method: "POST",
      route: "/import",
      summary: "Import entries into a dataset",
      description:
        "Imports rows into one dataset with a strategy (upsert, replace, merge, insert). Admin only.",
      access: "session",
      permission: { roles: ["admin"] },
      sensitive: true,
      input: { body: Import },
      output: { schema: Generic },
      handle: async (input, { c }) => {
        try {
          const body = input.body ?? {};
          const { datasetId, data, config: importConfig } = body;

          if (!datasetId || !Array.isArray(data)) {
            return c.json({ error: "datasetId and data array are required" }, 400);
          }

          const config = importConfigSchema.parse(importConfig || {}) as ImportConfig;
          const result = await importToDataset(ctx, datasetId, data, config);

          return c.json(result);
        } catch (error: unknown) {
          return failureResponse(c, error, (m, d) => ctx.logger.error(m, d), "Import failed:");
        }
      },
    })
  );

  /**
   * POST /import/package - Import complete package
   */
  ops.push(
    defineOperation({
      id: "import-package",
      method: "POST",
      route: "/import/package",
      summary: "Import an export package",
      description:
        "Imports a full package produced by the export (datasets and their entries). Admin only.",
      access: "session",
      permission: { roles: ["admin"] },
      sensitive: true,
      input: { body: ImportPackage },
      output: { schema: Generic },
      handle: async (input, { c }) => {
        try {
          const body = input.body ?? {};
          const { package: packageData, config } = body;

          if (!packageData || !packageData.datasets) {
            return c.json({ error: "Valid package is required" }, 400);
          }

          const result = await importPackage(
            ctx,
            // The package is checked by `importPackage` (the export produced it)
            packageData as unknown as Parameters<typeof importPackage>[1],
            (config ?? { strategy: "upsert" }) as unknown as Parameters<typeof importPackage>[2]
          );

          return c.json(result);
        } catch (error: unknown) {
          return failureResponse(
            c,
            error,
            (m, d) => ctx.logger.error(m, d),
            "Package import failed:"
          );
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SNAPSHOTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /:id/entries/:entryId/snapshot - Get current snapshot
   */
  ops.push(
    defineOperation({
      id: "read-snapshot",
      method: "GET",
      route: "/:id/entries/:entryId/snapshot",
      summary: "Current snapshot of an entry",
      description: "The latest stored snapshot of an entry (same visibility as reading the entry).",
      access: "public",
      input: { params: InputParam },
      output: { schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const entryId = input.params.entryId;
        // A snapshot is a copy of the entry: same policy as reading it.
        const dataset = await datasetVisible(c, input.params.id);
        if (!dataset || !(await inputOf(dataset, entryId, userOf(c)))) {
          return c.json({ error: "No snapshot found" }, 404);
        }

        const snapshot = await getCurrentSnapshot(ctx, entryId);

        if (!snapshot) {
          return c.json({ error: "No snapshot found" }, 404);
        }

        return c.json(snapshot);
      },
    })
  );

  /**
   * GET /:id/entries/:entryId/snapshots - Get snapshot history
   */
  ops.push(
    defineOperation({
      id: "snapshot-history",
      method: "GET",
      route: "/:id/entries/:entryId/snapshots",
      summary: "Snapshot history of an entry",
      description: "Every stored snapshot of an entry, newest first.",
      access: "public",
      input: { params: InputParam },
      output: { schema: z.object({ snapshots: z.array(Generic), total: z.number().int() }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const entryId = input.params.entryId;
        const dataset = await datasetVisible(c, input.params.id);
        if (!dataset || !(await inputOf(dataset, entryId, userOf(c)))) {
          return c.json({ error: "Entry not found" }, 404);
        }

        const history = await getSnapshotHistory(ctx, entryId);

        return c.json({ snapshots: history, total: history.length });
      },
    })
  );

  /**
   * POST /:id/entries/:entryId/snapshots - Create manual snapshot
   */
  ops.push(
    defineOperation({
      id: "create-snapshot",
      method: "POST",
      route: "/:id/entries/:entryId/snapshots",
      summary: "Take a manual snapshot of an entry",
      description:
        "Stores the current state of an entry (with optional reason and calculated values). Staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update", inHandler: true } },
      input: { params: InputParam, body: SnapshotManual },
      output: { status: 201, schema: Generic },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c, authorize }) => {
        const entryId = input.params.entryId;
        const dataSetId = input.params.id;
        const body = input.body ?? {};
        const user = userOf(c);

        try {
          // Get dataset config
          const dataset = await datasetVisible(c, dataSetId);

          if (!dataset || !(await inputOf(dataset, entryId))) {
            return c.json({ error: "Dataset not found" }, 404);
          }
          // A manual snapshot carries `calculatedValues` from the body: team only.
          await authorize(dataset);

          const config = detectSnapshotConfig(dataset) || {
            enabled: true,
            on: ["manual"],
            fields: [],
          };

          const snapshot = await createManualSnapshot(ctx, entryId, config, {
            reason: body.reason,
            calculatedValues: body.calculatedValues,
          });

          return c.json(snapshot, 201);
        } catch (error: unknown) {
          return failureResponse(
            c,
            error,
            (m, d) => ctx.logger.error(m, d),
            "Snapshot creation failed:"
          );
        }
      },
    })
  );

  /**
   * POST /:id/entries/:entryId/restore - Restore to snapshot
   */
  ops.push(
    defineOperation({
      id: "restore-snapshot",
      method: "POST",
      route: "/:id/entries/:entryId/restore",
      summary: "Restore an entry to a snapshot",
      description: "Rewrites the entry with the snapshot taken at `timestamp`. Staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update", inHandler: true } },
      sensitive: true,
      idempotent: true,
      input: { params: InputParam, body: Restore },
      output: { schema: z.object({ success: z.literal(true), restored: z.literal(true) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c, authorize }) => {
        const entryId = input.params.entryId;
        const body = input.body ?? {};
        const user = userOf(c);

        // Restoring REWRITES the entry with a snapshot: team only, and only
        // entries of THIS dataset.
        const dataset = await datasetVisible(c, input.params.id);
        if (!dataset || !(await inputOf(dataset, entryId))) {
          return c.json({ error: "Entry not found" }, 404);
        }
        await authorize(dataset);

        if (!body.timestamp) {
          return c.json({ error: "timestamp is required" }, 400);
        }

        try {
          await restoreToSnapshot(ctx, entryId, body.timestamp);

          return c.json({ success: true, restored: true });
        } catch (error: unknown) {
          return failureResponse(c, error, (m, d) => ctx.logger.error(m, d), "Restore failed:");
        }
      },
    })
  );

  /**
   * POST /:id/entries/:entryId/compare - Compare snapshots
   */
  ops.push(
    defineOperation({
      id: "compare-snapshots",
      method: "POST",
      route: "/:id/entries/:entryId/compare",
      summary: "Compare two snapshots",
      description:
        "Field-by-field difference between two snapshot objects sent in the body. Pure computation: reads nothing.",
      access: "public",
      idempotent: true,
      readOnly: true,
      input: { params: InputParam, body: CompareSnapshots },
      output: { schema: z.object({ comparison: z.unknown() }) },
      handle: async (input, { c }) => {
        const body = input.body ?? {};

        if (!body.snapshot1 || !body.snapshot2) {
          return c.json({ error: "Both snapshot1 and snapshot2 are required" }, 400);
        }

        const comparison = compareSnapshots(
          body.snapshot1 as Parameters<typeof compareSnapshots>[0],
          body.snapshot2 as Parameters<typeof compareSnapshots>[1]
        );

        return c.json({ comparison });
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // INDEXES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /:id/indexes/suggest - Get index suggestions
   */
  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH, FACETS AND COMPARISON
  //
  // What was missing for a dataset to be QUERYABLE and not just listable:
  // `/:id/entries` filters by `status` and `limit`, so to find something
  // you had to fetch all thousand entries and search them on the client.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Searches the entries of a dataset, with facets.
   *
   *   /api/datasets/:id/search?q=sword&filters=rarity:legendary,damage:100..
   *     &facets=rarity,slot
   *
   * Facets are counted in the database, not in JS: counting fifty thousand
   * rows in memory works in development and falls over with a real catalog.
   */
  ops.push(
    defineOperation({
      id: "search-entries",
      method: "GET",
      route: "/:id/search",
      summary: "Search the entries of a dataset",
      description:
        "Full-text search with field filters and facet counts (computed in the database), within what this caller can see. Carries the data provenance (source, licence, version).",
      access: "public",
      input: { params: ParamId, query: SearchQuery },
      output: { schema: Search },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
      handle: async (input, { c }) => {
        const dataSetId = input.params.id;

        // Before, it applied NO policy: private datasets could be searched.
        const dataset = await datasetVisible(c, dataSetId);
        if (!dataset) return c.json({ error: "Dataset not found" }, 404);

        let filters: FieldFilter[];
        try {
          filters = readFilters(c.req.query("filters"));
        } catch (error) {
          // A badly written filter is NOT ignored: ignoring it returns more results
          // than requested and whoever reads it believes it has filtered.
          return c.json({ error: messageOf(error) }, 400);
        }
        if (filters.length > SEARCH_LIMITS.filters) {
          return c.json({ error: `At most ${SEARCH_LIMITS.filters} filters` }, 400);
        }

        try {
          const result = await searchEntries(ctx.db.instance as never, {
            dataSetId,
            // Outside the team: the published or their own, also through
            // `?status=draft` (it narrows this filter, it does not replace it).
            rls: isStaff(userOf(c))
              ? undefined
              : and(
                  whereVisible(dataset, userOf(c)),
                  publishedOrOwn((userOf(c) as { id?: string } | null)?.id)
                ),
            q: c.req.query("q"),
            filters,
            facets: (c.req.query("facets") ?? "")
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean)
              .slice(0, 8),
            status: c.req.query("status"),
            limit: Number(c.req.query("limit")) || 50,
            offset: Number(c.req.query("offset")) || 0,
          });

          return c.json({
            ...result,
            // Provenance travels WITH the result: whoever looks at a search can
            // tell which patch and which source it came from without going to another screen.
            provenance: dataset.sourceName
              ? {
                  sourceName: dataset.sourceName,
                  sourceUrl: dataset.sourceUrl,
                  sourceLicense: dataset.sourceLicense,
                  sourceVersion: dataset.sourceVersion,
                  fetchedAt: dataset.fetchedAt,
                  caveats: dataset.sourceCaveats,
                }
              : null,
          });
        } catch (error) {
          return c.json({ error: messageOf(error) }, 500);
        }
      },
    })
  );

  /**
   * Compares several DIFFERENT entries field by field.
   *
   * Not to be confused with `/entries/:entryId/compare`, which compares two versions of
   * THE SAME entry. This is the product comparator: "how do
   * these three swords differ".
   */
  ops.push(
    defineOperation({
      id: "compare-entries",
      method: "POST",
      route: "/:id/compare",
      summary: "Compare entries of a dataset",
      description:
        "Field-by-field comparison of 2-8 different entries (how do these three swords differ). Read-only.",
      access: "public",
      idempotent: true,
      readOnly: true,
      input: { params: ParamId, body: CompareInputs },
      output: { schema: Comparison },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const dataSetId = input.params.id;
        const body = (input.body ?? {}) as { entryIds?: unknown };
        const ids = Array.isArray(body.entryIds)
          ? body.entryIds.filter((x): x is string => typeof x === "string" && isUuid(x))
          : [];

        const dataset = await datasetVisible(c, dataSetId);
        if (!dataset) return c.json({ error: "Dataset not found" }, 404);

        if (ids.length < 2 || ids.length > 8) {
          return c.json({ error: "Send between 2 and 8 entryIds" }, 400);
        }

        /**
         * The type is annotated by hand because `ctx.db.instance` does not propagate it.
         *
         * Without the annotation, `rows` is `any[]` and the `.map((f) => f.id)` calls below
         * pass the typecheck saying nothing. An `any` here is not seen in production:
         * it is seen the day someone renames a column and nothing warns.
         */
        const rows: (typeof dataEntries.$inferSelect)[] = await ctx.db.instance
          .select()
          .from(dataEntries)
          .where(
            and(
              whereVisible(dataset, userOf(c)),
              isStaff(userOf(c))
                ? undefined
                : publishedOrOwn((userOf(c) as { id?: string } | null)?.id),
              inArray(dataEntries.id, ids)
            )
          );

        if (rows.length < 2) {
          return c.json(
            {
              error: `Only ${rows.length} of ${ids.length} entries were found in this dataset`,
            },
            404
          );
        }

        return c.json({
          data: rows.map((f) => ({ id: f.id, title: f.title })),
          differences: compareInputs(
            rows.map((f) => ({
              id: f.id,
              title: f.title,
              data: (f.data ?? {}) as Record<string, unknown>,
            }))
          ),
        });
      },
    })
  );

  ops.push(
    defineOperation({
      id: "suggest-indexes",
      method: "GET",
      route: "/:id/indexes/suggest",
      summary: "Suggest indexes for a dataset",
      description: "Index suggestions for the dataset fields (read-only analysis). Staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update" } },
      input: { params: ParamId },
      output: { schema: z.object({ suggestions: z.array(Generic) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (input, { c }) => {
        const dataSetId = input.params.id;
        if (!isUuid(dataSetId)) return c.json({ error: "Dataset not found" }, 404);

        try {
          const [dataset] = await ctx.db.instance
            .select()
            .from(dataSets)
            .where(eq(dataSets.id, dataSetId))
            .limit(1);

          if (!dataset) {
            return c.json({ error: "Dataset not found" }, 404);
          }

          const suggestions = suggestIndexesForDataset(dataset.slug, dataset.schema);

          return c.json({ suggestions });
        } catch (error: unknown) {
          return failureResponse(
            c,
            error,
            (m, d) => ctx.logger.error(m, d),
            "Index suggestion failed:"
          );
        }
      },
    })
  );

  /**
   * GET /indexes/stats - Get index statistics
   */
  ops.push(
    defineOperation({
      id: "index-stats",
      method: "GET",
      route: "/indexes/stats",
      summary: "Index statistics",
      description: "Index usage statistics of the whole database. Admin only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "manage-indexes" } },
      output: { schema: z.object({ stats: z.unknown() }) },
      handle: async (_input, { c }) => {
        // Index statistics for the WHOLE database: admin only.
        try {
          const stats = await getIndexStats(ctx);
          return c.json({ stats });
        } catch (error: unknown) {
          return failureResponse(c, error, (m, d) => ctx.logger.error(m, d), "Index stats failed:");
        }
      },
    })
  );

  /**
   * POST /indexes/report - Generate index report
   */
  ops.push(
    defineOperation({
      id: "index-report",
      method: "POST",
      route: "/indexes/report",
      summary: "Index report",
      description: "A report of missing and unused indexes. Read-only analysis; admin only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "manage-indexes" } },
      idempotent: true,
      readOnly: true,
      output: { schema: Generic },
      handle: async (_input, { c }) => {
        try {
          const report = await generateIndexReport(ctx);
          return c.json(report);
        } catch (error: unknown) {
          return failureResponse(
            c,
            error,
            (m, d) => ctx.logger.error(m, d),
            "Index report failed:"
          );
        }
      },
    })
  );

  /**
   * POST /:id/indexes/apply - Apply index configuration
   */
  ops.push(
    defineOperation({
      id: "apply-indexes",
      method: "POST",
      route: "/:id/indexes/apply",
      summary: "Apply an index configuration",
      description:
        "Creates the configured indexes for a dataset (DDL on the database). Admin only.",
      access: "session",
      permission: { roles: ["admin"] },
      sensitive: true,
      idempotent: true,
      input: { params: ParamId, body: ApplyIndexes },
      output: { schema: Generic },
      mcp: { exclude: "runs DDL on the database; a human task" },
      handle: async (input, { c }) => {
        const dataSetId = input.params.id;
        const body = input.body ?? {};

        try {
          // Without `config` the schema defaults apply (before, `parse(undefined)` = 500).
          const config = indexConfigSchema.parse(body.config ?? {});
          const result = await applyIndexConfig(ctx, dataSetId, config);

          return c.json(result);
        } catch (error: unknown) {
          return failureResponse(
            c,
            error,
            (m, d) => ctx.logger.error(m, d),
            "Apply indexes failed:"
          );
        }
      },
    })
  );

  /**
   * POST /indexes/auto - Apply auto indexes
   */
  ops.push(
    defineOperation({
      id: "auto-indexes",
      method: "POST",
      route: "/indexes/auto",
      summary: "Apply suggested indexes automatically",
      description:
        "Creates every suggested index above a confidence level across all datasets (DDL). Admin only.",
      access: "session",
      permission: { roles: ["admin"] },
      sensitive: true,
      idempotent: true,
      input: { body: IndicesAuto },
      output: { schema: Generic },
      mcp: { exclude: "runs DDL on the database; a human task" },
      handle: async (input, { c }) => {
        const body = input.body ?? {};

        try {
          // Get all suggestions
          const { dataSets: dsTable } = await import("./datasets.schema");
          const datasets = await ctx.db.instance.select().from(dsTable);

          const allSuggestions: any[] = [];
          for (const dataset of datasets) {
            allSuggestions.push(...suggestIndexesForDataset(dataset.slug, dataset.schema));
          }

          const result = await applyAutoIndexes(ctx, allSuggestions, body.minConfidence || "high");

          return c.json(result);
        } catch (error: unknown) {
          return failureResponse(
            c,
            error,
            (m, d) => ctx.logger.error(m, d),
            "Auto indexes failed:"
          );
        }
      },
    })
  );

  return ops;
}

/** The datasets REST router, generated from its operations. */
export function createDatasetsRouter(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, datasetOperations(ctx), ctx);
}

/** The agent's signer does not allow creating the entry (403). */
class SignatureRejected extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}
