/**
 * Dataset entries — isolation by owner (regression of the RLS route mismatch)
 * ============================================================================
 * BUG FIXED: `GET /:id/entries` filtered ONLY by dataSetId,
 * with the global `db` and without checking `policyJson`. Any user (even
 * anonymous) saw everyone's entries. It affected BOTH paths:
 *   - apps/api/src/routes/crud.ts        (Data Sets Lite)
 *   - packages/core/datasets/    (the real kon)
 * In addition `withTransactionalRLS()` was mounted on `/api/datasets/*` (without
 * the hyphen) while the real route is `/api/data-sets` → so no Level 2 either.
 *
 * Pure tests of the helper that does the isolation + static guards that
 * the handlers use it (see the test suite caveats: we avoid mockable runtime).
 */

import { describe, expect, test } from "bun:test";

import { buildDatasetWhere, checkReadAccess } from "../lib/rls-builder";
import type { PolicyJson, RLSRule, RLSUser } from "../lib/rls-builder";

const OWNER_RULE: RLSRule[] = [{ field: "ownerId", operator: "eq", value: "{{current_user_id}}" }];

const alice: RLSUser = { id: "user-alice", role: "user" };
const admin: RLSUser = { id: "user-admin", role: "admin" };

describe("checkReadAccess — read gate", () => {
  test("no policy → admin only (deny-by-default)", () => {
    expect(checkReadAccess(null, null)).toBe(false);
    expect(checkReadAccess(null, alice)).toBe(false);
    expect(checkReadAccess(null, admin)).toBe(true);
  });

  test("authenticated → rejects anonymous, accepts logged-in", () => {
    const policy = { readAccess: "authenticated" } as PolicyJson;
    expect(checkReadAccess(policy, null)).toBe(false);
    expect(checkReadAccess(policy, alice)).toBe(true);
  });

  test("public → accepts anonymous (CMS case)", () => {
    expect(checkReadAccess({ readAccess: "public" } as PolicyJson, null)).toBe(true);
  });

  test("admin → admin only", () => {
    const policy = { readAccess: "admin" } as PolicyJson;
    expect(checkReadAccess(policy, alice)).toBe(false);
    expect(checkReadAccess(policy, admin)).toBe(true);
  });
});

describe("buildDatasetWhere — isolation filter", () => {
  test("with owner rlsRules it produces a WHERE with RLS", () => {
    const { where, hasRLS } = buildDatasetWhere("ds-1", OWNER_RULE, alice);
    expect(hasRLS).toBe(true);
    expect(where).toBeDefined();
  });

  test("without rlsRules it only filters by dataset (hasRLS=false)", () => {
    const { where, hasRLS } = buildDatasetWhere("ds-1", undefined, alice);
    expect(hasRLS).toBe(false);
    expect(where).toBeDefined();
  });

  test("the WHERE is never undefined — all entries are never listed", () => {
    for (const user of [alice, admin, null as unknown as RLSUser]) {
      for (const rules of [OWNER_RULE, undefined]) {
        expect(buildDatasetWhere("ds-1", rules, user).where).toBeDefined();
      }
    }
  });
});

describe("Static guards — the handlers apply the policy", () => {
  test("crud.ts GET /:id/entries uses checkReadAccess + buildDatasetWhere", async () => {
    const source = await Bun.file(`${import.meta.dir}/../routes/crud.ts`).text();
    // `readable()` first looks at the agent's per-dataset scopes and, if
    // they say nothing, at the policy with checkReadAccess.
    expect(source).toContain("if (!readable(dataset, user)) {");
    expect(source).toContain(
      "return checkReadAccess((dataset.policyJson ?? null) as PolicyJson | null, user);"
    );
    expect(source).toContain("buildDatasetWhere(datasetId, policy?.rlsRules, user)");
    // The naive filter by dataSetId alone must no longer exist.
    expect(source).not.toMatch(
      /\.from\(dataEntries\)\s*\n\s*\.where\(eq\(dataEntries\.dataSetId, c\.req\.param\("id"\)\)\)/
    );
  });

  test("crud.ts runs on the request-scope executor (RLS tx)", async () => {
    const source = await Bun.file(`${import.meta.dir}/../routes/crud.ts`).text();
    expect(source).toContain("resolveExecutor(db)");
  });

  test("withTransactionalRLS covers /api/data-sets (not only /api/datasets)", async () => {
    const source = await Bun.file(`${import.meta.dir}/../index.ts`).text();
    expect(source).toContain('app.use("/api/data-sets/:id/entries", withTransactionalRLS())');
    expect(source).toContain('app.use("/api/data-sets/:slug/entries", withTransactionalRLS())');
  });
});
