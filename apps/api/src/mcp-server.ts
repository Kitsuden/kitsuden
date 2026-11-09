#!/usr/bin/env bun
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Kitsuden MCP Server — Standalone MCP Server for Claude Desktop
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MCP (Model Context Protocol) server that exposes Kitsuden tools
 * to AI agents such as Claude Desktop, Cursor, VS Code, etc.
 *
 * Authentication: Token kitsuden_agent_xxx (Agent Identity - NHI)
 * Protocol: MCP 2024-11-05 (stdio transport for Claude Desktop)
 *
 * Usage: bun run apps/api/src/mcp-server.ts
 * Or:    bun run mcp-server (if it is in package.json)
 *
 * Environment variables:
 *   - KITSUDEN_API_TOKEN: Agent token (kitsuden_agent_xxx)
 *   - KITSUDEN_API_URL: Kitsuden API URL (default: http://localhost:3001)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// ═══════════════════════════════════════════════════════════════════════════

// CONFIGURATION

// ═══════════════════════════════════════════════════════════════════════════
const API_URL = process.env.KITSUDEN_API_URL || "http://localhost:3001";
const MCP_TOKEN = process.env.KITSUDEN_API_TOKEN;
if (!MCP_TOKEN) {
  console.error("❌ ERROR: KITSUDEN_API_TOKEN is not set");
  console.error("   This token must have the format: kitsuden_agent_xxx");
  console.error("   Generate one with: bun run apps/api/scripts/seed-mcp-test.ts");
  process.exit(1);
}
if (!MCP_TOKEN.startsWith("kitsuden_agent_")) {
  console.error("❌ ERROR: KITSUDEN_API_TOKEN must start with 'kitsuden_agent_'");
  process.exit(1);
}
// ═══════════════════════════════════════════════════════════════════════════

// LOGGER

// ═══════════════════════════════════════════════════════════════════════════
/**
 * JSON from the API and from the tool arguments. This file only passes it along
 * and formats it as text; the API validates it, not this process.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type Json = Record<string, any>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(level: "info" | "error" | "debug", message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [MCP-Server]`;
  if (data) {
    console.error(`${prefix} ${message}`, JSON.stringify(data));
  } else {
    console.error(`${prefix} ${message}`);
  }
}
log("info", "🔌 Starting Kitsuden MCP server...");
log("info", `📡 API URL: ${API_URL}`);
// ═══════════════════════════════════════════════════════════════════════════

// MCP TOOLS

// ═══════════════════════════════════════════════════════════════════════════
const TOOLS: Tool[] = [
  {
    name: "kitsuden_list_datasets",
    description: "Lists all the datasets available in Kitsuden CMS",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of datasets to return (default: 50)",
          default: 50,
        },
      },
    },
  },
  {
    name: "kitsuden_search_entries",
    description: "Searches entries in a dataset by content or using semantic search",
    inputSchema: {
      type: "object",
      properties: {
        datasetId: { type: "string", description: "ID of the dataset to search" },
        query: { type: "string", description: "Search term" },
        semantic: {
          type: "boolean",
          description: "Use semantic (vector) search instead of text",
          default: false,
        },
        limit: { type: "number", description: "Maximum number of results", default: 10 },
      },
      required: ["datasetId", "query"],
    },
  },
  {
    name: "kitsuden_create_entry",
    description: "Creates a new entry in a dataset",
    inputSchema: {
      type: "object",
      properties: {
        datasetId: { type: "string", description: "ID of the dataset" },
        data: {
          type: "object",
          description: "Entry data (fields defined in the dataset)",
        },
      },
      required: ["datasetId", "data"],
    },
  },
  {
    name: "kitsuden_read_entry",
    description: "Reads a specific entry of a dataset",
    inputSchema: {
      type: "object",
      properties: {
        datasetId: { type: "string", description: "ID of the dataset" },
        entryId: { type: "string", description: "ID of the entry" },
      },
      required: ["datasetId", "entryId"],
    },
  },
  {
    name: "kitsuden_update_entry",
    description: "Updates an existing entry in a dataset",
    inputSchema: {
      type: "object",
      properties: {
        datasetId: { type: "string", description: "ID of the dataset" },
        entryId: { type: "string", description: "ID of the entry" },
        data: { type: "object", description: "New data (only the fields to update)" },
      },
      required: ["datasetId", "entryId", "data"],
    },
  },
  {
    name: "kitsuden_get_dataset_schema",
    description: "Gets the schema of a dataset (fields, types, etc.)",
    inputSchema: {
      type: "object",
      properties: { datasetId: { type: "string", description: "ID of the dataset" } },
      required: ["datasetId"],
    },
  },
  {
    name: "kitsuden_health_check",
    description: "Checks the status of the connection to the Kitsuden API",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "kitsuden_query_dataset",
    description: `Runs advanced Kitsuden QL queries on a dataset with support for complex filters and relation expansion (Anti N+1).

Filter syntax (where):
- Equality: { "status": "active" }
- Operators: { "level": { "gte": 50 } } (eq, neq, gt, gte, lt, lte, in, contains, startsWith, endsWith)
- AND/OR logic: { "AND": [{ "status": "active" }, { "level": { "gte": 50 } }] }

Expansion (expand): Array of relation names to include related data in a single query.
Example: ["author", "comments"] will include the related objects, avoiding N+1 queries.

Full query example:
{
  "datasetId": "posts",
  "where": { "status": "published", "views": { "gte": 100 } },
  "expand": ["author", "tags"],
  "limit": 20,
  "orderBy": [{ "field": "createdAt", "direction": "desc" }]
}`,
    inputSchema: {
      type: "object",
      properties: {
        datasetId: { type: "string", description: "ID of the dataset to query" },
        where: {
          type: "object",
          description:
            "Query filters. Supports operators (eq, neq, gt, gte, lt, lte, in, contains, startsWith, endsWith) and AND/OR/NOT logic",
        },
        expand: {
          type: "array",
          items: { type: "string" },
          description: "Array of relation names to expand (Anti N+1)",
          default: [],
        },
        select: {
          type: "array",
          items: { type: "string" },
          description: "Specific fields to select (optional)",
          default: [],
        },
        limit: { type: "number", description: "Maximum results (1-1000)", default: 50 },
        offset: { type: "number", description: "Offset for pagination", default: 0 },
        orderBy: { type: "array", description: "Result ordering", default: [] },
      },
      required: ["datasetId"],
    },
  },
  {
    name: "kitsuden_execute_batch",
    description: `Runs multiple CRUD operations in a guaranteed ACID transaction.
If ANY operation fails, ALL are rolled back (automatic rollback).
Supports references between operations through @ref:alias.field.

Supported operations:
- create: Create a new entry
- update: Update an existing entry
- delete: Delete an entry
- upsert: Insert or update (if it exists)

@ref references:
Use @ref:alias.id or @ref:alias.data.field to reference values from previous operations.

Example:
[
  { "op": "create", "table": "dataEntries", "data": { "dataSetId": "characters", "data": { "name": "Hero" } }, "alias": "hero" },
  { "op": "create", "table": "dataEntries", "data": { "dataSetId": "skills", "data": { "name": "Fireball", "characterId": "@ref:hero.id" } } }
]`,
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "Array of operations to run (max 100)",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["create", "update", "delete", "upsert"],
                description: "Operation type",
              },
              table: {
                type: "string",
                enum: ["dataEntries", "dataSets"],
                description: "Target table",
              },
              data: { type: "object", description: "Data for create/update/upsert" },
              id: { type: "string", description: "ID for update/delete (can use @ref)" },
              alias: {
                type: "string",
                description: "Alias to reference in later operations",
              },
              where: { type: "object", description: "Condition for multiple update/delete" },
            },
            required: ["op", "table"],
          },
        },
      },
      required: ["operations"],
    },
  },
];
// ═══════════════════════════════════════════════════════════════════════════

// API CLIENT

// ═══════════════════════════════════════════════════════════════════════════
async function kitsudenApi(endpoint: string, options: RequestInit = {}): Promise<Json> {
  const url = `${API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Kitsuden API error ${response.status}: ${error}`);
  }
  return (await response.json()) as Json;
}
// ═══════════════════════════════════════════════════════════════════════════

// TOOL HANDLERS

// ═══════════════════════════════════════════════════════════════════════════
async function handleListDatasets(args: Json = {}) {
  const limit = args.limit || 50;
  try {
    const result = await kitsudenApi(`/api/data-sets?limit=${limit}`);
    return {
      content: [
        {
          type: "text",
          text: `📊 Available datasets (${result.length}):\n\n${result.map((ds: Json) => `- **${ds.name}** (ID: ${ds.id})\n  Slug: ${ds.slug}\n  Description: ${ds.description || "N/A"}`).join("\n\n")}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error listing datasets: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
async function handleSearchEntries(args: Json = {}) {
  const { datasetId, query, semantic = false, limit = 10 } = args;
  try {
    let result;
    if (semantic) {
      // Semantic/vector search
      result = await kitsudenApi(`/api/datasets/${datasetId}/vector-search`, {
        method: "POST",
        body: JSON.stringify({ query, limit, threshold: 0.7 }),
      });
    } else {
      // Text search
      result = await kitsudenApi(
        `/api/data-sets/${datasetId}/entries?search=${encodeURIComponent(query)}&limit=${limit}`
      );
    }
    const entries = result.results || result;
    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `🔍 No results found for "${query}" en el dataset ${datasetId}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `🔍 Results for "${query}" (${entries.length} found):\n\n${entries
            .map((entry: Json, i: number) => {
              const similarity = entry.similarity
                ? ` (similarity: ${(entry.similarity * 100).toFixed(1)}%)`
                : "";
              return `${i + 1}. **${entry.title || entry.name || "Untitled"}**${similarity}\n   ID: ${entry.id}\n   ${JSON.stringify(entry.data || {}).substring(0, 200)}...`;
            })
            .join("\n\n")}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error searching: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
async function handleCreateEntry(args: Json = {}) {
  const { datasetId, data } = args;
  try {
    const result = await kitsudenApi(`/api/data-sets/${datasetId}/entries`, {
      method: "POST",
      body: JSON.stringify({ title: data.title || data.name || "New entry", data }),
    });
    return {
      content: [
        {
          type: "text",
          text: `✅ Entry created successfully!\n\nID: ${result.id}\nTitle: ${result.title}\nDataset: ${datasetId}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error creating entry: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
async function handleReadEntry(args: Json = {}) {
  const { datasetId, entryId } = args;
  try {
    const result = await kitsudenApi(`/api/data-sets/${datasetId}/entries/${entryId}`);
    return {
      content: [
        {
          type: "text",
          text: `📄 Entry: ${result.title || result.name || entryId}\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error reading entry: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
async function handleUpdateEntry(args: Json = {}) {
  const { datasetId, entryId, data } = args;
  try {
    const result = await kitsudenApi(`/api/data-sets/${datasetId}/entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify({ data }),
    });
    return {
      content: [
        {
          type: "text",
          text: `✅ Entry updated successfully!\n\nID: ${result.id}\nDataset: ${datasetId}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error updating entry: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
async function handleGetDatasetSchema(args: Json = {}) {
  const { datasetId } = args;
  try {
    const result = await kitsudenApi(`/api/data-sets/${datasetId}`);
    return {
      content: [
        {
          type: "text",
          text: `📋 Dataset schema: **${result.name}**\n\nFields:\n${result.schema?.map((field: Json) => `- **${field.fieldName}**: ${field.fieldType}${field.required ? " (required)" : ""}`).join("\n") || "No fields defined"}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error getting schema: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
async function handleHealthCheck() {
  try {
    const result = await kitsudenApi("/api/health");
    return {
      content: [
        {
          type: "text",
          text: `✅ Kitsuden API is healthy!\n\nStatus: ${result.status}\nService: ${result.service}\nVersion: ${result.version}\n\nChecks:\n${Object.entries(
            (result.checks || {}) as Record<string, Json>
          )
            .map(
              ([name, check]) =>
                `- ${name}: ${check.status}${check.error ? ` ❌ ${check.error}` : ""}`
            )
            .join("\n")}`,
        },
      ],
    };
  } catch (error: unknown) {
    return {
      content: [
        {
          type: "text",
          text: `❌ Connection error with the Kitsuden API: ${messageOf(error)}\n\nMake sure the server is running:\ncd apps/api && bun run dev`,
        },
      ],
      isError: true,
    };
  }
}
// ═══════════════════════════════════════════════════════════════════════════

// HANDLERS DE QUERY ENGINE Y BATCH PROCESSOR

// ═══════════════════════════════════════════════════════════════════════════
async function handleQueryDataset(args: Json = {}) {
  const { datasetId, where, expand, select, limit = 50, offset = 0, orderBy } = args;
  try {
    const payload: Json = { where, expand, limit, offset };
    if (select) payload.select = select;
    if (orderBy) payload.orderBy = orderBy;
    const result = await kitsudenApi(`/api/datasets/${datasetId}/query`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const { data, meta } = result;
    if (data.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `🔍 No results found in the dataset "${datasetId}" with the specified filters.`,
          },
        ],
      };
    }
    // Format result
    const summary = `📊 Query executed successfully!

📈 Metadata:
- Total: ${meta.total} records
- Showing: ${data.length} (limit: ${meta.limit}, offset: ${meta.offset})
- Time: ${meta.queryTimeMs}ms
- HasMore: ${meta.hasMore ? "Yes" : "No"}

📋 Results (${data.length}):
${data
  .map((entry: Json, i: number) => {
    const title =
      entry.title || entry.name || entry.data?.title || entry.data?.name || `Registry ${i + 1}`;
    const id = entry.id;
    const data = JSON.stringify(entry.data || {}, null, 2).substring(0, 300);
    const expanded = entry.expanded
      ? `\n   [Expanded: ${Object.keys(entry.expanded).join(", ")}]`
      : "";
    return `${i + 1}. **${title}** (ID: ${id})${expanded}\n   ${data}${data.length > 300 ? "..." : ""}`;
  })
  .join("\n\n")}`;
    return { content: [{ type: "text", text: summary }] };
  } catch (error: unknown) {
    // Handle specific Query Engine errors
    const errorMsg = messageOf(error) || String(error);
    if (errorMsg.includes("COLUMN_NOT_FOUND")) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Error: Column not found.\n\nCheck that the field names in 'where' exist in the dataset. Details: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
    if (errorMsg.includes("RELATION_NOT_FOUND")) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Error: Relation not found.\n\nCheck that the names in 'expand' are valid for this dataset. Details: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: `❌ Error running query: ${errorMsg}` }],
      isError: true,
    };
  }
}
async function handleExecuteBatch(args: Json = {}) {
  const { operations } = args;
  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return {
      content: [{ type: "text", text: `❌ Error: An array of operations is required` }],
      isError: true,
    };
  }
  try {
    const result = await kitsudenApi("/api/datasets/batch", {
      method: "POST",
      body: JSON.stringify({ operations }),
    });
    const { success, results, rolledBack, error, meta } = result;
    if (success) {
      const summary = `✅ Batch executed successfully!

📈 Summary:
- Operations: ${meta.totalOperations}
- Succeeded: ${meta.successfulOperations}
- Failed: ${meta.failedOperations}
- Duration: ${meta.durationMs}ms

📋 Details:
${results
  .map((r: Json) => {
    const status =
      r.status === "created"
        ? "✅ Created"
        : r.status === "updated"
          ? "📝 Updated"
          : r.status === "deleted"
            ? "🗑️ Deleted"
            : r.status === "upserted"
              ? "♻️ Upserted"
              : r.status;
    const alias = r.alias ? ` (alias: ${r.alias})` : "";
    const id = r.id ? ` | ID: ${r.id}` : "";
    return `- [${r.index}] ${status}${alias}${id}`;
  })
  .join("\n")}`;
      return { content: [{ type: "text", text: summary }] };
    } else {
      // Failure with rollback
      const summary = `⚠️ Batch failed - Rollback was executed

❌ Error:
- Operation: #${error?.operationIndex ?? "?"}
- Code: ${error?.code}
- Message: ${error?.message}

📊 State:
- Rollback:${rolledBack ? "✅ Completed" : "⚠️ Partial"}
- Total: ${meta.totalOperations}
- Duration: ${meta.durationMs}ms

📋 Operations:
${results
  .map((r: Json) => {
    const status =
      r.status === "failed"
        ? "❌ Failed"
        : r.status === "rolled_back"
          ? "↩️ Rollback"
          : r.status === "created"
            ? "✅ Created (rollback)"
            : r.status;
    const alias = r.alias ? ` (alias: ${r.alias})` : "";
    const err = r.error ? `\n   Error: ${r.error?.message ?? r.error}` : "";
    return `- [${r.index}] ${status}${alias}${err}`;
  })
  .join("\n")}`;
      return { content: [{ type: "text", text: summary }], isError: true };
    }
  } catch (error: unknown) {
    return {
      content: [{ type: "text", text: `❌ Error running batch: ${messageOf(error)}` }],
      isError: true,
    };
  }
}
// ═══════════════════════════════════════════════════════════════════════════

// MCP SERVER

// ═══════════════════════════════════════════════════════════════════════════
const server = new Server(
  { name: "kitsuden-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
// Handler to list tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("debug", "Listing available tools");
  return { tools: TOOLS };
});
// Handler to run tools
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log("info", `Running tool: ${name}`, args);
  try {
    switch (name) {
      case "kitsuden_list_datasets":
        return await handleListDatasets(args);
      case "kitsuden_search_entries":
        return await handleSearchEntries(args);
      case "kitsuden_create_entry":
        return await handleCreateEntry(args);
      case "kitsuden_read_entry":
        return await handleReadEntry(args);
      case "kitsuden_update_entry":
        return await handleUpdateEntry(args);
      case "kitsuden_get_dataset_schema":
        return await handleGetDatasetSchema(args);
      case "kitsuden_health_check":
        return await handleHealthCheck();
      case "kitsuden_query_dataset":
        return await handleQueryDataset(args);
      case "kitsuden_execute_batch":
        return await handleExecuteBatch(args);
      default:
        return {
          content: [{ type: "text", text: `❌ Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error: unknown) {
    log("error", `Error running ${name}:`, messageOf(error));
    return {
      content: [{ type: "text", text: `❌ Internal error: ${messageOf(error)}` }],
      isError: true,
    };
  }
});
// ═══════════════════════════════════════════════════════════════════════════

// START SERVER

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  const transport = new StdioServerTransport();
  log("info", "🚀 Starting MCP server...");
  log("info", `📦 ${TOOLS.length} tools available`);
  await server.connect(transport);
  log("info", "✅ MCP server ready and waiting for connections");
}
main().catch((error) => {
  log("error", "Fatal error in MCP server:", error);
  process.exit(1);
});
