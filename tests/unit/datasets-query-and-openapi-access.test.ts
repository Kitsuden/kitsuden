/**
 * Per-dataset and per-table queries, and the OpenAPI document
 * (security review 2026-11-04)
 * ============================================================================
 *
 * F70: `POST /api/datasets/:id/query` only looked at `policyJson`; a key with
 *      `["admin", "!datasets:secret:*"]` read what `/entries` denies it.
 * F71: `POST /api/datasets/query/:table` resolved `auth_*` tables outside the
 *      deny-list, and a `where`/`orderBy`/`select` on a secret column (or an
 *      `expand` to a forbidden table) was an oracle or a leak.
 * F11: `/api/docs/openapi.json`, without a session, described EVERY dataset.
 *
 * No database: `db` is a double that returns the rows each test sets, and the
 * query engine is a spy (what matters is whether it is called and what leaves).
 */
import { pgTable, text } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as realSchema from "../../apps/api/src/db/schema";

// ── `db` double: any select/from/where/limit chain ends in `rows` ──
const state = vi.hoisted(() => ({ rows: [] as unknown[] }));
function chain(): any {
  const c: any = {};
  for (const m of ["select", "from", "where", "limit", "orderBy", "offset"]) c[m] = () => c;
  c.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
    Promise.resolve(state.rows).then(ok, ko);
  return c;
}

const widgets = pgTable("kon_widgets", {
  id: text("id").primaryKey(),
  name: text("name"),
  apiToken: text("api_token"),
});
// Not in FORBIDDEN_TABLES: caught only by the `auth_*` rule.
const authPasskeys = pgTable("auth_passkeys", { id: text("id").primaryKey() });
const SCHEMA = {
  widgets,
  authPasskeys,
  authAccounts: realSchema.authAccounts,
  agentIdentities: realSchema.agentIdentities,
};

