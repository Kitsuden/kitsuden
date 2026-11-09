/**
 * Items Routes — Unit Tests
 *
 * Covers all extracted handlers in items.ts with mocked DB and dependencies.
 */

import * as realEngine from "@kitsuden/engine";
import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";

import { createMockContext, getLastJsonResponse } from "../tests/mock-context";

// The REAL engine, captured before `mock.module` patches the registry.
// It is re-exported whole in the mock below — see the note there.

// ─── Configurable DB proxy ──────────────────────────────────────────────────
let selectResults: any[] = [];
let insertResult: any[] = [];
let updateResult: any[] = [];
let deleteResult: any[] = [];
let selectCallIndex = 0;
let insertCallIndex = 0;
let updateCallIndex = 0;
let deleteCallIndex = 0;

function createDbProxy(result: any): any {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: any) => resolve(result);
      }
      return createDbProxy(result);
    },
    apply(_target, _thisArg, _args) {
      return createDbProxy(result);
    },
  });
}

function getNextSelectResult() {
  return selectResults[selectCallIndex++] || [];
}
function getNextInsertResult() {
  return insertResult;
}
function getNextUpdateResult() {
  return updateResult;
}
function getNextDeleteResult() {
  return deleteResult;
}

const mockDb = {
  select: mock(() => createDbProxy(getNextSelectResult())),
  insert: mock(() => createDbProxy(getNextInsertResult())),
  update: mock(() => createDbProxy(getNextUpdateResult())),
  delete: mock(() => createDbProxy(getNextDeleteResult())),
};

const mockNativeTable = {
  id: "id_col",
  createdAt: "createdAt_col",
  status: "status_col",
  [Symbol.for("drizzle:Name")]: "users",
};

let queryBehavior: any = { type: "resolve", value: { docs: [] } };
const mockParseQuery = mock(() => {
  if (queryBehavior.type === "reject") {
    return Promise.reject(queryBehavior.error);
  }
  return Promise.resolve(queryBehavior.value);
});

mock.module("../db", () => ({
  db: mockDb,
  mergedSchema: { users: mockNativeTable },
}));
mock.module("../db/schema-core", () => ({
  dataSets: { slug: "slug_col", id: "id_col" },
  dataEntries: {
    id: "id_col",
    dataSetId: "dataSetId_col",
    createdAt: "createdAt_col",
    title: "title_col",
    data: "data_col",
  },
}));
mock.module("drizzle-orm", () => ({
  eq: () => "eq",
  and: () => "and",
  // `sql` MUST keep `.raw` (mock.module is global in bun).
  sql: Object.assign(() => "sql", { raw: (s: string) => s }),
  desc: () => "desc",
  asc: () => "asc",
  ilike: () => "ilike",
  gt: () => "gt",
  gte: () => "gte",
  lt: () => "lt",
  lte: () => "lte",
  inArray: () => "inArray",
  count: () => "count",
}));
mock.module("@kitsuden/engine", () => {
  class KitsudenQLError extends Error {
    code: string;
    details?: any;
    constructor(message: string, code?: string, details?: any) {
      super(message);
      this.code = code || "QUERY_ERROR";
      this.details = details;
    }
  }
  // `mock.module` in bun REPLACES the whole module and is global and
  // irreversible: returning only these two symbols left `@kitsuden/engine`
  // without `repo`, `can` or `validateRequest` for ANY test file that
  // ran afterwards — that is, for every kon that uses the clean stack.
  // Re-exporting the real module and overriding only what this file needs
  // keeps the isolation without breaking the others.
  return {
    ...realEngine,
    parseKitsudenQuery: mockParseQuery,
    KitsudenQLError,
  };
});
mock.module("../lib/logger", () => ({
  logger: { error: mock(() => {}), info: mock(() => {}) },
}));
mock.module("../lib/realtime", () => ({
  broadcastMutation: mock(() => {}),
}));
mock.module("./graphql", () => ({
  invalidateGraphQLCache: mock(() => Promise.resolve()),
}));

// Import under test AFTER mocks
import {
  queryItemsHandler,
  listItemsHandler,
  getItemHandler,
  createItemHandler,
  updateItemHandler,
  deleteItemHandler,
} from "../routes/items";

