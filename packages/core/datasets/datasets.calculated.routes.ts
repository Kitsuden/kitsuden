/**
 * Kitsuden — Calculated Fields Routes
 * ============================================================================
 *
 * CRUD for the calculated fields (KPIs) of a dataset.
 *
 * These are kon SDK operations that `datasetOperations` adds to
 * its own, at `/:id/calculated-fields` (the `:id` is the dataset's). It used to be
 * a sub-router with an `app.use("*")` that authorized; now each operation
 * calls `authorizeFields()` first, with the same responses.
 */

import {
  defineOperation,
  postgresInputError,
  isUuid,
  messageOf,
  type AuthzUser,
  type OperationContext,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { createCalculatedFieldSchema, updateCalculatedFieldSchema } from "./datasets.calculated";
import { dataSetCalculatedFields } from "./datasets.calculated.schema";
import { canViewDataset } from "./datasets.policy";
import { dataSets } from "./datasets.schema";
import {
  ComputedFieldChanges,
  ComputedFieldInput,
  ComputedFieldOutput,
  Success,
  ComputedFieldsList,
  FieldParam,
  ParamId,
} from "./datasets.wire-schemas";

export function computedFieldOperations(ctx: KonContext): AnyOperation[] {
  const { db, logger } = ctx;
  const ops: AnyOperation[] = [];

  /** Reads the dataset id from the parent router (`/:id/calculated-fields`). */
  const datasetIdOf = (c: { req: { param: (k: string) => string | undefined } }) =>
    c.req.param("id") ?? c.req.param("datasetId");

  /**
   * Authorization for the WHOLE sub-router, before each handler.
   *
   * It had none: any session (sign-up is public) created, changed
   * or deleted formulas of any dataset, and the formula was run with
   * `new Function` when listing entries. Reading requires being able to see the dataset;
   * writing, being able to edit it (the team). 404 instead of 403 on read so as not to
   * confirm that it exists.
   */
  async function authorizeFields(
    c: Context,
    authorize: OperationContext["authorize"]
  ): Promise<Response | null> {
    const datasetId = datasetIdOf(c);
    if (!datasetId || !isUuid(datasetId)) {
      return c.json({ success: false, error: "Dataset not found" }, 404);
    }
    const [dataset] = await db.instance
      .select({ id: dataSets.id, policyJson: dataSets.policyJson })
      .from(dataSets)
      .where(eq(dataSets.id, datasetId))
      .limit(1);
    const user = ((c as unknown as { get(k: string): unknown }).get("user") ??
      null) as AuthzUser | null;
    if (!dataset || !(await canViewDataset(user, dataset))) {
      return c.json({ success: false, error: "Dataset not found" }, 404);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (!user) return c.json({ success: false, error: "Unauthorized" }, 401);
      // The operation's permission (policy `dataset:update` or its fine-grained scope)
      await authorize(dataset);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIST — GET /api/datasets/:id/calculated-fields
  // ═══════════════════════════════════════════════════════════════════════════
  ops.push(
    defineOperation({
      id: "list-calculated-fields",
      method: "GET",
      route: "/:id/calculated-fields",
      summary: "List the calculated fields of a dataset",
      description:
        "The calculated fields (formulas, aggregates, KPIs) of a dataset this caller can read.",
      access: "public",
      input: { params: ParamId },
      output: { schema: ComputedFieldsList },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c, authorize }) => {
        const no = await authorizeFields(c, authorize);
        if (no) return no;
        const datasetId = datasetIdOf(c);
        if (!datasetId) return c.json({ success: false, error: "datasetId required" }, 400);

        try {
          const fields = await db.instance
            .select()
            .from(dataSetCalculatedFields)
            .where(eq(dataSetCalculatedFields.dataSetId, datasetId))
            .orderBy(dataSetCalculatedFields.sortOrder);

          return c.json({
            success: true,
            fields: fields.map((f: any) => ({
              ...f,
              config: f.config || {},
              format: f.format || {},
              dependsOn: f.dependsOn || [],
            })),
          });
        } catch (err: unknown) {
          logger.error("Failed to list calculated fields", { err, datasetId });
          return c.json({ success: false, error: messageOf(err) }, 500);
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE — POST /api/datasets/:id/calculated-fields
  // ═══════════════════════════════════════════════════════════════════════════
  ops.push(
    defineOperation({
      id: "create-calculated-field",
      method: "POST",
      route: "/:id/calculated-fields",
      summary: "Create a calculated field",
      description:
        "Adds a calculated field. Formulas are parsed by Kitsuden's own interpreter, never executed as code. Staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update", inHandler: true } },
      input: { params: ParamId, body: ComputedFieldInput },
      output: { status: 201, schema: ComputedFieldOutput },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
      handle: async (input, { c, authorize }) => {
        const no = await authorizeFields(c, authorize);
        if (no) return no;
        const datasetId = datasetIdOf(c);
        if (!datasetId) return c.json({ success: false, error: "datasetId required" }, 400);

        // The body the SDK already read: `c.req.json()` on an empty body
        // threw "Unexpected EOF" and came out as a 500 (Schemathesis).
        const body = input.body ?? {};
        const validation = createCalculatedFieldSchema.omit({ dataSetId: true }).safeParse(body);
        if (!validation.success) {
          return c.json(
            { success: false, error: "Validation failed", details: validation.error.format() },
            400
          );
        }
        const data = validation.data;

        try {
          // Unique name within the dataset.
          const existing = await db.instance
            .select({ id: dataSetCalculatedFields.id })
            .from(dataSetCalculatedFields)
            .where(
              and(
                eq(dataSetCalculatedFields.dataSetId, datasetId),
                eq(dataSetCalculatedFields.name, data.name)
              )
            )
            .limit(1);

          if (existing.length > 0) {
            return c.json(
              { success: false, error: `A calculated field named "${data.name}"` },
              409
            );
          }

          const [field] = await db.instance
            .insert(dataSetCalculatedFields)
            .values({
              dataSetId: datasetId,
              name: data.name,
              label: data.label,
              type: data.type,
              config: data.config,
              format: data.format,
              description: data.description,
              category: data.category,
              isKpi: data.isKpi,
              target: data.target,
              warningThreshold: data.warningThreshold,
              dependsOn: data.dependsOn,
            })
            .returning();

          await ctx.cache.invalidate(`dataset:${datasetId}:*`);
          return c.json({ success: true, field }, 201);
        } catch (err: unknown) {
          const ofInput = postgresInputError(err);
          if (ofInput) {
            return c.json(
              { success: false, error: ofInput.message },
              ofInput.status as 400 | 409 | 422
            );
          }
          logger.error("Failed to create calculated field", { err, datasetId });
          return c.json({ success: false, error: messageOf(err) }, 500);
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // GET ONE — GET /api/datasets/:id/calculated-fields/:fieldId
  // ═══════════════════════════════════════════════════════════════════════════
  ops.push(
    defineOperation({
      id: "get-calculated-field",
      method: "GET",
      route: "/:id/calculated-fields/:fieldId",
      summary: "Get a calculated field",
      description: "One calculated field of a dataset this caller can read.",
      access: "public",
      input: { params: FieldParam },
      output: { schema: ComputedFieldOutput },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
      handle: async (input, { c, authorize }) => {
        const no = await authorizeFields(c, authorize);
        if (no) return no;
        const datasetId = datasetIdOf(c);
        const fieldId = input.params.fieldId;
        if (!datasetId || !fieldId || !isUuid(fieldId)) {
          return c.json({ success: false, error: "datasetId and fieldId required" }, 400);
        }

        try {
          const [field] = await db.instance
            .select()
            .from(dataSetCalculatedFields)
            .where(
              and(
                eq(dataSetCalculatedFields.id, fieldId),
                eq(dataSetCalculatedFields.dataSetId, datasetId)
              )
            )
            .limit(1);

          if (!field) return c.json({ success: false, error: "Field not found" }, 404);
          return c.json({ success: true, field });
        } catch (err: unknown) {
          logger.error("Failed to get calculated field", { err, fieldId });
          return c.json({ success: false, error: messageOf(err) }, 500);
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE — PATCH /api/datasets/:id/calculated-fields/:fieldId
  // ═══════════════════════════════════════════════════════════════════════════
  ops.push(
    defineOperation({
      id: "update-calculated-field",
      method: "PATCH",
      route: "/:id/calculated-fields/:fieldId",
      summary: "Update a calculated field",
      description:
        "Changes a calculated field (including activating it or reordering). Staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update", inHandler: true } },
      input: { params: FieldParam, body: ComputedFieldChanges },
      output: { schema: ComputedFieldOutput },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
      handle: async (input, { c, authorize }) => {
        const no = await authorizeFields(c, authorize);
        if (no) return no;
        const datasetId = datasetIdOf(c);
        const fieldId = input.params.fieldId;
        if (!datasetId || !fieldId || !isUuid(fieldId)) {
          return c.json({ success: false, error: "datasetId and fieldId required" }, 400);
        }

        const body = input.body ?? {};
        const validation = updateCalculatedFieldSchema.safeParse(body);
        if (!validation.success) {
          return c.json(
            { success: false, error: "Validation failed", details: validation.error.format() },
            400
          );
        }
        const data = validation.data;

        try {
          const [updated] = await db.instance
            .update(dataSetCalculatedFields)
            .set({
              ...(data.name !== undefined && { name: data.name }),
              ...(data.label !== undefined && { label: data.label }),
              ...(data.type !== undefined && { type: data.type }),
              ...(data.config !== undefined && { config: data.config }),
              ...(data.format !== undefined && { format: data.format }),
              ...(data.description !== undefined && { description: data.description }),
              ...(data.category !== undefined && { category: data.category }),
              ...(data.isKpi !== undefined && { isKpi: data.isKpi }),
              ...(data.target !== undefined && { target: data.target }),
              ...(data.warningThreshold !== undefined && {
                warningThreshold: data.warningThreshold,
              }),
              ...(data.dependsOn && { dependsOn: data.dependsOn }),
              ...(data.isActive !== undefined && { isActive: data.isActive }),
              ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(dataSetCalculatedFields.id, fieldId),
                eq(dataSetCalculatedFields.dataSetId, datasetId)
              )
            )
            .returning();

          if (!updated) return c.json({ success: false, error: "Field not found" }, 404);

          await ctx.cache.invalidate(`dataset:${datasetId}:*`);
          return c.json({ success: true, field: updated });
        } catch (err: unknown) {
          logger.error("Failed to update calculated field", { err, fieldId });
          return c.json({ success: false, error: messageOf(err) }, 500);
        }
      },
    })
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE — DELETE /api/datasets/:id/calculated-fields/:fieldId
  // ═══════════════════════════════════════════════════════════════════════════
  ops.push(
    defineOperation({
      id: "delete-calculated-field",
      method: "DELETE",
      route: "/:id/calculated-fields/:fieldId",
      summary: "Delete a calculated field",
      description: "Removes a calculated field from a dataset. Staff only.",
      access: "session",
      permission: { policy: { resource: "dataset", action: "update", inHandler: true } },
      input: { params: FieldParam },
      output: { schema: Success },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_BAD_REQUEST"],
      handle: async (input, { c, authorize }) => {
        const no = await authorizeFields(c, authorize);
        if (no) return no;
        const datasetId = datasetIdOf(c);
        const fieldId = input.params.fieldId;
        if (!datasetId || !fieldId || !isUuid(fieldId)) {
          return c.json({ success: false, error: "datasetId and fieldId required" }, 400);
        }

        try {
          const [deleted] = await db.instance
            .delete(dataSetCalculatedFields)
            .where(
              and(
                eq(dataSetCalculatedFields.id, fieldId),
                eq(dataSetCalculatedFields.dataSetId, datasetId)
              )
            )
            .returning();

          if (!deleted) return c.json({ success: false, error: "Field not found" }, 404);

          await ctx.cache.invalidate(`dataset:${datasetId}:*`);
          return c.json({ success: true });
        } catch (err: unknown) {
          logger.error("Failed to delete calculated field", { err, fieldId });
          return c.json({ success: false, error: messageOf(err) }, 500);
        }
      },
    })
  );

  return ops;
}