vi.mock("../../apps/api/src/db", () => ({ db: { select: () => chain() }, mergedSchema: SCHEMA }));
vi.mock("../../apps/api/src/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
const pass = async (_c: unknown, next: () => Promise<void>) => next();
vi.mock("../../apps/api/src/middleware/auth", () => ({ requireAuth: pass }));

const permissions = vi.hoisted(() => ({ read: true, write: true }));
vi.mock("../../apps/api/src/middleware/permissions", () => ({
  checkDatasetReadAccess: async () => permissions.read,
  checkDatasetWriteAccess: async () => permissions.write,
}));

const engine = vi.hoisted(() => ({
  parseKitsudenQuery: vi.fn(async () => ({
    data: [{ id: "w1", name: "one", apiToken: "LIVE-TOKEN" }],
    meta: { total: 1 },
  })),
}));
vi.mock("@kitsuden/engine", () => {
  class KitsudenQLError extends Error {
    code = "X";
    details = {};
  }
  class BatchProcessorError extends Error {}
  class BatchProcessor {
    async execute() {
      return { success: true, results: [] };
    }
  }
  return {
    parseKitsudenQuery: engine.parseKitsudenQuery,
    KitsudenQLError,
    BatchProcessorError,
    BatchProcessor,
    getAvailableRelations: () => [],
    validateKitsudenQuery: () => ({ valid: true }),
    debugQuery: () => ({ sql: "", params: [] }),
    resolveExecutor: (f: unknown) => f,
    isUuid: (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v),
  };
});

const { datasetsQueryRoutes, agentScopeAccess, nativeQueryProblem } =
  await import("../../apps/api/src/routes/datasets-query");
const { generateOpenAPISpec, datasetVisibleInDocs } =
  await import("../../apps/api/src/lib/openapi-aggregator");

const ID = "11111111-2222-3333-4444-555555555555";
const SECRET_DS = {
  id: ID,
  slug: "secret",
  policyJson: { readAccess: "authenticated", writeAccess: "authenticated" },
};

type Who = { user?: Record<string, unknown>; agent?: Record<string, unknown> };
const DENIED_AGENT: Who = {
  agent: { agentId: "ag", scopes: ["admin", "!datasets:secret:*"] },
  user: { id: "ag", role: "agent", scopes: ["admin", "!datasets:secret:*"] },
};
const ADMIN: Who = { user: { id: "u1", role: "admin" } };

function app(who: Who) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    if (who.user) c.set("user" as never, who.user as never);
    if (who.agent) c.set("agent" as never, who.agent as never);
    await next();
  });
  a.route("/api/datasets", datasetsQueryRoutes as never);
  return a;
}
const post = (who: Who, path: string, body: unknown) =>
  app(who).request(`/api/datasets${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.rows = [SECRET_DS];
  permissions.read = true;
  permissions.write = true;
  engine.parseKitsudenQuery.mockClear();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("F70: per-dataset scopes on /api/datasets/:id/query and neighbours", () => {
  it("the rule: denial, grant or nothing", () => {
    const ctx = (q: Who) => ({ get: (k: string) => (q as Record<string, unknown>)[k] });
    expect(agentScopeAccess(ctx(DENIED_AGENT), "secret", "read")).toBe("denied");
    expect(
      agentScopeAccess(
        ctx({ agent: { scopes: ["user:act", "datasets:secret:read"] } }),
        "secret",
        "read"
      )
    ).toBe("granted");
    expect(agentScopeAccess(ctx(ADMIN), "secret", "read")).toBeNull();
  });

  it("an agent's denial beats the policy (403, no query run)", async () => {
    const r = await post(DENIED_AGENT, `/${ID}/query`, {});
    expect(r.status).toBe(403);
    expect(engine.parseKitsudenQuery).not.toHaveBeenCalled();
  });

  it("an agent's grant opens even if the policy does not", async () => {
    permissions.read = false;
    const agent = {
      agent: { scopes: ["user:act", "datasets:secret:read"] },
      user: { id: "ag", role: "agent" },
    };
    expect((await post(agent, `/${ID}/query`, {})).status).toBe(200);
  });

  it("with scopes that say nothing, the policy decides as before", async () => {
    const person = { user: { id: "u2", role: "user" } };
    expect((await post(person, `/${ID}/query`, {})).status).toBe(200);
    permissions.read = false;
    expect((await post(person, `/${ID}/query`, {})).status).toBe(403);
  });

  it("GET /:id/relations: the denied dataset does not exist for it", async () => {
    const r = await app(DENIED_AGENT).request(`/api/datasets/${ID}/relations`);
    expect(r.status).toBe(404);
    expect((await app(ADMIN).request(`/api/datasets/${ID}/relations`)).status).toBe(200);
  });

  it("batch: the agent's denial beats its `admin` scope", async () => {
    const body = {
      operations: [{ op: "create", table: "dataEntries", data: { dataSetId: ID, data: {} } }],
    };
    expect((await post(DENIED_AGENT, "/batch", body)).status).toBe(403);
    expect((await post(ADMIN, "/batch", body)).status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("F71: /api/datasets/query/:table", () => {
  it("a forbidden table does not exist, not even in the available list", async () => {
    for (const name of ["authAccounts", "authPasskeys"]) {
      const r = await post(ADMIN, `/query/${name}`, {});
      expect(r.status, name).toBe(400);
      const body = (await r.json()) as { availableTables: string[] };
      expect(body.availableTables).toContain("widgets");
      expect(body.availableTables).not.toContain("authAccounts");
      expect(body.availableTables).not.toContain("authPasskeys");
    }
    expect(engine.parseKitsudenQuery).not.toHaveBeenCalled();
  });

  it("secret columns do not leave", async () => {
    const r = await post(ADMIN, "/query/widgets", {});
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("one");
    expect(text).not.toContain("LIVE-TOKEN");
  });

  it("no filtering, sorting or selecting by a secret column", async () => {
    for (const body of [
      { where: { apiToken: { eq: "x" } } },
      { where: { OR: [{ name: { eq: "a" } }, { NOT: { apiToken: { startsWith: "T" } } }] } },
      { orderBy: [{ field: "apiToken" }] },
      { select: ["id", "apiToken"] },
    ]) {
      const r = await post(ADMIN, "/query/widgets", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(engine.parseKitsudenQuery).not.toHaveBeenCalled();
  });

  it("an expand towards a forbidden table is refused", () => {
    expect(
      nativeQueryProblem(realSchema.agentIdentities as never, { expand: ["apiKeys"] })
    ).toMatch(/expanded/);
    expect(
      nativeQueryProblem(realSchema.agentIdentities as never, { expand: ["traces"] })
    ).toBeNull();
  });

  it("validate-query does not resolve forbidden tables either", async () => {
    expect((await post(ADMIN, "/validate-query/authAccounts", {})).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("F11: the OpenAPI document only describes what the caller can read", () => {
  const DATASETS = [
    {
      id: "a",
      name: "Public",
      slug: "public",
      description: null,
      schema: [],
      policyJson: { readAccess: "public" },
    },
    {
      id: "b",
      name: "With session",
      slug: "withsession",
      description: null,
      schema: [],
      policyJson: { readAccess: "authenticated" },
    },
    {
      id: "c",
      name: "Internal",
      slug: "internal",
      description: null,
      schema: [],
      policyJson: { readAccess: "admin" },
    },
    {
      id: "d",
      name: "No policy",
      slug: "nopolicy",
      description: null,
      schema: [],
      policyJson: null,
    },
  ];
  const slugs = async (user?: Record<string, unknown> | null) => {
    state.rows = DATASETS;
    const spec = await generateOpenAPISpec([], user === undefined ? {} : { user: user as never });
    return Object.keys(spec.components!.schemas!)
      .filter((k) => k.startsWith("Dataset_"))
      .map((k) => k.slice("Dataset_".length))
      .sort();
  };

  it("anonymous: only the public ones (also without passing an identity)", async () => {
    expect(await slugs()).toEqual(["public"]);
    expect(await slugs(null)).toEqual(["public"]);
  });

  it("with a session: public and `authenticated`", async () => {
    expect(await slugs({ id: "u", role: "user" })).toEqual(["public", "withsession"]);
  });

  it("the team sees them all", async () => {
    expect(await slugs({ id: "u", role: "admin" })).toEqual([
      "internal",
      "nopolicy",
      "public",
      "withsession",
    ]);
  });

  it("the /items/<slug> paths follow the same filter", async () => {
    state.rows = DATASETS;
    const spec = await generateOpenAPISpec([], {});
    expect(spec.paths!["/items/public"]).toBeDefined();
    expect(spec.paths!["/items/internal"]).toBeUndefined();
  });

  it("an agent's per-dataset scopes decide first", () => {
    const agent = { id: "ag", role: "agent", scopes: ["admin", "!datasets:internal:*"] };
    expect(
      datasetVisibleInDocs(
        { slug: "internal", policyJson: { readAccess: "public" } },
        agent as never
      )
    ).toBe(false);
    const granted = { id: "ag", role: "agent", scopes: ["datasets:internal:read"] };
    expect(
      datasetVisibleInDocs(
        { slug: "internal", policyJson: { readAccess: "admin" } },
        granted as never
      )
    ).toBe(true);
  });
});
