/**
 * Kitsuden MCP Server
 *
 * Model Context Protocol server for AI agents (Claude, Cursor, etc.)
 * to interact with Kitsuden CMS backend.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { META_FORMAT, resultText } from "./format.js";
import { encodeToon } from "./toon.js";

export interface McpServerDependencies {
  db: any;
  schema: {
    dataSets: any;
    dataEntries: any;
  };
  queue: {
    addJob: (queueName: string, jobName: string, payload: any) => Promise<string | null>;
  };
  konRegistry: Record<string, any>;
}

export function createKitsudenMcpServer(deps: McpServerDependencies): Server {
  const server = new Server(
    {
      name: "kitsuden-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  // Register resource handlers
  registerResourceHandlers(server, deps);

  // Register tool handlers
  registerToolHandlers(server, deps);

  return server;
}

function registerResourceHandlers(server: Server, deps: McpServerDependencies) {
  const { db, schema, konRegistry } = deps;

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "kitsuden://datasets",
          name: "Kitsuden Datasets",
          mimeType: "application/json",
          description: "List of all active dynamic datasets in the CMS",
        },
        {
          uri: "kitsuden://kons",
          name: "Active Kons",
          mimeType: "application/json",
          description: "List of active core and grimoire kon modules",
        },
      ],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "kitsuden://datasets") {
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
            uri,
            mimeType: "application/json",
            text: JSON.stringify(mapped),
          },
        ],
      };
    }

    if (uri === "kitsuden://kons") {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(konRegistry),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
  });
}

function registerToolHandlers(server: Server, deps: McpServerDependencies) {
  const { db, schema, queue } = deps;

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "kitsuden_query_dataset",
          description: "Select and filter records from a specific dataset",
          inputSchema: {
            type: "object",
            properties: {
              datasetId: {
                type: "string",
                description: "UUID of the dataset",
              },
              limit: {
                type: "number",
                description: "Max number of records to return",
              },
              status: {
                type: "string",
                description: "Filter by status (e.g. 'published', 'draft')",
              },
            },
            required: ["datasetId"],
          },
        },
        {
          name: "kitsuden_insert_record",
          description: "Insert a new record into a dataset",
          inputSchema: {
            type: "object",
            properties: {
              datasetId: {
                type: "string",
                description: "UUID of the dataset",
              },
              title: {
                type: "string",
                description: "Title of the new record",
              },
              data: {
                type: "object",
                description: "JSON payload matching the dataset schema",
              },
              status: {
                type: "string",
                default: "draft",
                description: "Initial status of the record",
              },
            },
            required: ["datasetId", "title", "data"],
          },
        },
        {
          name: "kitsuden_dispatch_worker",
          description: "Enqueue an asynchronous background job (Postgres queue)",
          inputSchema: {
            type: "object",
            properties: {
              queueName: {
                type: "string",
                description: "Name of the queue (e.g., 'kitsuden-email', 'kitsuden-webhooks')",
              },
              jobName: {
                type: "string",
                description: "Name of the job inside the queue",
              },
              payload: {
                type: "object",
                description: "Payload data to send to the worker",
              },
            },
            required: ["queueName", "jobName", "payload"],
          },
        },
        {
          name: "kitsuden_encode_toon",
          description:
            "Encode JSON data as TOON (https://toonformat.dev). Shorter than compact JSON for flat, uniform lists of objects; usually longer for nested records.",
          inputSchema: {
            type: "object",
            properties: {
              data: {
                type: "object",
                description: "JSON payload to encode",
              },
            },
            required: ["data"],
          },
        },
      ],
    };
  });

  // Execute tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "kitsuden_query_dataset": {
          const { datasetId, limit = 50, status } = args as any;
          const { eq, and } = await import("drizzle-orm");

          let query = db
            .select()
            .from(schema.dataEntries)
            .where(eq(schema.dataEntries.dataSetId, datasetId));

          if (status) {
            query = query.where(
              and(
                eq(schema.dataEntries.dataSetId, datasetId),
                eq(schema.dataEntries.status, status)
              )
            );
          }

          const results = await query.limit(Math.min(limit, 100));
          // Compact JSON or TOON, the shortest lossless; `_meta` says which
          const { text: text, format: format } = resultText(results);

          return {
            content: [{ type: "text", text }],
            _meta: { [META_FORMAT]: format },
          };
        }

        case "kitsuden_insert_record": {
          const { datasetId, title, data, status = "draft" } = args as any;

          const [newRecord] = await db
            .insert(schema.dataEntries)
            .values({
              dataSetId: datasetId,
              title,
              data,
              status,
            })
            .returning();

          return {
            content: [
              {
                type: "text",
                text: `Successfully inserted record with ID: ${newRecord.id}`,
              },
            ],
          };
        }

        case "kitsuden_dispatch_worker": {
          const { queueName, jobName, payload } = args as any;

          try {
            const jobId = await queue.addJob(queueName, jobName, payload);
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully dispatched job '${jobName}' to queue '${queueName}' with Job ID: ${jobId}`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to dispatch job: ${err.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case "kitsuden_encode_toon": {
          const { data } = args as any;
          // The same codec as the API (./toon.ts is an identical copy)
          return { content: [{ type: "text", text: encodeToon(data) }] };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err: any) {
      throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${err.message}`);
    }
  });
}

// Export for stdio transport (for CLI usage)
export { StdioServerTransport };
