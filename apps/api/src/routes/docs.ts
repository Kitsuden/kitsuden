/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * API DOCUMENTATION - Swagger UI & Scalar
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides interactive API documentation at /api/docs
 */

import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";

import { SECURITY_SCHEMES } from "../lib/operations-openapi";
import type { AppVariables } from "../types/hono";

export const docsRoutes = new Hono<{ Variables: AppVariables }>();

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAPI SPECIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

const openAPIConfig = {
  openapi: "3.0.0",
  info: {
    title: "Kitsuden API",
    version: "0.5.0",
    description: `🚀 Official Kitsuden API - Headless CMS + BaaS

## Main Features

- **Datasets**: Dynamic CRUD with a flexible schema
- **Query Language**: Advanced searches with filters
- **Real-time**: WebSockets for live updates
- **AI-Native**: MCP Server + Agent capabilities
- **Multi-tenant**: RLS (Row Level Security) by default

## Authentication

Three supported methods:
1. **Session Cookie** (Better-Auth) - For human users
2. **Agent Token** (kitsuden_agent_*) - For AI agents and machine integrations (recommended)
3. **Legacy API Key** (kitsuden_sk_*) - **DEPRECATED**, sunset 2026-08-01. Migrate to kitsuden_agent_*

\`\`\`
Authorization: Bearer your_token_here
\`\`\`

## Rate Limiting

- Default: 300 requests/minute
- Auth endpoints: 5 requests/5 minutes
- MCP endpoints: 200 requests/minute

Included headers:
- \`X-RateLimit-Limit\`
- \`X-RateLimit-Remaining\`
- \`X-RateLimit-Reset\`

## Official SDKs

- JavaScript/TypeScript: \`@kitsuden/sdk\`
- Python: \`kitsuden-python\`
- CLI: \`kitsuden-cli\`

## Links

- [Documentation](https://github.com/Kitsuden/kitsuden/tree/main/docs)
- [GitHub](https://github.com/Kitsuden/kitsuden)
- [Support](https://discord.gg/kitsuden)
`,
    contact: {
      name: "Kitsuden Team",
      url: "https://github.com/Kitsuden/kitsuden",
    },
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  },
  servers: [
    {
      url: "{protocol}://{host}/api",
      description: "Dynamic server",
      variables: {
        protocol: {
          enum: ["http", "https"],
          default: "https",
        },
        host: {
          default: "localhost:3000",
        },
      },
    },
    {
      url: "http://localhost:3001/api",
      description: "Local development",
    },
  ],
  tags: [
    {
      name: "Auth",
      description: "Authentication and authorization",
    },
    {
      name: "Datasets",
      description: "Data collection management",
    },
    {
      name: "Entries",
      description: "CRUD operations on entries",
    },
    {
      name: "Query",
      description: "Advanced searches with Kitsuden QL",
    },
    {
      name: "Batch",
      description: "Transactional batch operations",
    },
    {
      name: "Media",
      description: "File management and optimization",
    },
    {
      name: "Kons",
      description: "Functional modules of the system",
    },
    {
      name: "Agents",
      description: "AI Agents y MCP Server",
    },
    {
      name: "Webhooks",
      description: "HTTP callback events",
    },
    {
      name: "System",
      description: "Health checks and metrics",
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCALAR API REFERENCE (Modern, better UI)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scalar API Reference - modern UI for OpenAPI documentation
 * Nicer and more functional than the traditional Swagger UI
 */
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
// SWAGGER UI (Classic, familiar)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Swagger UI - the classic OpenAPI documentation
 * Familiar to many developers
 */
docsRoutes.get(
  "/",
  swaggerUI({
    url: "/api/docs/openapi.json",
    title: "Kitsuden API Documentation",
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// SCALAR REFERENCE
// ═══════════════════════════════════════════════════════════════════════════════

docsRoutes.get("/modern", (c) => {
  return c.html(scalarHtml);
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAPI JSON SPEC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/docs/openapi.json
 *
 * Returns the full OpenAPI specification.
 * Used by Swagger UI and Scalar.
 */
docsRoutes.get("/openapi.json", async (c) => {
  // In production, this would come from each route's Zod schemas
  // For now we return the base configuration
  const spec = {
    ...openAPIConfig,
    paths: {
      "/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "User login",
          description: "Authenticates a user and returns a session/cookies",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Login successful",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user: { $ref: "#/components/schemas/User" },
                      session: { type: "object" },
                    },
                  },
                },
              },
            },
            "401": { description: "Invalid credentials" },
            "429": { description: "Rate limit exceeded" },
          },
        },
      },

      "/datasets": {
        get: {
          tags: ["Datasets"],
          summary: "List datasets",
          description: "Gets all the datasets accessible to the user",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 50 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", default: 0 },
            },
          ],
          responses: {
            "200": {
              description: "List of datasets",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: { $ref: "#/components/schemas/Dataset" },
                      },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["Datasets"],
          summary: "Create dataset",
          description: "Creates a new dataset with a defined schema",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DatasetInput" },
              },
            },
          },
          responses: {
            "201": { description: "Dataset created" },
            "400": { description: "Invalid schema" },
          },
        },
      },

      "/datasets/{id}/entries": {
        get: {
          tags: ["Entries"],
          summary: "List entries",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "lang",
              in: "query",
              description: "Language for i18n fields",
              schema: { type: "string", default: "en" },
            },
            {
              name: "expand",
              in: "query",
              description: "Relations to expand (comma-separated)",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "List of entries" },
          },
        },
      },

      "/query": {
        post: {
          tags: ["Query"],
          summary: "Kitsuden Query Language",
          description: "Runs complex queries with filters, sorting and pagination",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    dataset: { type: "string" },
                    select: { type: "array", items: { type: "string" } },
                    where: { type: "object" },
                    orderBy: { type: "object" },
                    limit: { type: "integer" },
                    offset: { type: "integer" },
                    expand: { type: "array", items: { type: "string" } },
                  },
                },
                example: {
                  dataset: "products",
                  where: {
                    AND: [{ price: { gte: 10 } }, { category: { in: ["electronics", "gaming"] } }],
                  },
                  orderBy: { createdAt: "desc" },
                  limit: 20,
                  expand: ["category", "tags"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Query results" },
          },
        },
      },

      "/batch": {
        post: {
          tags: ["Batch"],
          summary: "Batch operations",
          description: "Runs multiple operations in an ACID transaction",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["operations"],
                  properties: {
                    transaction: { type: "boolean", default: true },
                    operations: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          op: { enum: ["create", "update", "delete", "upsert"] },
                          dataset: { type: "string" },
                          data: { type: "object" },
                          where: { type: "object" },
                          alias: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Operations completed" },
            "400": { description: "Error in one of the operations (rollback)" },
          },
        },
      },

      "/health": {
        get: {
          tags: ["System"],
          summary: "Health check",
          description: "Checks the state of the system and its dependencies",
          responses: {
            "200": {
              description: "System healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { enum: ["healthy", "degraded"] },
                      uptime: { type: "string" },
                      checks: { type: "object" },
                    },
                  },
                },
              },
            },
            "503": { description: "System degraded" },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string" },
            name: { type: "string" },
            role: { enum: ["admin", "editor", "viewer"] },
          },
        },
        Dataset: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            slug: { type: "string" },
            schema: { type: "object" },
            entriesCount: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        DatasetInput: {
          type: "object",
          required: ["name", "fields"],
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  type: { type: "string" },
                  label: { type: "string" },
                  required: { type: "boolean" },
                },
              },
            },
          },
        },
      },
      securitySchemes: structuredClone(SECURITY_SCHEMES),
    },
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  };

  return c.json(spec);
});

