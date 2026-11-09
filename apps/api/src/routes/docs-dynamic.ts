/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DYNAMIC DOCS ROUTER - Auto-generated API Documentation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides endpoints for:
 * - /api/docs/openapi.json - Full OpenAPI spec from all kons
 * - /api/docs/:kon/openapi.json - Spec for specific kon
 * - /api/docs/ - Swagger UI
 * - /api/docs/modern - Scalar UI
 * - /api/docs/operations - List all available operations
 * - /api/docs/sdk - SDK download links
 */

import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";

import { logger } from "../lib/logger";
import { getLoadedKons } from "../lib/module-loader";
import { generateOpenAPISpec, generateKonSpec, listOperations } from "../lib/openapi-aggregator";
import type { RLSUser } from "../lib/rls-builder";
import type { AppVariables } from "../types/hono";

export const dynamicDocsRouter = new Hono<{ Variables: AppVariables }>();

/** The identity the global middleware left (session or agent key), or `null`. */
const userOf = (c: { get: unknown }) =>
  ((c.get as (k: string) => unknown).call(c, "user") ?? null) as RLSUser | null;

// ═══════════════════════════════════════════════════════════════════════════════
// SCALAR UI (Modern)
// ═══════════════════════════════════════════════════════════════════════════════

const scalarHtml = `
<!DOCTYPE html>
<html>
  <head>
    <title>Kitsuden API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <style>
      body { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <script
      id="api-reference"
      type="application/json"
      data-url="/api/docs/openapi.json"
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest"></script>
  </body>
</html>
`;

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/docs/openapi.json
 *
 * Returns the complete OpenAPI specification from all active kons.
 * This spec is auto-generated from kon definitions.
 */
