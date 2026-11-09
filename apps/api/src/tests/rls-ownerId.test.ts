import { describe, it, expect, beforeAll, afterAll } from "bun:test";

let dbAvailable = false;

// Lazy-load DB-dependent modules to avoid schema-merger crash on non-DB tests
async function loadDbModules() {
  const { db } = await import("../db");
  const { dataSets, dataEntries, authUsers } = await import("../db/schema-core");
  const { eq } = await import("drizzle-orm");
  const { isDatabaseAvailable, clearTestData, generateTestId } = await import("./setup");
  return {
    db,
    dataSets,
    dataEntries,
    authUsers,
    eq,
    isDatabaseAvailable,
    clearTestData,
    generateTestId,
  };
}

describe("RLS OwnerId Tests", () => {
  beforeAll(async () => {
    try {
      const { isDatabaseAvailable } = await loadDbModules();
      dbAvailable = await isDatabaseAvailable();
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      try {
        const { clearTestData } = await loadDbModules();
        await clearTestData();
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // ── 1. The ownership rule, tested by BEHAVIOR ──
  //
  // Before this was `expect(source).toContain('ownerId = e.ownerId ?? c.get(...)')`.
  // A grep of the source code checks nothing: it went red because of a refactor
  // that did not change the behavior, and it would have stayed green if someone had
  // deleted the assignment leaving the text in a comment. `owner_id` is the
  // column the RLS policies rest on; it deserves a real test.
  describe("whose a new entry is", () => {
    it("without an ownerId in the payload, it belongs to the session user", async () => {
      const { resolveEntryOwnerId } = await import("../routes/crud");
      expect(resolveEntryOwnerId({ title: "Algo" }, "user-1")).toBe("user-1");
    });

    it("the payload's ownerId only counts if the team is writing", async () => {
      // Imports attribute rows to another user, and that is a team matter.
      // For any other account it is ignored: before, it was enough to put
      // rows into another person's private space (audit).
      const { resolveEntryOwnerId } = await import("../routes/crud");
      expect(resolveEntryOwnerId({ ownerId: "user-2" }, "user-1", true)).toBe("user-2");
      expect(resolveEntryOwnerId({ ownerId: "user-2" }, "user-1")).toBe("user-1");
      expect(resolveEntryOwnerId({ ownerId: "user-2" }, "user-1", false)).toBe("user-1");
    });

    it("without payload and without a session it stays NULL, never undefined", async () => {
      // `undefined` in a Drizzle insert is omitted and the column takes its
      // default instead of being left with an explicit no-owner: the row would end up outside
      // every ownership policy without anyone noticing.
      const { resolveEntryOwnerId } = await import("../routes/crud");
      expect(resolveEntryOwnerId({}, undefined)).toBeNull();
    });
  });

  it("items.ts POST /:collection should include ownerId", async () => {
    const file = Bun.file("src/routes/items.ts");
    const text = await file.text();
    expect(text).toContain("ownerId");
    const handlerIndex = text.indexOf("export async function createItemHandler");
    expect(handlerIndex).toBeGreaterThan(-1);
    const nextHandlerIndex = text.indexOf(
      "export async function updateItemHandler",
      handlerIndex + 1
    );
    const snippet =
      nextHandlerIndex > -1 ? text.slice(handlerIndex, nextHandlerIndex) : text.slice(handlerIndex);
    expect(snippet).toContain("ownerId");
  });

  // ── 2. DB integration: ownerId is persisted ──
  it("should persist ownerId in data_entries and data JSONB", async () => {
    if (!dbAvailable) {
      console.log("Skipping DB test — database not available");
      return;
    }

    const { db, dataSets, dataEntries, authUsers, eq, generateTestId } = await loadDbModules();

    const testId = generateTestId();
    const slug = `test-dataset-${testId}`;

    // `data_entries.owner_id` is a foreign key to `auth_users`: a made-up
    // owner («test-user-123») is rejected by Postgres. With pg-mem this never
    // ran. The `test-…@example.com` email is cleaned up by clearTestData.
    const ownerId = `owner-${testId}`;
    await db.insert(authUsers).values({
      id: ownerId,
      name: "RLS Owner",
      email: `${testId}@example.com`,
    });

    // Create dataset
    const [dataset] = await db
      .insert(dataSets)
      .values({
        name: `Test Dataset ${testId}`,
        slug,
        description: "Test dataset for RLS ownerId",
        schema: [{ fieldName: "title", fieldType: "text", required: true }],
        policyJson: {
          readAccess: "authenticated",
          writeAccess: "authenticated",
          enableRLS: true,
          rlsRules: [{ field: "ownerId", operator: "eq", value: "{{current_user_id}}" }],
        },
      })
      .returning();

    expect(dataset).toBeDefined();
    expect(dataset.id).toBeDefined();

    // Insert data entry with explicit ownerId.
    //
    // The copy in `data.ownerId` (the one read by `buildDatasetWhere` and the policy
    // `data->>'ownerId'` in rls-policies.sql) is written by the HANDLER
    // (`POST /api/data-sets/:id/entries`, routes/crud.ts), not a trigger: there is
    // none on `data_entries` that fills it in. This direct insert does the
    // same as the handler; that the handler does it is tested by rls-e2e and
    // datasets-http (isolation over HTTP).
    const [entry] = await db
      .insert(dataEntries)
      .values({
        dataSetId: dataset.id,
        title: "Test Entry",
        data: { foo: "bar", ownerId },
        ownerId,
      })
      .returning();

    expect(entry).toBeDefined();
    expect(entry.ownerId).toBe(ownerId);

    // Re-read from the database, not from the in-memory `returning`
    const [reread] = await db.select().from(dataEntries).where(eq(dataEntries.id, entry.id));
    expect(reread.ownerId).toBe(ownerId);
    expect((reread.data as Record<string, unknown>).ownerId).toBe(ownerId);

    // Clean up this test's data
    await db.delete(dataEntries).where(eq(dataEntries.dataSetId, dataset.id));
    await db.delete(dataSets).where(eq(dataSets.id, dataset.id));
    await db.delete(authUsers).where(eq(authUsers.id, ownerId));
  });

  // ── 3. Existing RLS policy checks ──
  it("rls-policies.sql should enable RLS on data_entries", async () => {
    const file = Bun.file("src/db/rls-policies.sql");
    const text = await file.text();
    expect(text).toContain("data_entries ENABLE ROW LEVEL SECURITY");
  });

  it("rls-policies.sql should reference current_setting app.current_user_id", async () => {
    const file = Bun.file("src/db/rls-policies.sql");
    const text = await file.text();
    expect(text).toContain("owner_id = current_setting('app.current_user_id', true)");
  });

  // ── 4. Default policy on dataset creation ──
  it("crud.ts should set enableRLS: true in default policyJson", async () => {
    const file = Bun.file("src/routes/crud.ts");
    const text = await file.text();
    expect(text).toContain("enableRLS: true");
  });
});
