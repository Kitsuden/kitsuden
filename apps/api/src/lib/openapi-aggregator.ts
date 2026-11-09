/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OPENAPI AGGREGATOR - Dynamic OpenAPI Spec Generation from Kons
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This module aggregates OpenAPI specifications from all loaded kons
 * into a single unified API specification.
 *
 * Features:
 * - Auto-generates OpenAPI 3.0.0 spec from kon definitions
 * - Converts Zod schemas to JSON Schema
 * - Prefixes schemas with kon ID to avoid conflicts
 * - Auto-generates operationIds for code generation
 * - Supports tags, webhooks, and reusable components
 */

import {
  KITSUDEN_VERSION,
  accessToDataset,
  schemaFields,
  type KonOperation,
  KonDefinition,
  KonOpenApiPath,
  OpenApiMethod,
} from "@kitsuden/shared";
import type {
  OpenAPIObject,
  PathItemObject,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from "openapi3-ts/oas30";
import type { ZodTypeAny } from "zod";

import { db } from "../db";
import { dataSets } from "../db/schema";

import { coreOperations } from "./core-operations";
import { konRoutes } from "./kon-routes";
import { logger } from "./logger";
import {
  SECURITY_SCHEMES,
  commonComponents,
  jsonSchema,
  openApiOperation,
} from "./operations-openapi";
import { checkReadAccess, type PolicyJson, type RLSUser } from "./rls-builder";

/**
 * Options for generating OpenAPI specification
 */
export interface OpenApiAggregatorOptions {
  /** API title */
  title?: string;
  /** API version */
  version?: string;
  /** API description */
  description?: string;
  /** Server URLs */
  servers?: Array<{ url: string; description?: string }>;
  /** Include only specific kons (default: all) */
  includeKons?: string[];
  /** Exclude specific kons */
  excludeKons?: string[];
  /**
   * Who asks for the document. Only the datasets THIS identity can read are
   * described; without an identity (or `null`), the public-read ones.
   */
  user?: RLSUser | null;
}

/**
 * Does this dataset appear in this identity's OpenAPI document?
 *
 * Security review 2026-11-04 (F11): `/api/docs/openapi.json` needs no session
 * and described EVERY dataset (name, description, fields and enum options),
 * including those `GET /api/data-sets` hides from the caller. The rule is that
 * listing's (`crud.ts`): the agent's per-dataset scopes decide first, the team
 * sees them all, and otherwise the read policy decides.
 */
export function datasetVisibleInDocs(
  ds: { slug: string | null; policyJson: unknown },
  user: RLSUser | null | undefined
): boolean {
  const scopes = (user as { scopes?: unknown } | null | undefined)?.scopes;
  const access = accessToDataset(
    Array.isArray(scopes) ? (scopes as string[]) : undefined,
    ds.slug,
    "read"
  );
  if (access) return access === "granted";
  if (user?.role === "admin" || user?.role === "editor") return true;
  return checkReadAccess((ds.policyJson ?? null) as PolicyJson | null, user ?? null);
}

/**
 * Default OpenAPI info
 */
const DEFAULT_INFO = {
  title: "Kitsuden API",
  version: "0.8.0-beta",
  description: `🚀 Kitsuden - Auto-generated API from active kons

## Features

- **Dynamic Datasets**: CRUD operations with flexible schemas
- **Content Management**: Blog, Media, Pages with SEO support
- **Real-time**: WebSocket subscriptions for live updates
- **AI-Native**: MCP Server integration for AI agents
- **Multi-tenant**: Row-Level Security by default

## Authentication

Three methods supported:
1. **Session Cookie** - For web users (Better-Auth)
2. **Agent Token** - For AI agents and machine integrations (kitsuden_agent_*) — recommended
3. **Legacy API Key** - Bearer token (kitsuden_sk_*) — **DEPRECATED**, sunset 2026-08-01. Migrate to kitsuden_agent_*

\`\`\`
Authorization: Bearer your_token_here
\`\`\`
`,
};

/**
 * Convert Zod schema to JSON Schema object
 */
function zodToOpenApiSchema(zodSchema: ZodTypeAny, name?: string): SchemaObject {
  try {
    return jsonSchema(zodSchema) as SchemaObject;
  } catch (error) {
    logger.error({ error, name }, "Failed to convert Zod schema to JSON Schema");
    return { type: "object", description: "Schema conversion failed" };
  }
}

/**
 * Converts the zod schema of a discovered body to inline JSON Schema.
 * If the schema is not zod 4 (a kon with another version), it falls back to the generic one.
 */
function zodToOpenApiSchemaInline(schema: unknown): SchemaObject {
  try {
    return jsonSchema(schema as ZodTypeAny) as SchemaObject;
  } catch (error) {
    logger.warn({ error }, "Could not convert a zod schema to JSON Schema");
    return { type: "object", description: "Could not convert this route's schema." };
  }
}

/**
 * Adds the DISCOVERED routes of the mounted kons to the spec.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * Until now only what was declared by hand in `openApi.paths` came out, and no kon
 * declared it: the published contract had zero domain routes. This reads them
 * from the real router (see `kon-routes.ts`), so a new route is documented
 * on its own.
 *
 * Paths are published WITHOUT the `/api` prefix, because the server URL already
 * carries it: just like `/items/...`. With the prefix, a generated client would call
 * `/api/api/esports/...`.
 */
function addDiscoveredRoutes(
  spec: OpenAPIObject,
  kons: KonDefinition[],
  addedTags: Set<string>,
  filter: { includeKons?: string[]; excludeKons: string[] }
): void {
  const konById = new Map(kons.map((k) => [k.id, k]));
  const used = new Set<string>();

  for (const route of konRoutes()) {
    if (filter.includeKons && !filter.includeKons.includes(route.konId)) continue;
    if (filter.excludeKons.includes(route.konId)) continue;
    // A wildcard (`/admin-asset/*`) cannot be expressed as an OpenAPI path.
    if (route.path.includes("*")) continue;

    const method = route.method.toLowerCase();
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;

    // ── Kons SDK operation: the declaration rules (input and
    // output schemas, errors, scope, MCP). Nothing is deduced from middlewares.
    if (route.operation) {
      const { konId, declaration } = route.operation;
      const generated = openApiOperation(
        konId,
        route.mountPath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the declaration travels as unknown through the route metadata
        declaration as KonOperation<any, any, any>
      );
      if (!addedTags.has(konId)) {
        const kon = konById.get(konId);
        spec.tags!.push({ name: konId, description: kon?.description ?? kon?.name ?? konId });
        addedTags.add(konId);
      }
      used.add(String(generated.operation.operationId));
      const item = (spec.paths![generated.path] ??= {}) as PathItemObject & Record<string, unknown>;
      if (!item[generated.method])
        item[generated.method] = generated.operation as unknown as OperationObject;
      continue;
    }

    const path =
      route.path.replace(/^\/api(?=\/|$)/, "").replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}") || "/";

    const tag = route.konId;
    if (!addedTags.has(tag)) {
      const kon = konById.get(route.konId);
      spec.tags!.push({ name: tag, description: kon?.description ?? kon?.name ?? route.konId });
      addedTags.add(tag);
    }

    const base =
      route.operationId ??
      `${route.konId.replace(/^kon-/, "")}_${method}_${
        route.relativePath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "root"
      }`;
    let operationId = base;
    for (let n = 2; used.has(operationId); n++) operationId = `${base}_${n}`;
    used.add(operationId);

    const parameters: ParameterObject[] = [];
    const fromParams = route.validation.find((v) => v.target === "param");
    const propsParams = fromParams
      ? (zodToOpenApiSchemaInline(fromParams.schema).properties ?? {})
      : {};
    for (const [, name] of route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: (propsParams[name] as SchemaObject) ?? { type: "string" },
      });
    }
    const fromQuery = route.validation.find((v) => v.target === "query");
    if (fromQuery) {
      const q = zodToOpenApiSchemaInline(fromQuery.schema);
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        parameters.push({
          name,
          in: "query",
          required: q.required?.includes(name) ?? false,
          schema: schema as SchemaObject,
        });
      }
    }

    const operation: OperationObject = {
      operationId,
      summary: route.summary ?? `${route.method} ${path}`,
      tags: [tag, ...(route.tags ?? [])],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: { "200": { description: "OK" } },
    };

    const notes: string[] = [];
    if (route.description) notes.push(route.description);

    const body = route.validation.find((v) => v.target === "json" || v.target === "form");
    if (body) {
      operation.requestBody = {
        required: true,
        content: {
          [body.target === "form" ? "multipart/form-data" : "application/json"]: {
            schema: zodToOpenApiSchemaInline(body.schema),
          },
        },
      };
      operation.responses["422"] = {
        description:
          "Validation failed or unknown fields. `error.details.unknownKeys` says which " +
          "one is extra and `didYouMean` the correct name.",
      };
      notes.push("Fields that are not in the schema are REJECTED with 422; they are not ignored.");
    }

    if (route.auth === "required") {
      operation.security = [{ bearerAuth: [] }, { cookieAuth: [] }];
      operation.responses["401"] = {
        description:
          "Missing credential: session cookie or `Authorization: Bearer kitsuden_agent_*`.",
      };
    } else if (route.auth === "optional") {
      operation.security = [{}, { bearerAuth: [] }, { cookieAuth: [] }];
    } else {
      operation.security = [];
    }

    if (route.section) {
      (operation as unknown as Record<string, unknown>)["x-kitsuden-section"] = route.section;
      operation.responses["409"] = {
        description: `The «${route.section}» section of the kon is off; the response says how to turn it on.`,
      };
      notes.push(`Requires the «${route.section}» section to be on.`);
    }

    if (notes.length > 0) operation.description = notes.join("\n\n");

    const item = (spec.paths![path] ??= {}) as PathItemObject & Record<string, unknown>;
    if (!item[method]) item[method] = operation;
  }
}