dynamicDocsRouter.get("/openapi.json", async (c) => {
  try {
    const kons = await getLoadedKons();
    const spec = await generateOpenAPISpec(kons, {
      // Only the datasets the caller can read (anonymous: the public ones).
      user: userOf(c),
      servers: [
        {
          url: `${new URL(c.req.url).origin}/api`,
          description: "Current server",
        },
        {
          url: "http://localhost:3001/api",
          description: "Local development",
        },
      ],
    });

    return c.json(spec);
  } catch (error) {
    logger.error({ error }, "Failed to generate OpenAPI spec");
    return c.json(
      {
        error: "Failed to generate OpenAPI spec",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /api/docs/:kon/openapi.json
 *
 * Returns OpenAPI specification for a specific kon.
 */
dynamicDocsRouter.get("/:kon/openapi.json", async (c) => {
  try {
    const konId = c.req.param("kon");
    const kons = await getLoadedKons();
    const kon = kons.find((g) => g.id === konId || g.id === `kon-${konId}`);

    if (!kon) {
      return c.json(
        {
          error: "Kon not found",
          available: kons.map((g) => ({ id: g.id, name: g.name })),
        },
        404
      );
    }

    const spec = await generateKonSpec(kon, userOf(c));

    if (!spec) {
      return c.json(
        {
          error: "Kon does not expose OpenAPI spec",
          kon: kon.name,
        },
        404
      );
    }

    // Add server URL
    spec.servers = [
      {
        url: `${new URL(c.req.url).origin}/api`,
        description: "Current server",
      },
    ];

    return c.json(spec);
  } catch (error) {
    logger.error({ error }, "Failed to generate kon spec");
    return c.json(
      {
        error: "Failed to generate kon spec",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /api/docs/operations
 *
 * List all available operations across all kons.
 * Useful for code generation and discovery.
 */
dynamicDocsRouter.get("/operations", async (c) => {
  try {
    const kons = await getLoadedKons();
    const operations = listOperations(kons);

    const query = c.req.query();
    let filtered = operations;

    // Filter by kon
    if (query.kon) {
      filtered = filtered.filter((op) => op.konId === query.kon || op.konId === `kon-${query.kon}`);
    }

    // Filter by tag
    if (query.tag) {
      filtered = filtered.filter((op) =>
        op.tags.some((t) => t.toLowerCase() === query.tag!.toLowerCase())
      );
    }

    // Filter by method
    if (query.method) {
      filtered = filtered.filter((op) => op.method.toLowerCase() === query.method!.toLowerCase());
    }

    // Search
    if (query.search) {
      const search = query.search.toLowerCase();
      filtered = filtered.filter(
        (op) =>
          op.operationId.toLowerCase().includes(search) ||
          op.summary.toLowerCase().includes(search) ||
          op.path.toLowerCase().includes(search)
      );
    }

    return c.json({
      total: operations.length,
      filtered: filtered.length,
      operations: filtered,
    });
  } catch (error) {
    logger.error({ error }, "Failed to list operations");
    return c.json(
      {
        error: "Failed to list operations",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /api/docs/
 *
 * Swagger UI - Classic API documentation.
 */
dynamicDocsRouter.get(
  "/",
  swaggerUI({
    url: "/api/docs/openapi.json",
    title: "Kitsuden API Documentation",
  })
);

/**
 * GET /api/docs/modern
 *
 * Scalar API Reference - Modern, beautiful documentation.
 */
dynamicDocsRouter.get("/modern", (c) => {
  return c.html(scalarHtml);
});

/**
 * GET /api/docs/kons
 *
 * List all kons with their OpenAPI status.
 */
dynamicDocsRouter.get("/kons", async (c) => {
  try {
    const kons = await getLoadedKons();

    const konList = kons.map((g) => ({
      id: g.id,
      name: g.name,
      version: g.version,
      description: g.description,
      hasOpenApi: !!g.openApi,
      endpointCount: g.openApi?.paths.length || 0,
      schemaCount: Object.keys(g.openApi?.schemas || {}).length,
      tags: g.openApi?.tags?.map((t) => t.name) || [g.name],
      docsUrl: `/api/docs/${g.id.replace(/^kon-/, "")}/openapi.json`,
    }));

    return c.json({
      total: kons.length,
      withOpenApi: kons.filter((g) => !!g.openApi).length,
      kons: konList,
    });
  } catch (error) {
    logger.error({ error }, "Failed to list kons");
    return c.json(
      {
        error: "Failed to list kons",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /api/docs/sdk
 *
 * SDK download links and generation info.
 */
dynamicDocsRouter.get("/sdk", async (c) => {
  const baseUrl = new URL(c.req.url).origin;

  return c.json({
    sdks: [
      {
        name: "TypeScript/JavaScript",
        package: "@kitsuden/sdk",
        install: "npm install @kitsuden/sdk",
        generator: "openapi-generator-cli -g typescript-fetch",
        downloadUrl: `${baseUrl}/api/docs/sdk/typescript.zip`,
      },
      {
        name: "Python",
        package: "kitsuden",
        install: "pip install kitsuden",
        generator: "openapi-generator-cli -g python",
        downloadUrl: `${baseUrl}/api/docs/sdk/python.zip`,
      },
    ],
    generateCommand: "kitsuden generate-sdk --lang <language> --output ./sdk",
    openapiUrl: `${baseUrl}/api/docs/openapi.json`,
    codegen: {
      description: "Generate strongly-typed frontend code per collection",
      endpoint: `${baseUrl}/api/generate-code`,
      package: "@kitsuden/codegen",
      frameworks: ["react", "vue", "svelte"],
      types: ["hook", "component", "form", "types", "all"],
      examples: {
        react: `POST ${baseUrl}/api/generate-code { "collection": "posts", "framework": "react", "type": "all" }`,
        vue: `POST ${baseUrl}/api/generate-code { "collection": "posts", "framework": "vue", "type": "hook" }`,
        svelte: `POST ${baseUrl}/api/generate-code { "collection": "posts", "framework": "svelte", "type": "component" }`,
      },
    },
  });
});

/**
 * GET /api/docs/postman.json
 *
 * Export a Postman collection.
 */
dynamicDocsRouter.get("/postman.json", async (c) => {
  try {
    const kons = await getLoadedKons();
    const operations = listOperations(kons);

    const collection = {
      info: {
        name: "Kitsuden API",
        description: "Auto-generated Postman collection from kons",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/",
        version: "0.8.0-beta",
      },
      item: operations.map((op) => ({
        name: op.summary,
        request: {
          method: op.method,
          header: [
            {
              key: "Authorization",
              value: "Bearer {{apiKey}}",
              type: "text",
            },
            {
              key: "Content-Type",
              value: "application/json",
              type: "text",
            },
          ],
          url: {
            raw: `{{baseUrl}}${op.path}`,
            host: ["{{baseUrl}}"],
            path: op.path.split("/").filter(Boolean),
          },
          description: `${op.operationId}\n\nTags: ${op.tags.join(", ")}`,
        },
      })),
      variable: [
        {
          key: "baseUrl",
          value: "http://localhost:3001/api",
          type: "string",
        },
        {
          key: "apiKey",
          value: "your_api_key_here",
          type: "string",
        },
      ],
    };

    return c.json(collection);
  } catch (error) {
    logger.error({ error }, "Failed to generate Postman collection");
    return c.json(
      {
        error: "Failed to generate Postman collection",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default dynamicDocsRouter;
