import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";

import type { McpServerDependencies } from "./index";

export function registerResources(server: McpServer, deps: McpServerDependencies) {
  const { db, schema, konRegistry } = deps;

  // 1. List all datasets
  server.registerResource(
    "datasets",
    "kitsuden://datasets",
    {
      title: "Kitsuden Datasets",
      description: "List of all active dynamic datasets in the CMS",
      mimeType: "application/json",
    },
    async (uri) => {
      const allDatasets = await db.select().from(schema.dataSets);
      const mapped = allDatasets.map((ds: any) => ({
        id: ds.id,
        name: ds.name,
        slug: ds.slug,
        description: ds.description,
        schema: ds.schema,
      }));

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(mapped),
          },
        ],
      };
    }
  );

  // 2. Individual dataset schema via template
  server.registerResource(
    "dataset-schema",
    new ResourceTemplate("kitsuden://dataset/{id}", {
      list: async () => {
        const allDatasets = await db.select().from(schema.dataSets);
        return {
          resources: allDatasets.map((ds: any) => ({
            uri: `kitsuden://dataset/${ds.id}`,
            name: `Dataset Schema: ${ds.name}`,
          })),
        };
      },
    }),
    {
      title: "Individual Dataset Schema",
      description: "Schema definition for a specific dataset",
      mimeType: "application/json",
    },
    async (uri, { id }) => {
      const [dataset] = await db
        .select()
        .from(schema.dataSets)
        .where(eq(schema.dataSets.id, id))
        .limit(1);

      if (!dataset) {
        throw new Error(`Dataset not found: ${id}`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(dataset.schema),
          },
        ],
      };
    }
  );

  // 3. List active kons (from registry)
  server.registerResource(
    "kons",
    "kitsuden://kons",
    {
      title: "Active Kons",
      description: "List of active core and grimoire kon modules",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(konRegistry),
          },
        ],
      };
    }
  );
}