/**
 * Convert a kon path definition to OpenAPI PathItemObject
 */
function convertPathToOpenApi(
  kon: KonDefinition,
  pathDef: KonOpenApiPath
): { method: OpenApiMethod; pathItem: OperationObject } {
  const method = pathDef.method.toLowerCase() as OpenApiMethod;
  const konPrefix = kon.id.replace(/^kon-/, "");

  // Generate operationId if not provided
  const operationId =
    pathDef.operationId || `${konPrefix}_${method}_${pathDef.path.replace(/[^a-zA-Z0-9]/g, "_")}`;

  // Build parameters
  const parameters: ParameterObject[] = [];

  // Path parameters
  if (pathDef.params) {
    const paramSchema = zodToOpenApiSchema(pathDef.params, "Params");
    if (paramSchema.properties) {
      Object.entries(paramSchema.properties).forEach(([name, schema]) => {
        parameters.push({
          name,
          in: "path",
          required: paramSchema.required?.includes(name) ?? false,
          schema: schema as SchemaObject,
        });
      });
    }
  }

  // Query parameters
  if (pathDef.query) {
    const querySchema = zodToOpenApiSchema(pathDef.query, "Query");
    if (querySchema.properties) {
      Object.entries(querySchema.properties).forEach(([name, schema]) => {
        parameters.push({
          name,
          in: "query",
          required: querySchema.required?.includes(name) ?? false,
          schema: schema as SchemaObject,
          description: (schema as any).description,
        });
      });
    }
  }

  // Build request body
  let requestBody: OperationObject["requestBody"] = undefined;
  if (pathDef.body) {
    requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: zodToOpenApiSchema(pathDef.body, "RequestBody"),
        },
      },
    };
  }

  // Build responses
  const responses: OperationObject["responses"] = {};
  for (const [statusCode, responseDef] of Object.entries(pathDef.responses)) {
    responses[statusCode] = {
      description: responseDef.description,
      content: {
        "application/json": {
          schema: zodToOpenApiSchema(responseDef.schema, `Response${statusCode}`),
        },
      },
    };
  }

  // Build operation
  const operation: OperationObject = {
    operationId,
    summary: pathDef.summary,
    description: pathDef.description,
    tags: pathDef.tags || [kon.name],
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody,
    responses,
    security: pathDef.requireAuth !== false ? [{ bearerAuth: [] }, { cookieAuth: [] }] : undefined,
  };

  // Clean undefined values
  Object.keys(operation).forEach((key) => {
    if (operation[key as keyof OperationObject] === undefined) {
      delete operation[key as keyof OperationObject];
    }
  });

  return { method, pathItem: operation };
}

