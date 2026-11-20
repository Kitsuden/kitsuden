/**
 * Tool discovery, result cap and field projection — no database
 * ============================================================================
 *
 * lib/tool-discovery.ts. The route wiring (discovery mode in `tools/list`,
 * `kitsuden_call_tool` going through the same checks) is tested against the real
 * MCP route in src/tests/mcp-tool-discovery.test.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { mentionsAll } from "../lib/mcp-settings";
import {
  CALL_TOOL,
  FIND_TOOL,
  META_TRUNCATED,
  capToolResult,
  definitionBytes,
  isDiscoveryTool,
  listBudgetBytes,
  projectFields,
  resultMaxChars,
  searchTools,
  stableOrder,
  toolGroup,
  toolOverview,
  useDiscovery,
  type ToolDefinition,
} from "../lib/tool-discovery";

const TOOLS: ToolDefinition[] = [
  { name: "blog__create-post", description: "Create a blog post as a draft." },
  { name: "blog__list-posts", description: "List blog posts, newest first." },
  { name: "esports__report-set", description: "Report the winner of a tournament set." },
  { name: "kitsuden_query_collection", description: "Query records from any collection." },
  { name: "kitsuden_create_record", description: "Insert a record into any collection." },
  { name: "ext_github_search", description: "Search GitHub issues." },
  { name: "send_welcome", description: "Engine action that sends a welcome email." },
];

const env = { ...process.env };
afterEach(() => {
  // In place: modules may keep a reference to the object.
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});

describe("budgets", () => {
  it("defaults, a 0 that turns the mode off, and garbage that falls back", () => {
    delete process.env.MCP_TOOLS_LIST_MAX_BYTES;
    delete process.env.MCP_RESULT_MAX_CHARS;
    expect(listBudgetBytes()).toBe(64_000);
    expect(resultMaxChars()).toBe(100_000);
    process.env.MCP_TOOLS_LIST_MAX_BYTES = "0";
    expect(listBudgetBytes()).toBe(0);
    expect(useDiscovery(TOOLS)).toBe(false);
    process.env.MCP_TOOLS_LIST_MAX_BYTES = "nope";
    expect(listBudgetBytes()).toBe(64_000);
  });

  it("discovery only when the definitions are over the budget", () => {
    const bytes = definitionBytes(TOOLS);
    expect(useDiscovery(TOOLS, bytes)).toBe(false);
    expect(useDiscovery(TOOLS, bytes - 1)).toBe(true);
    expect(useDiscovery(TOOLS, 0)).toBe(false);
  });

  it("an explicit `all` is told apart from no toolset", () => {
    expect(mentionsAll("all")).toBe(true);
    expect(mentionsAll("read, ALL")).toBe(true);
    expect(mentionsAll("")).toBe(false);
    expect(mentionsAll(undefined)).toBe(false);
    expect(mentionsAll("kon:all-things")).toBe(false);
  });
});

describe("search and overview", () => {
  it("name matches outrank description matches; ties go by name", () => {
    const found = searchTools(TOOLS, "create post").map((t) => t.name);
    expect(found[0]).toBe("blog__create-post");
    expect(found).toContain("kitsuden_create_record");
    expect(searchTools(TOOLS, "tournament").map((t) => t.name)).toEqual(["esports__report-set"]);
  });

  it("no words, no match; the limit is capped", () => {
    expect(searchTools(TOOLS, "  ")).toEqual([]);
    expect(searchTools(TOOLS, "zzz")).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `x__tool-${i}`, description: "x" }));
    expect(searchTools(many, "tool", 500)).toHaveLength(20);
  });

  it("groups: kons by id, core, external and engine actions", () => {
    expect(toolGroup("blog__create-post")).toBe("kon:blog");
    expect(toolGroup("kitsuden_query_collection")).toBe("core");
    expect(toolGroup("ext_github_search")).toBe("external");
    expect(toolGroup("send_welcome")).toBe("actions");
    const o = toolOverview(TOOLS);
    expect(o.total).toBe(TOOLS.length);
    expect(o.groups.map((g) => g.group)).toEqual([
      "actions",
      "core",
      "external",
      "kon:blog",
      "kon:esports",
    ]);
    expect(o.groups.find((g) => g.group === "kon:blog")!.count).toBe(2);
  });

  it("stable order: the same set always lists the same way", () => {
    const shuffled = [...TOOLS].reverse();
    expect(stableOrder(shuffled).map((t) => t.name)).toEqual(stableOrder(TOOLS).map((t) => t.name));
  });

  it("the discovery tools are recognised", () => {
    expect(isDiscoveryTool(FIND_TOOL)).toBe(true);
    expect(isDiscoveryTool(CALL_TOOL)).toBe(true);
    expect(isDiscoveryTool("kitsuden_query_collection")).toBe(false);
  });
});

describe("result cap", () => {
  const response = (text: string) => ({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text }], structuredContent: { big: true } },
  });

  it("a result that fits is returned as it came", () => {
    const r = response("short");
    expect(capToolResult(r, 100)).toBe(r);
    expect(capToolResult(r, 0)).toBe(r);
  });

  it("a long one is cut, says so, and loses structuredContent", () => {
    const r = capToolResult(response("x".repeat(500)), 100) as any;
    expect(r.result.content[0].text).toHaveLength(100);
    expect(r.result.content[1].text).toContain("100 of 500 characters");
    expect(r.result.structuredContent).toBeUndefined();
    expect(r.result._meta[META_TRUNCATED]).toEqual({ shownChars: 100, totalChars: 500 });
    expect(r.id).toBe(1);
  });

  it("an error response (no content) is left alone", () => {
    const e = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x".repeat(500) } };
    expect(capToolResult(e, 10)).toBe(e);
  });
});

describe("field projection", () => {
  const rows = [
    { id: "1", title: "A", status: "published", data: { price: 3, secret: "s" } },
    { id: "2", title: "B", status: "draft", data: { price: 5 } },
  ];

  it("keeps id and the asked keys, from the row or its data", () => {
    expect(projectFields(rows, ["title", "price"])).toEqual([
      { id: "1", title: "A", price: 3 },
      { id: "2", title: "B", price: 5 },
    ]);
  });

  it("no fields = the rows unchanged; unknown keys are just absent", () => {
    expect(projectFields(rows, undefined)).toEqual(rows);
    expect(projectFields(rows, ["nope"])).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("never reads the prototype", () => {
    const out = projectFields(rows, ["__proto__", "constructor", "toString"]);
    expect(out).toEqual([{ id: "1" }, { id: "2" }]);
  });
});
