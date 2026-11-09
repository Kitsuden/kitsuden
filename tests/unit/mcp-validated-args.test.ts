/**
 * The MCP boundary is validated
 * ============================================================================
 *
 * The arguments of an MCP tool are written by a MODEL. They are not input
 * from a client of ours: they are generated text, and they reach `.insert()`,
 * `.update()` and the job queue.
 *
 * For a while they were read with `args as any`, which is not a typing detail
 * but the ABSENCE of the check. Removing it, the checker uncovered two real
 * holes:
 *
 *   · `status` is a Postgres enum (`content_status`) and was accepted as
 *     free text: a value outside the enum blew up against the column's type.
 *   · `dispatch_worker` enqueued an arbitrary object into a queue that requires
 *     `{to, subject, html}`: the failure showed up later, in the worker.
 *
 * These tests pin down the three properties that keep it from coming back:
 *
 *   1. EVERY declared tool has a schema.
 *   2. What is declared to the model matches what is validated.
 *   3. An invalid argument is rejected BEFORE touching the database.
 */

import { describe, expect, it } from "vitest";

import {
  executeHardcodedTool,
  listHardcodedMCPTools,
  namesWithSchema,
} from "../../apps/api/src/services/mcp-tools";

const ALL = listHardcodedMCPTools().map((t) => t.function.name);
const ADMIN_SESSION = { agentId: "a", agentName: "test", scopes: ["admin"] };

describe("MCP boundary", () => {
  it("there are tools to inspect", () => {
    expect(ALL.length).toBeGreaterThan(10);
  });

  it("every declared tool has a validation schema", () => {
    const withoutSchema = ALL.filter((n) => !namesWithSchema().includes(n));

    expect(
      withoutSchema,
      `These tools are offered to the model but nobody validates what it ` +
        `sends. Add their entry in ARGS_SCHEMAS of mcp-tools.ts. ` +
        `Tools: ${withoutSchema.join(", ")}`
    ).toEqual([]);
  });

  it("there are no orphan schemas", () => {
    // The other way around: a schema without a tool is dead code that feigns
    // coverage.
    const orphans = namesWithSchema().filter((n) => !ALL.includes(n));
    expect(orphans, `Schemas without a tool: ${orphans.join(", ")}`).toEqual([]);
  });

  it("rejects a tool that does not exist", async () => {
    await expect(
      executeHardcodedTool("kitsuden_delete_everything", {}, ADMIN_SESSION)
    ).rejects.toThrow(/Unknown hardcoded MCP tool/);
  });

  it("rejects a status that is not in the enum", async () => {
    // Before, this reached the query and failed against the column's type,
    // with a Postgres error the model cannot interpret.
    await expect(
      executeHardcodedTool(
        "kitsuden_insert_record",
        { datasetId: "d1", data: { a: 1 }, status: "live" },
        ADMIN_SESSION
      )
    ).rejects.toThrow(/Invalid arguments.*status/s);
  });

  it("rejects an incomplete email payload", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_dispatch_worker",
        { queueName: "email", jobName: "system.welcome", payload: { to: "a@b.com" } },
        ADMIN_SESSION
      )
    ).rejects.toThrow(/Invalid arguments/);
  });

  it("rejects a queue that does not exist instead of enqueuing blindly", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_dispatch_worker",
        { queueName: "webhooks", jobName: "x", payload: {} },
        ADMIN_SESSION
      )
    ).rejects.toThrow(/Invalid arguments/);
  });

  it("rejects a dataset slug with URL characters", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_create_dataset",
        { name: "X", slug: "../../etc/passwd", fields: [{ key: "a" }] },
        ADMIN_SESSION
      )
    ).rejects.toThrow(/Invalid arguments.*slug/s);
  });

  it("rejects an out-of-range limit instead of letting it through", async () => {
    // A huge `limit` from a model is the easiest way to take the database down.
    await expect(
      executeHardcodedTool(
        "kitsuden_query_collection",
        { collection: "games", limit: 999999 },
        ADMIN_SESSION
      )
    ).rejects.toThrow(/Invalid arguments.*limit/s);
  });

  it("rejects `data` that is not an object", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_create_record",
        { collection: "games", data: "I am not an object" },
        ADMIN_SESSION
      )
    ).rejects.toThrow(/Invalid arguments.*data/s);
  });

  it("requires id or entryId in update, not just either of the two formats", async () => {
    await expect(
      executeHardcodedTool("kitsuden_update_record", { data: { a: 1 } }, ADMIN_SESSION)
    ).rejects.toThrow(/Invalid arguments/);
  });
});
