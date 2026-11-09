/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CODE GENERATION API — /api/generate-code
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Generates frontend code (React hooks, Vue composables, Svelte stores,
 * TypeScript types, forms, components) from any collection.
 *
 * POST /api/generate-code
 * Body: {
 *   collection: string,       // dataset slug or native table name
 *   framework: "react" | "vue" | "svelte",
 *   type: "hook" | "component" | "form" | "types" | "all",
 *   baseUrl?: string          // optional API base URL
 * }
 *
 * Response: {
 *   collection: string,
 *   framework: string,
 *   files: [{ filename, content, language }]
 * }
 */

import { messageOf } from "@kitsuden/engine";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { generateReact } from "../../../../packages/codegen/src/generators/react";
import { generateSvelte } from "../../../../packages/codegen/src/generators/svelte";
import { generateVue } from "../../../../packages/codegen/src/generators/vue";
import { db, mergedSchema } from "../db";
import { dataSets } from "../db/schema-core";
import { logger } from "../lib/logger";
import { introspectTable } from "../services/schema-introspector";
import type { AppVariables } from "../types/hono";

// Import generators (will be resolved at runtime via Bun)

export const codegenRoutes = new Hono<{ Variables: AppVariables }>();

// ── Types ──

interface GenerateCodeRequest {
  collection: string;
  framework: "react" | "vue" | "svelte";
  type?: "hook" | "component" | "form" | "types" | "all";
  baseUrl?: string;
}

interface ColumnInfo {
  name: string;
  type: string;
  required: boolean;
  isPrimaryKey?: boolean;
  isRelation?: boolean;
}

interface CollectionInfo {
  slug: string;
  name: string;
  kind: "dataset" | "native";
  columns: ColumnInfo[];
  primaryKey: string;
}

// ── Helpers ──

function isDrizzleTable(val: unknown): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    typeof (val as any)[Symbol.for("drizzle:Name")] === "string"
  );
}

async function resolveCollection(collectionSlug: string): Promise<CollectionInfo | null> {
  // 1. Try dataset first
  const [ds] = await db.select().from(dataSets).where(eq(dataSets.slug, collectionSlug)).limit(1);
  if (ds) {
    const columns: ColumnInfo[] = (ds.schema || []).map((field: any) => ({
      name: field.fieldName,
      type: field.fieldType,
      required: !!field.required,
      isPrimaryKey: false,
    }));

    // Add system fields
    columns.unshift(
      { name: "id", type: "uuid", required: true, isPrimaryKey: true },
      { name: "title", type: "text", required: true },
      { name: "status", type: "text", required: false },
      { name: "sortOrder", type: "number", required: false },
      { name: "createdAt", type: "timestamp", required: true },
      { name: "updatedAt", type: "timestamp", required: true }
    );

    return {
      slug: ds.slug,
      name: ds.name,
      kind: "dataset",
      columns,
      primaryKey: "id",
    };
  }

  // 2. Try native table from mergedSchema
  const tableKey = Object.keys(mergedSchema).find(
    (k) => k.toLowerCase() === collectionSlug.toLowerCase()
  );
  const table = tableKey ? (mergedSchema as any)[tableKey] : null;

  if (table && isDrizzleTable(table)) {
    const tableName = table[Symbol.for("drizzle:Name")];
    const introspected = await introspectTable(tableName);

    if (introspected) {
      const columns: ColumnInfo[] = introspected.columns.map((col) => ({
        name: col.name,
        type: col.type,
        required: !col.nullable,
        isPrimaryKey: col.isPrimaryKey,
        isRelation: col.isForeignKey,
      }));

      return {
        slug: collectionSlug,
        name: toHumanName(collectionSlug),
        kind: "native",
        columns,
        primaryKey: introspected.primaryKey[0] || "id",
      };
    }

    // Fallback: infer from Drizzle object
    const columns: ColumnInfo[] = [];
    for (const [key, val] of Object.entries(table)) {
      if (typeof key !== "string" || !val || typeof val !== "object") continue;
      const ctorName = Object.getPrototypeOf(val)?.constructor?.name || "";
      if (!ctorName.startsWith("Pg") || ctorName === "PgTable") continue;
      const col = val as any;
      columns.push({
        name: col.name || key,
        type: col.dataType || "string",
        required: !!col.notNull,
        isPrimaryKey: key === "id",
      });
    }

    return {
      slug: collectionSlug,
      name: toHumanName(collectionSlug),
      kind: "native",
      columns,
      primaryKey: "id",
    };
  }

  // 3. Try database introspection (table might exist without being in mergedSchema)
  const introspected = await introspectTable(collectionSlug);
  if (introspected) {
    return {
      slug: collectionSlug,
      name: toHumanName(collectionSlug),
      kind: "native",
      columns: introspected.columns.map((col) => ({
        name: col.name,
        type: col.type,
        required: !col.nullable,
        isPrimaryKey: col.isPrimaryKey,
        isRelation: col.isForeignKey,
      })),
      primaryKey: introspected.primaryKey[0] || "id",
    };
  }

  return null;
}

