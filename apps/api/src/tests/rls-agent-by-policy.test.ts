/**
 * RLS: the «tool scope + policyJson» path also in Postgres
 * ============================================================================
 *
 * Audit: MCP tools now run in the agent's RLS
 * transaction. For that, Postgres has to know the rule that
 * `requireDataset` (mcp-tools.ts) applies: `mcp:read`/`mcp:write` + whatever the
 * dataset's `policyJson` allows, and a denial that beats everything.
 * `kitsuden_agent_opens_by_policy` (rls-policies.sql) is that rule in SQL.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { dataSets } from "../db/schema";

import { isDatabaseAvailable, generateTestId } from "./setup";

let dbAvailable = false;

async function opens(scopes: string[], datasetId: string, action: "read" | "write" | "delete") {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.agent_scopes', ${scopes.join(",")}, true)`);
    const r = (await tx.execute(
      sql`SELECT kitsuden_agent_opens_by_policy(${datasetId}::uuid, ${action}) AS si`
    )) as unknown as { rows: { si: boolean }[] };
    return r.rows[0]!.si;
  });
}

describe("kitsuden_agent_opens_by_policy", () => {
  let open = "";
  let readOnly = "";
  let adminOnly = "";
  let openSlug = "";

  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    const s = generateTestId()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-");
    openSlug = `open-${s}`;
    const create = async (slug: string, policyJson: unknown) =>
      (
        await db
          .insert(dataSets)
          .values({ name: slug, slug, schema: { fields: [] }, policyJson } as never)
          .returning()
      )[0]!.id;
    open = await create(openSlug, { readAccess: "authenticated", writeAccess: "authenticated" });
    readOnly = await create(`read-only-${s}`, { readAccess: "public", writeAccess: "admin" });
    adminOnly = await create(`admin-${s}`, { readAccess: "admin", writeAccess: "admin" });
  });

  it("the tool is required: without mcp:read nothing is read", async () => {
    if (!dbAvailable) return;
    expect(await opens(["mcp:connect"], open, "read")).toBe(false);
    expect(await opens(["mcp:connect", "mcp:read"], open, "read")).toBe(true);
  });

  it("the dataset's policy decides the rest", async () => {
    if (!dbAvailable) return;
    const writer = ["mcp:connect", "mcp:read", "mcp:write"];
    expect(await opens(writer, open, "write")).toBe(true);
    expect(await opens(writer, open, "delete")).toBe(true);
    expect(await opens(writer, readOnly, "read")).toBe(true);
    expect(await opens(writer, readOnly, "write")).toBe(false);
    expect(await opens(writer, adminOnly, "read")).toBe(false);
    // `dataset:view` opens reading of an «admin only» dataset, not writing
    expect(await opens([...writer, "dataset:view"], adminOnly, "read")).toBe(true);
    expect(await opens([...writer, "dataset:view"], adminOnly, "write")).toBe(false);
    expect(await opens(["admin"], adminOnly, "write")).toBe(true);
  });

  it("a dataset denial wins", async () => {
    if (!dbAvailable) return;
    expect(await opens(["mcp:read", "mcp:write", `!datasets:${openSlug}:*`], open, "read")).toBe(
      false
    );
    expect(
      await opens(["mcp:read", "mcp:write", `!datasets:${openSlug}:delete`], open, "write")
    ).toBe(true);
    expect(
      await opens(["mcp:read", "mcp:write", `!datasets:${openSlug}:delete`], open, "delete")
    ).toBe(false);
  });

  it("without agent scopes (humans, system) it opens nothing", async () => {
    if (!dbAvailable) return;
    expect(await opens([], open, "read")).toBe(false);
  });
});
