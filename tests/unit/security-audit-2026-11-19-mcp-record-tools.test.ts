/**
 * Security audit 2026-11-19: the MCP record tools follow the same rules as REST
 * ============================================================================
 *
 * 1. `kitsuden_update_record` merged the caller's `data` over the stored row, so
 *    an agent could rewrite `data.ownerId`, the key that decides who sees a row
 *    in a per-owner dataset. Create never let an unsigned or signed non-admin
 *    agent choose an owner (`inputOwner`); update now keeps the stored owner and
 *    refuses a change unless the agent has `admin`.
 *
 * 2. The record tools took `status` from the model (`published` by default on
 *    create), so an agent published straight past a dataset whose workflow
 *    requires approval. REST never lets an agent choose the status there. Now a
 *    new entry on such a dataset is always `draft`, and an agent cannot publish
 *    an existing one.
 *
 * The database is a small fake: the rules live in the tool handlers, which is
 * what these tests pin down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ds: null as Record<string, unknown> | null,
  entry: null as Record<string, unknown> | null,
  inserted: undefined as Record<string, unknown> | undefined,
  updated: undefined as Record<string, unknown> | undefined,
  tables: {} as { dataSets?: unknown; dataEntries?: unknown },
}));

vi.mock("../../apps/api/src/db", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  const chain = (result: unknown[]) => {
    const p = Promise.resolve(result);
    const o: Record<string, unknown> = {
      where: () => o,
      limit: () => o,
      orderBy: () => o,
      offset: () => o,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
    return o;
  };
  const fake: Record<string, unknown> = {
    select: () => ({
      from: (t: unknown) =>
        chain(
          t === state.tables.dataSets
            ? state.ds
              ? [state.ds]
              : []
            : t === state.tables.dataEntries
              ? state.entry
                ? [state.entry]
                : []
              : []
        ),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted = v;
        return { returning: async () => [{ id: "e-new", ...v }] };
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        state.updated = s;
        return { where: () => ({ returning: async () => [{ ...state.entry, ...s }] }) };
      },
    }),
    execute: async () => [],
  };
  fake.transaction = async (fn: (tx: unknown) => unknown) => fn(fake);
  return { ...original, db: fake };
});

vi.mock("@kitsuden/engine", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, setRlsContext: async () => undefined, recordChanges: async () => 0 };
});

import { dataEntries, dataSets } from "../../apps/api/src/db/schema";
import { executeHardcodedTool } from "../../apps/api/src/services/mcp-tools";

state.tables.dataSets = dataSets;
state.tables.dataEntries = dataEntries;

const PER_OWNER_POLICY = {
  enableRLS: true,
  readAccess: "authenticated",
  writeAccess: "authenticated",
  rlsRules: [{ field: "ownerId", operator: "eq", value: "__USER_ID__" }],
};

const UNSIGNED_WRITER = {
  agentId: "ag-1",
  agentName: "writer",
  scopes: ["mcp:read", "mcp:write", "datasets:notes:write"],
};
const SIGNED_WRITER = {
  ...UNSIGNED_WRITER,
  sponsor: { userId: "u-signer", valid: true },
};
const ADMIN_AGENT = { agentId: "ag-2", agentName: "admin", scopes: ["admin"] };

function dataset(workflowJson: unknown = null) {
  return { id: "ds-1", slug: "notes", policyJson: PER_OWNER_POLICY, workflowJson };
}

beforeEach(() => {
  state.ds = dataset();
  state.entry = {
    id: "e-1",
    dataSetId: "ds-1",
    title: "x",
    data: { title: "x", ownerId: null },
    ownerId: null,
    createdById: "ag-1",
    status: "draft",
  };
  state.inserted = undefined;
  state.updated = undefined;
});

describe("kitsuden_update_record keeps the stored owner", () => {
  it("an unsigned agent cannot point data.ownerId at another user", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_update_record",
        { collection: "notes", id: "e-1", data: { ownerId: "u-victim" } },
        UNSIGNED_WRITER
      )
    ).rejects.toThrow(/owner/);
    expect(state.updated).toBeUndefined();
  });

  it("the legacy entryId branch refuses it too", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_update_record",
        { entryId: "e-1", data: { ownerId: "u-victim" } },
        UNSIGNED_WRITER
      )
    ).rejects.toThrow(/owner/);
    expect(state.updated).toBeUndefined();
  });

  it("a signed non-admin agent cannot re-point it either", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_update_record",
        { collection: "notes", id: "e-1", data: { ownerId: "u-victim" } },
        SIGNED_WRITER
      )
    ).rejects.toThrow(/owner/);
    expect(state.updated).toBeUndefined();
  });

  it("an update without ownerId keeps the stored one", async () => {
    state.entry!.data = { title: "x", ownerId: "u-owner" };
    state.entry!.ownerId = "u-owner";
    const text = await executeHardcodedTool(
      "kitsuden_update_record",
      { collection: "notes", id: "e-1", data: { title: "y" } },
      UNSIGNED_WRITER
    );
    expect(text).toMatch(/^Updated dataset record/);
    expect((state.updated!.data as Record<string, unknown>).ownerId).toBe("u-owner");
    expect((state.updated!.data as Record<string, unknown>).title).toBe("y");
    expect(state.updated).not.toHaveProperty("ownerId");
  });

  it("sending the stored ownerId back is accepted", async () => {
    state.entry!.data = { title: "x", ownerId: "u-owner" };
    const text = await executeHardcodedTool(
      "kitsuden_update_record",
      { collection: "notes", id: "e-1", data: { title: "y", ownerId: "u-owner" } },
      UNSIGNED_WRITER
    );
    expect(text).toMatch(/^Updated dataset record/);
    expect((state.updated!.data as Record<string, unknown>).ownerId).toBe("u-owner");
  });

  it("an agent with admin may name another owner, and both owner fields move together", async () => {
    const text = await executeHardcodedTool(
      "kitsuden_update_record",
      { collection: "notes", id: "e-1", data: { ownerId: "u-new" } },
      ADMIN_AGENT
    );
    expect(text).toMatch(/^Updated dataset record/);
    expect((state.updated!.data as Record<string, unknown>).ownerId).toBe("u-new");
    expect(state.updated!.ownerId).toBe("u-new");
  });
});

describe("a dataset that requires approval: agents do not publish", () => {
  beforeEach(() => {
    state.ds = dataset({ requireApproval: true });
  });

  it("kitsuden_create_record stores draft, even for an admin-scoped agent", async () => {
    await executeHardcodedTool(
      "kitsuden_create_record",
      { collection: "notes", data: { title: "unreviewed" } },
      ADMIN_AGENT
    );
    expect(state.inserted!.status).toBe("draft");
  });

  it("kitsuden_create_record ignores an explicit published", async () => {
    await executeHardcodedTool(
      "kitsuden_create_record",
      { collection: "notes", data: { title: "unreviewed" }, status: "published" },
      ADMIN_AGENT
    );
    expect(state.inserted!.status).toBe("draft");
  });

  it("kitsuden_insert_record ignores an explicit published", async () => {
    await executeHardcodedTool(
      "kitsuden_insert_record",
      { datasetId: "ds-1", data: { title: "unreviewed" }, status: "published" },
      ADMIN_AGENT
    );
    expect(state.inserted!.status).toBe("draft");
  });

  it("the legacy update cannot flip a draft to published", async () => {
    await expect(
      executeHardcodedTool(
        "kitsuden_update_record",
        { entryId: "e-1", data: {}, status: "published" },
        ADMIN_AGENT
      )
    ).rejects.toThrow(/requires approval/);
    expect(state.updated).toBeUndefined();
  });

  it("without requireApproval the requested status is kept", async () => {
    state.ds = dataset(null);
    await executeHardcodedTool(
      "kitsuden_create_record",
      { collection: "notes", data: { title: "ok" } },
      ADMIN_AGENT
    );
    expect(state.inserted!.status).toBe("published");
    await executeHardcodedTool(
      "kitsuden_update_record",
      { entryId: "e-1", data: {}, status: "published" },
      ADMIN_AGENT
    );
    expect(state.updated!.status).toBe("published");
  });
});