function toHumanName(slug: string): string {
  return slug
    .replace(/^kon[-_]/, "")
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// ── Routes ──

codegenRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json<GenerateCodeRequest>();
    const { collection, framework, type = "all", baseUrl } = body;

    if (!collection) {
      return c.json({ error: "collection is required" }, 400);
    }

    if (!["react", "vue", "svelte"].includes(framework)) {
      return c.json({ error: "framework must be react, vue, or svelte" }, 400);
    }

    const collectionInfo = await resolveCollection(collection);
    if (!collectionInfo) {
      return c.json({ error: `Collection '${collection}' not found` }, 404);
    }

    const options = {
      collection: collectionInfo,
      framework,
      type,
      baseUrl: baseUrl || `${new URL(c.req.url).origin}/api`,
    };

    let files;
    switch (framework) {
      case "react":
        files = generateReact(options);
        break;
      case "vue":
        files = generateVue(options);
        break;
      case "svelte":
        files = generateSvelte(options);
        break;
      default:
        return c.json({ error: "Unsupported framework" }, 400);
    }

    return c.json({
      collection: collectionInfo.slug,
      name: collectionInfo.name,
      kind: collectionInfo.kind,
      framework,
      type,
      fileCount: files.length,
      files,
    });
  } catch (err: unknown) {
    logger.error({ error: messageOf(err) }, "Code generation failed");
    return c.json({ error: "Code generation failed", details: messageOf(err) }, 500);
  }
});

// GET /api/generate-code/collections — List available collections
codegenRoutes.get("/collections", async (c) => {
  try {
    const datasets = await db.select({ slug: dataSets.slug, name: dataSets.name }).from(dataSets);

    const nativeTables = Object.entries(mergedSchema)
      .filter(([k, v]) => isDrizzleTable(v) && !k.endsWith("Relations") && !k.endsWith("Enum"))
      .map(([k, v]) => ({
        slug: k,
        name: toHumanName(k),
        kind: "native" as const,
        dbName: (v as any)[Symbol.for("drizzle:Name")],
      }));

    return c.json({
      datasets: datasets.map((d) => ({ slug: d.slug, name: d.name, kind: "dataset" })),
      nativeTables,
    });
  } catch (err: unknown) {
    return c.json({ error: messageOf(err) }, 500);
  }
});

// GET /api/generate-code/:collection — Preview collection schema
codegenRoutes.get("/:collection", async (c) => {
  try {
    const slug = c.req.param("collection");
    const info = await resolveCollection(slug);
    if (!info) {
      return c.json({ error: `Collection '${slug}' not found` }, 404);
    }
    return c.json(info);
  } catch (err: unknown) {
    return c.json({ error: messageOf(err) }, 500);
  }
});

export default codegenRoutes;