// ═══════════════════════════════════════════════════════════════════════════════
// REDIRECTS
// ═══════════════════════════════════════════════════════════════════════════════

// /api/swagger → /api/docs (for compatibility)
docsRoutes.get("/swagger", (c) => c.redirect("/api/docs"));

// ═══════════════════════════════════════════════════════════════════════════════
// POSTMAN COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/docs/postman.json
 *
 * Exports a Postman collection ready to import.
 */
docsRoutes.get("/postman.json", (c) => {
  const collection = {
    info: {
      name: "Kitsuden API",
      description: "Official Postman collection for Kitsuden",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/",
    },
    item: [
      {
        name: "Auth",
        item: [
          {
            name: "Login",
            request: {
              method: "POST",
              header: [{ key: "Content-Type", value: "application/json" }],
              url: {
                raw: "{{baseUrl}}/auth/login",
                host: ["{{baseUrl}}"],
                path: ["auth", "login"],
              },
              body: {
                mode: "raw",
                raw: JSON.stringify({ email: "user@example.com", password: "password" }, null, 2),
              },
            },
          },
        ],
      },
      {
        name: "Datasets",
        item: [
          {
            name: "List Datasets",
            request: {
              method: "GET",
              url: { raw: "{{baseUrl}}/datasets", host: ["{{baseUrl}}"], path: ["datasets"] },
            },
          },
        ],
      },
    ],
    variable: [{ key: "baseUrl", value: "http://localhost:3001/api" }],
  };

  return c.json(collection);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SDK DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/docs/sdk
 *
 * Links to download the official SDKs.
 */
docsRoutes.get("/sdk", (c) => {
  return c.json({
    sdks: [
      {
        name: "JavaScript / TypeScript",
        package: "@kitsuden/sdk",
        install: "npm install @kitsuden/sdk",
        repo: "https://github.com/Kitsuden/kitsuden/tree/main/packages/sdk",
        docs: "https://github.com/Kitsuden/kitsuden/blob/main/packages/sdk/README.md",
      },
      {
        name: "Python",
        package: "kitsuden",
        install: "pip install kitsuden",
        repo: "https://github.com/Kitsuden/kitsuden/tree/main/packages/sdk-python",
        docs: "https://github.com/Kitsuden/kitsuden/blob/main/packages/sdk-python/README.md",
      },
      {
        name: "CLI",
        package: "@kitsuden/cli",
        install: "pnpm kitsuden (from a checkout)",
        repo: "https://github.com/Kitsuden/kitsuden/tree/main/packages/cli",
        docs: "https://github.com/Kitsuden/kitsuden/blob/main/packages/cli/README.md",
      },
    ],
  });
});
