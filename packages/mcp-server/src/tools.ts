import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

import type { McpServerDependencies } from "./index";

export function registerTools(server: McpServer, deps: McpServerDependencies) {
  const { db, schema, queue } = deps;

  server.registerTool(
    "kitsuden_query_dataset",
    {
      title: "Query Dataset",
      description: "Select and filter records from a specific dataset",
      inputSchema: z.object({
        datasetId: z.string().describe("UUID of the dataset"),
        limit: z.number().optional().describe("Max number of records to return"),
        status: z.string().optional().describe("Filter by status (e.g. 'published', 'draft')"),
      }),
      outputSchema: z.any(),
    },
    async ({ datasetId, limit = 50, status }) => {
      let query = db
        .select()
        .from(schema.dataEntries)
        .where(eq(schema.dataEntries.dataSetId, datasetId));

      if (status) {
        query = db
          .select()
          .from(schema.dataEntries)
          .where(
            and(eq(schema.dataEntries.dataSetId, datasetId), eq(schema.dataEntries.status, status))
          );
      }

      const results = await query.limit(Math.min(limit, 100));

      return {
        content: [{ type: "text", text: JSON.stringify(results) }],
      };
    }
  );

  server.registerTool(
    "kitsuden_insert_record",
    {
      title: "Insert Dataset Record",
      description: "Insert a new record into a dataset",
      inputSchema: z.object({
        datasetId: z.string().describe("UUID of the dataset"),
        title: z.string().describe("Title of the new record"),
        data: z.record(z.string(), z.any()).describe("JSON payload matching the dataset schema"),
        status: z.string().default("draft").describe("Initial status of the record"),
      }),
      outputSchema: z.any(),
    },
    async ({ datasetId, title, data, status }) => {
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
        content: [{ type: "text", text: `Successfully inserted record with ID: ${newRecord.id}` }],
      };
    }
  );

  server.registerTool(
    "kitsuden_dispatch_worker",
    {
      title: "Dispatch Worker Task",
      description: "Enqueue an asynchronous background job (Postgres queue)",
      inputSchema: z.object({
        queueName: z
          .string()
          .describe("Name of the queue (e.g., 'kitsuden-email', 'kitsuden-webhooks')"),
        jobName: z.string().describe("Name of the job inside the queue"),
        payload: z.record(z.string(), z.any()).describe("Payload data to send to the worker"),
      }),
      outputSchema: z.any(),
    },
    async ({ queueName, jobName, payload }) => {
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
          isError: true,
          content: [{ type: "text", text: `Failed to dispatch job: ${err.message}` }],
        };
      }
    }
  );
}
