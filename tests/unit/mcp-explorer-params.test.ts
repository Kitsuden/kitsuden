/**
 * The standalone MCP server's `kitsuden_query_table` passes search and several filters
 * through to GET /api/explorer/:table in the API's own syntax.
 */
import { describe, expect, it } from "vitest";

import { queryTableParams } from "../../packages/mcp-server/src/explorer-params";

describe("kitsuden_query_table query string", () => {
  it("sends search, search_fields and one filter[...] per condition", () => {
    const p = queryTableParams({
      limit: 500,
      search: "ana",
      search_fields: ["name", "email"],
      filters: { status: "draft", created_at: { gte: "2026-01-01", lt: "2026-02-01" }, n: 3 },
    });
    expect(p.get("limit")).toBe("100");
    expect(p.get("page")).toBe("1");
    expect(p.get("search")).toBe("ana");
    expect(p.get("search_fields")).toBe("name,email");
    expect(p.get("filter[status]")).toBe("draft");
    expect(p.get("filter[created_at][gte]")).toBe("2026-01-01");
    expect(p.get("filter[created_at][lt]")).toBe("2026-02-01");
    expect(p.get("filter[n]")).toBe("3");
  });

  it("keeps the older single filter, and sends nothing that was not asked for", () => {
    const p = queryTableParams({
      search_fields: "title",
      filter_field: "email",
      filter_op: "contains",
      filter_value: "@x",
    });
    expect(p.get("search_fields")).toBe("title");
    expect(p.get("filter_field")).toBe("email");
    expect(p.get("filter_op")).toBe("contains");
    expect(p.get("filter_value")).toBe("@x");
    expect(p.has("search")).toBe(false);
    expect([...p.keys()].some((k) => k.startsWith("filter["))).toBe(false);
  });
});
