/**
 * KITSUDEN Vault — Routes (KITSUDEN architecture §3)
 *
 * Mounted at /api/admin/vault (protected by the global admin middleware).
 * Real DDL (CREATE/ALTER TABLE) restricted to admins. Reading rows via
 * the Graphify Engine (/api/graph/vault_<collection>) which already applies transactional
 * RLS; writing rows here (under the same RLS via c.get("tx")).
 *
 * Feature flag: KITSUDEN_VAULT_ENABLED=true
 *
 * CHAINED SYNTAX (Hono RPC): chained definition + zValidator so that
 * the hc<KitsudenRpcType> client gets request/response types per endpoint.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db";
import {
  createCollection,
  addColumn,
  dropColumn,
  dropCollection,
  listCollections,
  insertRow,
  updateRow,
  deleteRow,
  isVaultEnabled,
  VaultError,
} from "../services/vault";

const columnSchema = z.object({
  name: z.string().min(1).max(51),
  type: z.enum([
    "text",
    "varchar",
    "integer",
    "bigint",
    "numeric",
    "boolean",
    "timestamp",
    "date",
    "uuid",
    "jsonb",
  ]),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
});

const createCollectionSchema = z.object({
  collection: z.string().min(1).max(51),
  columns: z.array(columnSchema).min(1).max(60),
});

const rowSchema = z.record(z.string(), z.unknown());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getExecutor(c: any) {
  return c.get("tx") ?? db;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(c: any, err: unknown) {
  if (err instanceof VaultError) {
    return c.json({ success: false, error: err.message }, err.status);
  }
  if (err instanceof z.ZodError) {
    return c.json({ success: false, error: "Validation failed", issues: err.issues }, 400);
  }
  console.error("[Vault] Unexpected error:", err);
  return c.json({ success: false, error: "Vault internal error" }, 500);
}

export const vaultRoutes = new Hono()

  // Feature flag gate (disruptive, so it is opt-in)
  .use("/*", async (c, next) => {
    if (!isVaultEnabled()) {
      return c.json(
        {
          success: false,
          error:
            "KITSUDEN Vault is disabled. Set KITSUDEN_VAULT_ENABLED=true to enable dynamic DDL.",
          docs: "docs/install/variables.md (KITSUDEN_VAULT_ENABLED)",
        },
        503
      );
    }
    await next();
  })

  /** GET /api/admin/vault — Vault collections with introspected schema */
  .get("/", async (c) => {
    try {
      const collections = await listCollections();
      return c.json({ success: true, collections, count: collections.length });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /**
   * POST /api/admin/vault — real CREATE TABLE + indexes + RLS.
   * Body: { collection, columns: [{ name, type, required?, unique?, indexed? }] }
   */
  .post("/", zValidator("json", createCollectionSchema), async (c) => {
    try {
      const body = c.req.valid("json");
      const result = await createCollection(body.collection, body.columns);
      return c.json({
        success: true,
        ...result,
        graphify: `/api/graph/${result.table}`,
        message: "Real PostgreSQL table created with RLS enabled",
      });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /** POST /api/admin/vault/:collection/columns — hot ALTER TABLE ADD COLUMN */
  .post("/:collection/columns", zValidator("json", columnSchema), async (c) => {
    try {
      const col = c.req.valid("json");
      await addColumn(c.req.param("collection"), col);
      return c.json({ success: true, collection: c.req.param("collection"), column: col.name });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /** DELETE .../columns/:column — DROP COLUMN (reserved columns protected) */
  .delete("/:collection/columns/:column", async (c) => {
    try {
      await dropColumn(c.req.param("collection"), c.req.param("column"));
      return c.json({
        success: true,
        collection: c.req.param("collection"),
        column: c.req.param("column"),
      });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /** POST /api/admin/vault/:collection/rows — parameterized INSERT (owner = user) */
  .post("/:collection/rows", zValidator("json", rowSchema), async (c) => {
    try {
      const data = c.req.valid("json");
      const user = c.get("user") as { id?: string } | null;
      const row = await insertRow(
        getExecutor(c),
        c.req.param("collection"),
        data,
        user?.id ?? null
      );
      return c.json({ success: true, row }, 201);
    } catch (err) {
      return handleError(c, err);
    }
  })

  /** PATCH /api/admin/vault/:collection/rows/:id — UPDATE under RLS */
  .patch("/:collection/rows/:id", zValidator("json", rowSchema), async (c) => {
    try {
      const data = c.req.valid("json");
      const row = await updateRow(
        getExecutor(c),
        c.req.param("collection"),
        c.req.param("id"),
        data
      );
      if (!row) return c.json({ success: false, error: "Row not found" }, 404);
      return c.json({ success: true, row });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /** DELETE /api/admin/vault/:collection/rows/:id — DELETE under RLS */
  .delete("/:collection/rows/:id", async (c) => {
    try {
      const deleted = await deleteRow(getExecutor(c), c.req.param("collection"), c.req.param("id"));
      if (!deleted) return c.json({ success: false, error: "Row not found" }, 404);
      return c.json({ success: true, deleted: true });
    } catch (err) {
      return handleError(c, err);
    }
  })

  /** DELETE /api/admin/vault/:collection?confirm=<collection> — DROP TABLE */
  .delete("/:collection", async (c) => {
    const collection = c.req.param("collection");
    if (c.req.query("confirm") !== collection) {
      return c.json(
        {
          success: false,
          error: `Destructive operation. Repeat the collection name: ?confirm=${collection}`,
        },
        400
      );
    }
    try {
      await dropCollection(collection);
      return c.json({ success: true, collection, dropped: true });
    } catch (err) {
      return handleError(c, err);
    }
  });

/** Accumulated router type — consumed by src/rpc.ts */
export type VaultRoutesType = typeof vaultRoutes;
