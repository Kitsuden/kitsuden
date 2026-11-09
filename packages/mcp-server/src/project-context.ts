/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROJECT CONTEXT RESOURCE - Full Project State for AI Agents
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides AI agents with complete project understanding including:
 * - Active kons and their capabilities
 * - Available endpoints and schemas
 * - Data relationships
 * - Event system
 * - Configuration
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpServerDependencies } from "./index";

export function registerProjectContext(server: McpServer, deps: McpServerDependencies) {
  const { db, schema, konRegistry } = deps;

  // ═══════════════════════════════════════════════════════════════════════════════
  // FULL PROJECT CONTEXT
  // ═══════════════════════════════════════════════════════════════════════════════

  server.registerResource(
    "project-context",
    "kitsuden://project-context",
    {
      title: "Kitsuden Project Context",
      description: "Complete project structure and capabilities for AI understanding",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        // Get all datasets
        const datasets = await db.select().from(schema.dataSets);

        // Get active kons
        const kons = Object.values(konRegistry || {}).map((g: any) => ({
          id: g.id,
          name: g.name,
          version: g.version,
          description: g.description,
          mountPath: g.mountPath || `/api/${g.id.replace(/^kon-/, "")}`,
          hasOpenApi: !!g.openApi,
          endpointCount: g.openApi?.paths?.length || 0,
          tables: g.tables || [],
          dependencies: g.dependencies || {},
        }));

        // Build project context
        const context = {
          meta: {
            generatedAt: new Date().toISOString(),
            version: "0.8.0-beta",
            environment: process.env.NODE_ENV || "development",
          },

          architecture: {
            type: "Kitsuden",
            engine: "@kitsuden/engine",
            pattern: "Modular Kon System",
            layers: [
              { name: "Engine", level: 1, description: "Auth, DB, Cache, Queue - always active" },
              { name: "Core", level: 2, description: "Datasets, Media, Webhooks - toggleable" },
              { name: "Kons", level: 3, description: "Business modules - dynamically loaded" },
            ],
          },

          kons: {
            total: kons.length,
            active: kons.map((g) => ({
              id: g.id,
              name: g.name,
              version: g.version,
              mountPath: g.mountPath,
              endpoints: g.endpointCount,
              tables: g.tables,
            })),
          },

          data: {
            datasets: {
              total: datasets.length,
              items: datasets.map((ds: any) => ({
                id: ds.id,
                name: ds.name,
                slug: ds.slug,
                fieldCount: ds.schema?.fields?.length || 0,
                hasRelations: !!ds.schema?.relations && Object.keys(ds.schema.relations).length > 0,
              })),
            },
          },

          api: {
            baseUrl: "/api",
            documentation: {
              swagger: "/api/docs/",
              scalar: "/api/docs/modern",
              openapi: "/api/docs/openapi.json",
              operations: "/api/docs/operations",
            },
            authentication: {
              methods: ["bearer", "cookie", "api-key"],
              header: "Authorization: Bearer <token>",
            },
          },

          conventions: {
            naming: {
              kons: "kon-{name}",
              tables: "snake_case",
              fields: "camelCase",
              apiEndpoints: "kebab-case",
            },
            patterns: {
              router: "Use ctx.db.instance for database access",
              auth: "Use ctx.auth.requireAuth for protected routes",
              cache: "Use ctx.cache for expensive operations",
              events: "Use ctx.events.emit for async processing",
            },
          },

          codeGeneration: {
            konTemplate: `
import { Hono } from "hono";
import { defineKon } from "@kitsuden/shared";

export const kon = defineKon({
  id: "kon-{name}",
  name: "{Name}",
  version: "1.0.0",
  openApi: {
    tags: [{ name: "{Name}", description: "..." }],
    paths: []
  },
  createRouter: (ctx) => {
    const router = new Hono();
    // Routes here
    return router;
  }
});
            `.trim(),
          },
        };

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(context),
            },
          ],
        };
      } catch (error: any) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(
                {
                  error: "Failed to load project context",
                  message: error.message,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // DATASET SCHEMA RESOURCE
  // ═══════════════════════════════════════════════════════════════════════════════

  server.registerResource(
    "dataset-schema",
    new ResourceTemplate("kitsuden://dataset/{id}/schema", {
      list: async () => {
        const datasets = await db.select().from(schema.dataSets);
        return {
          resources: datasets.map((ds: any) => ({
            uri: `kitsuden://dataset/${ds.id}/schema`,
            name: `Schema: ${ds.name}`,
          })),
        };
      },
    }),
    {
      title: "Dataset Schema",
      description: "Detailed schema for a specific dataset",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      try {
        const [dataset] = await db
          .select()
          .from(schema.dataSets)
          .where(eq(schema.dataSets.id, id))
          .limit(1);

        if (!dataset) {
          throw new Error(`Dataset not found: ${id}`);
        }

        const schemaInfo = {
          dataset: {
            id: dataset.id,
            name: dataset.name,
            slug: dataset.slug,
            description: dataset.description,
          },
          schema: dataset.schema,
          fields: dataset.schema?.fields?.map((f: any) => ({
            key: f.key,
            type: f.type,
            label: f.label,
            required: f.isRequired,
            unique: f.isUnique,
            default: f.defaultValue,
            helpText: f.helpText,
          })),
          relations: dataset.schema?.relations || {},
          policies: dataset.schema?.policies || {},
          queryExamples: [
            `GET /api/datasets/${dataset.slug}/entries`,
            `GET /api/datasets/${dataset.slug}/entries?limit=10`,
            `POST /api/datasets/${dataset.slug}/entries`,
          ],
        };

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(schemaInfo),
            },
          ],
        };
      } catch (error: any) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: error.message }),
            },
          ],
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // KON CAPABILITIES RESOURCE
  // ═══════════════════════════════════════════════════════════════════════════════

  server.registerResource(
    "kon-capabilities",
    new ResourceTemplate("kitsuden://kon/{id}/capabilities", {
      list: async () => {
        const kons = Object.values(konRegistry || {}).map((g: any) => ({
          uri: `kitsuden://kon/${g.id}/capabilities`,
          name: g.name,
        }));
        return { resources: kons };
      },
    }),
    {
      title: "Kon Capabilities",
      description: "Available endpoints and operations for a kon",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      try {
        const kon = Object.values(konRegistry || {}).find(
          (g: any) => g.id === id || g.id === `kon-${id}`
        ) as any;

        if (!kon) {
          throw new Error(`Kon not found: ${id}`);
        }

        const capabilities = {
          kon: {
            id: kon.id,
            name: kon.name,
            version: kon.version,
            description: kon.description,
            mountPath: kon.mountPath || `/api/${kon.id.replace(/^kon-/, "")}`,
          },
          endpoints:
            kon.openApi?.paths?.map((p: any) => ({
              method: p.method.toUpperCase(),
              path: p.path,
              summary: p.summary,
              tags: p.tags,
              requireAuth: p.requireAuth !== false,
            })) || [],
          schemas: Object.keys(kon.openApi?.schemas || {}),
          tables: kon.tables || [],
          hooks: Object.keys(kon.hooks || {}),
          admin: kon.admin || null,
        };

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(capabilities),
            },
          ],
        };
      } catch (error: any) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: error.message }),
            },
          ],
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // API OPERATIONS RESOURCE
  // ═══════════════════════════════════════════════════════════════════════════════

  server.registerResource(
    "api-operations",
    "kitsuden://api-operations",
    {
      title: "All API Operations",
      description: "Complete list of available API operations across all kons",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const operations: any[] = [];

        for (const kon of Object.values(konRegistry || {}) as any[]) {
          if (!kon.openApi?.paths) continue;

          const mountPath = kon.mountPath || `/api/${kon.id.replace(/^kon-/, "")}`;

          for (const path of kon.openApi.paths) {
            operations.push({
              operationId:
                path.operationId || `${kon.id}_${path.method}_${path.path.replace(/\//g, "_")}`,
              kon: kon.id,
              konName: kon.name,
              method: path.method.toUpperCase(),
              path: `${mountPath}${path.path}`,
              fullPath: `/api${mountPath}${path.path}`,
              summary: path.summary,
              description: path.description,
              tags: path.tags || [kon.name],
              requireAuth: path.requireAuth !== false,
            });
          }
        }

        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify(
                {
                  totalOperations: operations.length,
                  operations: operations.sort(
                    (a, b) => a.kon.localeCompare(b.kon) || a.path.localeCompare(b.path)
                  ),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({ error: error.message }),
            },
          ],
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEVELOPMENT GUIDE RESOURCE
  // ═══════════════════════════════════════════════════════════════════════════════

  server.registerResource(
    "development-guide",
    "kitsuden://dev-guide",
    {
      title: "Development Guide",
      description: "Guide for AI agents working with Kitsuden",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const guide = `# Kitsuden Development Guide for AI Agents

## Quick Start

### 1. Explore the Project
\`\`\`
Resource: kitsuden://project-context
Resource: kitsuden://api-operations
\`\`\`

### 2. Check Available Datasets
\`\`\`
Tool: kitsuden_list_datasets
Resource: kitsuden://dataset/{id}/schema
\`\`\`

### 3. Query Data
\`\`\`
Tool: kitsuden_intelligent_query
  dataset: "games"
  query: "games released in 2024 with rating above 8"
\`\`\`

## Creating a Kon

### Option 1: Generate Template
\`\`\`
Tool: kitsuden_generate_kon
  name: "inventory-management"
  features: ["crud", "relations", "webhooks"]
  dataModel: "Products with categories, suppliers, and stock tracking"
\`\`\`

### Option 2: Manual Creation
Create files in \`packages/kons/kon-{name}/\`:

1. **index.ts** - Main kon definition
2. **schema.ts** - Database schema
3. **kon.json** - Metadata
4. **package.json** - Dependencies

### Kon Structure
\`\`\`typescript
import { Hono } from "hono";
import { defineKon } from "@kitsuden/shared";

export const kon = defineKon({
  id: "kon-my-feature",
  name: "My Feature",
  version: "1.0.0",
  
  // OpenAPI documentation
  openApi: {
    tags: [{ name: "My Feature", description: "..." }],
    schemas: { /* Zod schemas */ },
    paths: [ /* Endpoint definitions */ ]
  },
  
  createRouter: (ctx) => {
    const router = new Hono();
    
    // Use injected context
    router.get("/", async (c) => {
      const data = await ctx.db.instance.select().from(myTable);
      return c.json({ data });
    });
    
    return router;
  }
});
\`\`\`

## Best Practices

1. **Always use context injection** - Never import from apps/api/
2. **Define OpenAPI specs** - For auto-generated documentation
3. **Add authentication** - Use ctx.auth.requireAuth for protected routes
4. **Handle errors** - Return proper HTTP status codes
5. **Use transactions** - For multi-step operations

## Common Patterns

### Database Query
\`\`\`typescript
const results = await ctx.db.instance
  .select()
  .from(myTable)
  .where(eq(myTable.status, "active"))
  .limit(50);
\`\`\`

### With Caching
\`\`\`typescript
const cacheKey = \`myfeature:list:\${userId}\`;
let data = await ctx.cache.get(cacheKey);

if (!data) {
  data = await fetchFromDb();
  await ctx.cache.set(cacheKey, data, 300); // 5 minutes
}
\`\`\`

### Emit Events
\`\`\`typescript
ctx.events.emit("myfeature:created", { id: newItem.id });
\`\`\`
`;

      return {
        contents: [
          {
            uri: uri.href,
            text: guide,
          },
        ],
      };
    }
  );
}

// Import helpers
import { eq } from "drizzle-orm";

export default { registerProjectContext };