import { parseKitsudenQuery, KitsudenQLError } from "@kitsuden/engine";

afterAll(() => mock.restore());

beforeEach(() => {
  selectResults = [];
  insertResult = [];
  updateResult = [];
  deleteResult = [];
  selectCallIndex = 0;
  insertCallIndex = 0;
  updateCallIndex = 0;
  deleteCallIndex = 0;
  queryBehavior = { type: "resolve", value: { docs: [] } };
});

// ═════════════════════════════════════════════════════════════════════════════
// queryItemsHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("queryItemsHandler", () => {
  it("returns 404 for unknown collection", async () => {
    selectResults = [[]]; // no dataset found
    const c = createMockContext({ params: { collection: "unknown" }, body: {} });
    const res = await queryItemsHandler(c);
    expect(res.status).toBe(404);
    const data: any = await res.json();
    expect(data.error).toContain("Collection not found");
  });

  it("queries dataset via parseKitsudenQuery", async () => {
    selectResults = [[{ id: "ds1", slug: "posts" }]];
    (parseKitsudenQuery as any).mockReset?.();
    const c = createMockContext({
      params: { collection: "posts" },
      body: { where: { status: "published" } },
    });
    const res = await queryItemsHandler(c);
    expect(res.status).toBe(200);
  });

  it("queries native table via parseKitsudenQuery", async () => {
    selectResults = [[]]; // no dataset, falls back to native
    const c = createMockContext({ params: { collection: "users" }, body: {} });
    const res = await queryItemsHandler(c);
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// listItemsHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("listItemsHandler", () => {
  it("returns 404 for unknown collection", async () => {
    selectResults = [[]];
    const c = createMockContext({ params: { collection: "unknown" } });
    const res = await listItemsHandler(c);
    expect(res.status).toBe(404);
  });

  it("lists dataset entries with pagination", async () => {
    selectResults = [
      [{ id: "ds1", slug: "posts" }],
      [{ id: "e1", data: { title: "Hello" }, dataSetId: "ds1", createdAt: new Date() }],
      [{ value: 5 }],
    ];
    const c = createMockContext({
      params: { collection: "posts" },
      query: { limit: "10", offset: "0" },
    });
    const res = await listItemsHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.docs.length).toBe(1);
    expect(data.totalDocs).toBe(5);
  });

  it("lists native table entries with where and sort", async () => {
    selectResults = [
      [], // no dataset
      [{ id: "u1", name: "Alice" }],
      [{ value: 1 }],
    ];
    const c = createMockContext({
      params: { collection: "users" },
      query: { where: '{"status":"active"}', sort: "-createdAt" },
    });
    const res = await listItemsHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.docs.length).toBe(1);
  });

  it("handles invalid where JSON gracefully", async () => {
    selectResults = [
      [{ id: "ds1", slug: "posts" }],
      [{ id: "e1", data: {}, dataSetId: "ds1", createdAt: new Date() }],
      [{ value: 1 }],
    ];
    const c = createMockContext({ params: { collection: "posts" }, query: { where: "not-json" } });
    const res = await listItemsHandler(c);
    expect(res.status).toBe(200);
  });

  it("returns 500 on DB error", async () => {
    selectResults = [[{ id: "ds1", slug: "posts" }], Promise.reject(new Error("db fail"))];
    const c = createMockContext({ params: { collection: "posts" } });
    const res = await listItemsHandler(c);
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getItemHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("getItemHandler", () => {
  it("returns 404 for unknown collection", async () => {
    selectResults = [[]];
    const c = createMockContext({ params: { collection: "unknown", id: "1" } });
    const res = await getItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("returns dataset entry by id", async () => {
    selectResults = [
      [{ id: "ds1", slug: "posts" }],
      [{ id: "e1", data: { title: "Hello" }, dataSetId: "ds1", createdAt: new Date() }],
    ];
    const c = createMockContext({ params: { collection: "posts", id: "e1" } });
    const res = await getItemHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.id).toBe("e1");
    expect(data.title).toBe("Hello");
  });

  it("returns 404 when dataset entry not found", async () => {
    selectResults = [[{ id: "ds1", slug: "posts" }], []];
    const c = createMockContext({ params: { collection: "posts", id: "missing" } });
    const res = await getItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("returns native table doc by id", async () => {
    selectResults = [[], [{ id: "u1", name: "Alice" }]];
    const c = createMockContext({ params: { collection: "users", id: "u1" } });
    const res = await getItemHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.id).toBe("u1");
  });

  it("returns 404 when native doc not found", async () => {
    selectResults = [[], []];
    const c = createMockContext({ params: { collection: "users", id: "missing" } });
    const res = await getItemHandler(c);
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createItemHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("createItemHandler", () => {
  it("returns 404 for unknown collection", async () => {
    selectResults = [[]];
    const c = createMockContext({ params: { collection: "unknown" }, body: {} });
    const res = await createItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("creates dataset entry", async () => {
    selectResults = [[{ id: "ds1", slug: "posts" }]];
    insertResult = [{ id: "e1", dataSetId: "ds1", data: { title: "New" } }];
    const c = createMockContext({ params: { collection: "posts" }, body: { title: "New" } });
    const res = await createItemHandler(c);
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.id).toBe("e1");
  });

  it("creates native table entry", async () => {
    selectResults = [[]];
    insertResult = [{ id: "u1", name: "Bob" }];
    const c = createMockContext({ params: { collection: "users" }, body: { name: "Bob" } });
    const res = await createItemHandler(c);
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.id).toBe("u1");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// updateItemHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("updateItemHandler", () => {
  it("returns 404 for unknown collection", async () => {
    selectResults = [[]];
    const c = createMockContext({ params: { collection: "unknown", id: "1" }, body: {} });
    const res = await updateItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("updates dataset entry", async () => {
    selectResults = [
      [{ id: "ds1", slug: "posts" }],
      [{ id: "e1", data: { title: "Old" }, dataSetId: "ds1", createdAt: new Date(), title: "Old" }],
    ];
    updateResult = [{ id: "e1", data: { title: "Updated" }, dataSetId: "ds1" }];
    const c = createMockContext({
      params: { collection: "posts", id: "e1" },
      body: { title: "Updated" },
    });
    const res = await updateItemHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.id).toBe("e1");
  });

  it("returns 404 when dataset entry not found", async () => {
    selectResults = [[{ id: "ds1", slug: "posts" }], []];
    const c = createMockContext({ params: { collection: "posts", id: "missing" }, body: {} });
    const res = await updateItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("updates native table entry", async () => {
    selectResults = [[], [{ id: "u1", name: "Alice" }]];
    updateResult = [{ id: "u1", name: "Alicia" }];
    const c = createMockContext({
      params: { collection: "users", id: "u1" },
      body: { name: "Alicia" },
    });
    const res = await updateItemHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.name).toBe("Alicia");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// deleteItemHandler
// ═════════════════════════════════════════════════════════════════════════════

describe("deleteItemHandler", () => {
  it("returns 404 for unknown collection", async () => {
    selectResults = [[]];
    const c = createMockContext({ params: { collection: "unknown", id: "1" } });
    const res = await deleteItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("deletes dataset entry", async () => {
    selectResults = [
      [{ id: "ds1", slug: "posts" }],
      [{ id: "e1", data: {}, dataSetId: "ds1", createdAt: new Date() }],
    ];
    deleteResult = [];
    const c = createMockContext({ params: { collection: "posts", id: "e1" } });
    const res = await deleteItemHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
  });

  it("returns 404 when dataset entry not found", async () => {
    selectResults = [[{ id: "ds1", slug: "posts" }], []];
    const c = createMockContext({ params: { collection: "posts", id: "missing" } });
    const res = await deleteItemHandler(c);
    expect(res.status).toBe(404);
  });

  it("deletes native table entry", async () => {
    selectResults = [[], [{ id: "u1", name: "Alice" }]];
    deleteResult = [];
    const c = createMockContext({ params: { collection: "users", id: "u1" } });
    const res = await deleteItemHandler(c);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
  });
});