/**
 * Convert kon path to full API path
 */
function getFullPath(kon: KonDefinition, path: string): string {
  const mountPath = kon.mountPath || `/api/${kon.id.replace(/^kon-/, "")}`;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  // Replace :param with {param} for OpenAPI
  const openApiPath = cleanPath.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "{$1}");
  return `${mountPath}${openApiPath}`;
}

/**
 * Generate complete OpenAPI specification from kons
 */
export async function generateOpenAPISpec(
  kons: KonDefinition[],
  options: OpenApiAggregatorOptions = {}
): Promise<OpenAPIObject> {
  const {
    title = DEFAULT_INFO.title,
    version = KITSUDEN_VERSION,
    description = DEFAULT_INFO.description,
    servers = [
      { url: "http://localhost:3001/api", description: "Local development" },
      {
        url: "{protocol}://{host}/api",
        description: "Production",
        variables: {
          protocol: { default: "https", enum: ["https", "http"] },
          host: { default: "localhost:3000" },
        },
      },
    ],
    includeKons,
    excludeKons = [],
    user = null,
  } = options;

  // Filter kons
  const filteredKons = kons.filter((g) => {
    if (includeKons && !includeKons.includes(g.id)) return false;
    if (excludeKons.includes(g.id)) return false;
    return g.openApi !== undefined;
  });

  logger.info(
    {
      totalKons: kons.length,
      includedKons: filteredKons.length,
    },
    "Generating OpenAPI spec"
  );

  // Initialize spec
  const spec: OpenAPIObject = {
    // 3.1: the schemas are real JSON Schema (those of the kons SDK come
    // out of zod as they are). It is validated by apps/api/scripts/operations-coverage.ts
    // with a real validator.
    openapi: "3.1.0",
    info: {
      title,
      version,
      description,
      contact: {
        name: "Kitsuden",
        url: "https://github.com/Kitsuden/kitsuden",
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers,
    paths: {},
    components: {
      // `Problem`: the error body (RFC 9457) that the error responses
      // of the SDK operations point to.
      schemas: { ...(commonComponents().schemas as Record<string, SchemaObject>) },
      securitySchemes: structuredClone(SECURITY_SCHEMES) as unknown as NonNullable<
        NonNullable<OpenAPIObject["components"]>["securitySchemes"]
      >,
    },
    tags: [],
  };

  const addedTags = new Set<string>();

  // ═══════════════════════════════════════════════════════════════════════════
  // DYNAMIC DATASET SCHEMAS — Auto-discover from data_sets table
  // ═══════════════════════════════════════════════════════════════════════════
  let datasets: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    /** List of fields or `{fields}` object: read with `schemaFields`. */
    schema: unknown;
  }> = [];

  try {
    // No cache on purpose: the document depends on who asks for it.
    const all = await db
      .select({
        id: dataSets.id,
        name: dataSets.name,
        slug: dataSets.slug,
        description: dataSets.description,
        schema: dataSets.schema,
        policyJson: dataSets.policyJson,
      })
      .from(dataSets);
    datasets = all.filter((ds) => datasetVisibleInDocs(ds, user));
  } catch (err) {
    logger.warn({ err }, "Could not fetch datasets for OpenAPI spec");
  }

  if (datasets.length > 0) {
    spec.tags!.push({
      name: "Datasets",
      description: `Auto-generated endpoints for ${datasets.length} dataset(s)`,
    });
    addedTags.add("Datasets");
  }

  for (const ds of datasets) {
    const schemaName = `Dataset_${ds.slug}`;
    const properties: Record<string, SchemaObject> = {};
    const required: string[] = ["id"];

    // ID is always present
    properties.id = { type: "string", format: "uuid", readOnly: true };

    // Build properties from dataset schema
    // `data_sets.schema` has two shapes (list of fields or `{fields}` object)
    // and may come empty as `{}`. Iterating it as is took down the whole
    // document with a 500 «{} is not iterable». `schemaFields` normalizes both.
    for (const field of schemaFields(ds.schema)) {
      const name = field.fieldName ?? field.name;
      const type = field.fieldType ?? field.type;
      if (typeof name !== "string" || typeof type !== "string") continue;
      const prop = datasetFieldTypeToJsonSchema(
        type,
        typeof field.options === "string" ? field.options : undefined
      );
      if (prop) {
        properties[name] = prop;
        if (field.required) required.push(name);
      }
    }

    // Timestamps
    properties.createdAt = { type: "string", format: "date-time", readOnly: true };
    properties.updatedAt = { type: "string", format: "date-time", readOnly: true };

    spec.components!.schemas![schemaName] = {
      type: "object",
      description: ds.description || `${ds.name} dataset schema`,
      properties,
      required,
    } as SchemaObject;

    // Per-dataset paths
    const dsTag = "Datasets";
    const dsPath = `/items/${ds.slug}`;
    const dsItemPath = `/items/${ds.slug}/{id}`;

    spec.paths![dsPath] = {
      get: {
        operationId: `dataset_${ds.slug}_list`,
        summary: `List ${ds.name}`,
        description: `Paginated list of items in the "${ds.name}" dataset.`,
        tags: [dsTag],
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          { name: "sort", in: "query", schema: { type: "string" } },
          { name: "where", in: "query", schema: { type: "string" }, description: "JSON filter" },
        ],
        responses: {
          "200": {
            description: `Paginated list of ${ds.name}`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    docs: { type: "array", items: { $ref: `#/components/schemas/${schemaName}` } },
                    totalDocs: { type: "integer" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: `dataset_${ds.slug}_create`,
        summary: `Create ${ds.name}`,
        tags: [dsTag],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        },
        responses: {
          "201": { description: `${ds.name} created` },
        },
      },
    };

    spec.paths![dsItemPath] = {
      get: {
        operationId: `dataset_${ds.slug}_get`,
        summary: `Get a ${ds.name}`,
        tags: [dsTag],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: `${ds.name} item`,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${schemaName}` },
              },
            },
          },
          "404": { description: "Not found" },
        },
      },
      patch: {
        operationId: `dataset_${ds.slug}_update`,
        summary: `Update a ${ds.name}`,
        tags: [dsTag],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        },
        responses: {
          "200": { description: `${ds.name} updated` },
          "404": { description: "Not found" },
        },
      },
      delete: {
        operationId: `dataset_${ds.slug}_delete`,
        summary: `Delete a ${ds.name}`,
        tags: [dsTag],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: `${ds.name} deleted` },
          "404": { description: "Not found" },
        },
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED ITEMS API — Static paths for /api/items/{collection}
  // ═══════════════════════════════════════════════════════════════════════════
  spec.tags!.push({
    name: "Unified Items",
    description: "Standard REST interface for any collection (datasets or kon tables)",
  });
  addedTags.add("Unified Items");

  const itemsTag = "Unified Items";

  spec.paths!["/items/{collection}"] = {
    get: {
      operationId: "items_list",
      summary: "List items in a collection",
      description: "Works for both datasets (JSONB) and native kon tables.",
      tags: [itemsTag],
      parameters: [
        {
          name: "collection",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Dataset slug or table name",
        },
        { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
        { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        {
          name: "sort",
          in: "query",
          schema: { type: "string" },
          description: "e.g. -createdAt or name",
        },
        {
          name: "where",
          in: "query",
          schema: { type: "string" },
          description: "JSON filter object",
        },
      ],
      responses: {
        "200": { description: "Paginated list of items" },
        "404": { description: "Collection not found" },
      },
    },
    post: {
      operationId: "items_create",
      summary: "Create an item in a collection",
      tags: [itemsTag],
      parameters: [{ name: "collection", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: {
        "201": { description: "Item created" },
        "404": { description: "Collection not found" },
      },
    },
  };

  spec.paths!["/items/{collection}/{id}"] = {
    get: {
      operationId: "items_get",
      summary: "Get a single item",
      tags: [itemsTag],
      parameters: [
        { name: "collection", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "Item found" },
        "404": { description: "Item not found" },
      },
    },
    patch: {
      operationId: "items_update",
      summary: "Update an item",
      tags: [itemsTag],
      parameters: [
        { name: "collection", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
      responses: {
        "200": { description: "Item updated" },
        "404": { description: "Item not found" },
      },
    },
    delete: {
      operationId: "items_delete",
      summary: "Delete an item",
      tags: [itemsTag],
      parameters: [
        { name: "collection", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "Item deleted" },
        "404": { description: "Item not found" },
      },
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Process each kon
  // ═══════════════════════════════════════════════════════════════════════════
  // The routes that kons have MOUNTED, whether declared or not.
  addDiscoveredRoutes(spec, kons, addedTags, { includeKons, excludeKons });

  // The SDK operations mounted by the core (agent permissions,
  // human approval, proposal status): they do not belong to a mounted kon.
  for (const {
    konId,
    mountPath,
    description: description,
    operations: operations,
  } of coreOperations()) {
    if (includeKons && !includeKons.includes(konId)) continue;
    if (excludeKons.includes(konId)) continue;
    if (!addedTags.has(konId)) {
      spec.tags!.push({ name: konId, description });
      addedTags.add(konId);
    }
    for (const op of operations) {
      const g = openApiOperation(konId, mountPath, op);
      const item = (spec.paths![g.path] ??= {}) as PathItemObject & Record<string, unknown>;
      if (!item[g.method]) item[g.method] = g.operation as unknown as OperationObject;
    }
  }

  for (const kon of filteredKons) {
    if (!kon.openApi) continue;

    const konPrefix = kon.id.replace(/^kon-/, "");

    // Add tags
    if (kon.openApi.tags) {
      for (const tag of kon.openApi.tags) {
        if (!addedTags.has(tag.name)) {
          spec.tags!.push(tag);
          addedTags.add(tag.name);
        }
      }
    }

    // Add default tag for kon
    if (!addedTags.has(kon.name)) {
      spec.tags!.push({
        name: kon.name,
        description: kon.description || `${kon.name} endpoints`,
      });
      addedTags.add(kon.name);
    }

    // Register schemas (with kon prefix to avoid conflicts)
    if (kon.openApi.schemas) {
      for (const [schemaName, zodSchema] of Object.entries(kon.openApi.schemas)) {
        const prefixedName = `${konPrefix}_${schemaName}`;
        spec.components!.schemas![prefixedName] = zodToOpenApiSchema(zodSchema, prefixedName);
      }
    }

    // Register paths
    for (const pathDef of kon.openApi.paths) {
      const fullPath = getFullPath(kon, pathDef.path);
      const { method, pathItem } = convertPathToOpenApi(kon, pathDef);

      if (!spec.paths![fullPath]) {
        spec.paths![fullPath] = {};
      }

      (spec.paths![fullPath] as PathItemObject)[method] = pathItem;
    }

    // Register webhooks
    if ((kon.openApi as any).webhooks) {
      if (!(spec as any).webhooks) {
        (spec as any).webhooks = {};
      }

      for (const [webhookName, webhookDef] of Object.entries((kon.openApi as any).webhooks)) {
        const prefixedName = `${konPrefix}_${webhookName}`;
        (spec as any).webhooks[prefixedName] = {
          post: {
            summary: (webhookDef as any).post.summary,
            description: (webhookDef as any).post.description,
            requestBody: {
              content: {
                "application/json": {
                  schema: zodToOpenApiSchema(
                    (webhookDef as any).post.requestBody.content["application/json"].schema,
                    `${prefixedName}_Payload`
                  ),
                },
              },
            },
          },
        };
      }
    }
  }

  return spec;
}

/**
 * Generate OpenAPI spec for a single kon
 */
export async function generateKonSpec(
  kon: KonDefinition,
  /** Who asks: see `OpenApiAggregatorOptions.user`. */
  user: RLSUser | null = null
): Promise<OpenAPIObject | null> {
  // Before it returned `null` for every kon without a manual declaration, which was all of them.
  const hasRoutes = konRoutes().some((r) => r.konId === kon.id);
  if (!kon.openApi && !hasRoutes) {
    return null;
  }

  return generateOpenAPISpec([kon], {
    includeKons: [kon.id],
    title: `${kon.name} API`,
    description: kon.description || `${kon.name} endpoints`,
    user,
  });
}

/**
 * Get operation ID for a specific endpoint
 */
export function getOperationId(
  kon: KonDefinition,
  method: string,
  path: string
): string | undefined {
  if (!kon.openApi) return undefined;

  const pathDef = kon.openApi.paths.find(
    (p) => p.method === method.toLowerCase() && p.path === path
  );

  if (!pathDef) return undefined;

  const konPrefix = kon.id.replace(/^kon-/, "");
  return (
    pathDef.operationId ||
    `${konPrefix}_${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`
  );
}

/**
 * List all available operations across kons
 */
export function listOperations(kons: KonDefinition[]): Array<{
  konId: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
}> {
  const operations: Array<{
    konId: string;
    operationId: string;
    method: string;
    path: string;
    summary: string;
    tags: string[];
  }> = [];

  for (const kon of kons) {
    if (!kon.openApi) continue;

    const konPrefix = kon.id.replace(/^kon-/, "");

    for (const path of kon.openApi.paths) {
      operations.push({
        konId: kon.id,
        operationId:
          path.operationId ||
          `${konPrefix}_${path.method}_${path.path.replace(/[^a-zA-Z0-9]/g, "_")}`,
        method: path.method.toUpperCase(),
        path: getFullPath(kon, path.path),
        summary: path.summary,
        tags: path.tags || [kon.name],
      });
    }
  }

  return operations;
}

/**
 * Convert a dataset field type to JSON Schema property
 */
function datasetFieldTypeToJsonSchema(
  fieldType: string,
  options?: string
): SchemaObject | undefined {
  switch (fieldType) {
    case "text":
    case "email":
    case "url":
    case "richtext":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "select":
      if (options) {
        return { type: "string", enum: options.split(",").map((o) => o.trim()) };
      }
      return { type: "string" };
    case "json":
      return { type: "object" };
    case "image":
      return { type: "string", format: "uri", description: "Image URL" };
    case "relation":
      return { type: "string", format: "uuid", description: "Related item ID" };
    case "kpi":
      return { type: "number", description: "KPI value" };
    default:
      return { type: "string" };
  }
}

export default {
  generateOpenAPISpec,
  generateKonSpec,
  getOperationId,
  listOperations,
};
