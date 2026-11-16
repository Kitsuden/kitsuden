/**
 * Agent token benchmark — what an agent's context pays for talking to this API
 * ============================================================================
 *
 * Measures, on the API in this checkout and a TEST database, the text a model
 * would read: `tools/list`, tool results and the agent guide (`/llms.txt`). It
 * prints JSON, so two checkouts (before / after a change) can be compared:
 *
 *   npm install --prefix scripts/bench/.tools js-tiktoken@1.0.21 --save-exact --no-fund --no-audit
 *   cd apps/api
 *   node ../../scripts/test-db.mjs exec -- bun run scripts/bench-agent-tokens.ts > after.json
 *
 * It creates one admin, one agent and one 100-row dataset in the test database
 * (`scripts/test-db.mjs exec` refuses anything that does not look like one) and
 * calls the app in process, so it needs no running server.
 *
 * ── WHAT THE TOKENS ARE ─────────────────────────────────────────────────────
 *
 * Counted offline with js-tiktoken (`o200k_base`, `cl100k_base`). They are NOT
 * Claude's tokenizer, which is not available offline: expect Claude to count
 * somewhat more, with the same ratios (docs/agents/benchmarks.md §1). Without
 * js-tiktoken the script falls back to characters ÷ 3.06 and says so.
 */

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";

import { db } from "../src/db";
import { agentIdentities, dataEntries, dataSets } from "../src/db/schema";
import { app } from "../src/index";
import { enterAs, generateTestId } from "../src/tests/setup";

const TOOLS_DIR =
  process.env.BENCH_TOOLS_DIR ?? resolve(import.meta.dir, "../../../scripts/bench/.tools");

type Counter = { name: string; count: (text: string) => number };

async function counters(): Promise<{ list: Counter[]; exact: boolean }> {
  try {
    const require = createRequire(join(TOOLS_DIR, "package.json"));
    const mod = await import(pathToFileURL(require.resolve("js-tiktoken")).href);
    const get = (mod.getEncoding ?? mod.default?.getEncoding) as (n: string) => {
      encode: (t: string) => unknown[];
    };
    return {
      exact: true,
      list: ["o200k_base", "cl100k_base"].map((name) => {
        const enc = get(name);
        return { name, count: (t: string) => enc.encode(t).length };
      }),
    };
  } catch {
    return {
      exact: false,
      list: [{ name: "chars/3.06 (estimate)", count: (t) => Math.round(t.length / 3.06) }],
    };
  }
}

function req(path: string, init: RequestInit = {}, cookie?: string, bearer?: string): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, { ...init, headers });
}

async function mcpSession(token: string, query = ""): Promise<string> {
  const res = await app.request(
    req(
      `/api/mcp${query}`,
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
      },
      undefined,
      token
    )
  );
  const id = res.headers.get("mcp-session-id");
  if (!id) throw new Error(`no MCP session (${res.status})`);
  return id;
}

async function rpc(session: string, token: string, method: string, params: unknown = {}) {
  // Streamable HTTP: the session travels in a header
  const res = await app.request(
    req(
      "/api/mcp",
      {
        method: "POST",
        headers: { "Mcp-Session-Id": session },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      undefined,
      token
    )
  );
  return (await res.json()) as any;
}

async function main() {
  // Measure the product's defaults: .env.test turns discovery mode off for the test suite.
  delete process.env.MCP_TOOLS_LIST_MAX_BYTES;
  delete process.env.MCP_RESULT_MAX_CHARS;
  const { list, exact } = await counters();
  const measure = (text: string) => ({
    bytes: Buffer.byteLength(text, "utf8"),
    tokens: Object.fromEntries(list.map((c) => [c.name, c.count(text)])),
  });

  const { cookie } = await enterAs(app, {
    email: `bench-${generateTestId()}@example.com`,
    password: "TestPassword123!",
    name: "Token bench",
    role: "admin",
  });
  const keyRes = await app.request(
    req("/api/keys", { method: "POST", body: JSON.stringify({ name: "Token bench" }) }, cookie)
  );
  const key = (await keyRes.json()) as { id: string; token: string };
  const slug = `bench-${generateTestId()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await db
    .update(agentIdentities)
    .set({ scopes: ["admin", "mcp:connect", "mcp:read", "mcp:write", "mcp:admin"] } as never)
    .where(eq(agentIdentities.id, key.id));
  const [ds] = await db
    .insert(dataSets)
    .values({ name: "Bench", slug, schema: { fields: [] } } as never)
    .returning();
  await db.insert(dataEntries).values(
    Array.from({ length: 100 }, (_, i) => ({
      dataSetId: ds!.id,
      title: `Item ${i}`,
      status: "published",
      data: {
        price: i,
        category: ["weapon", "armor", "ring"][i % 3],
        note: "A short description of the item with a few words in it. ".repeat(3).trim(),
      },
    })) as never
  );

  const result: Record<string, unknown> = {
    tokenizer: exact ? "js-tiktoken" : "estimate",
    note: "not Claude's tokenizer; expect Claude to count somewhat more",
  };

  // ── tools/list ────────────────────────────────────────────────────────────
  const toolsList: Record<string, unknown> = {};
  const lists: [string, string][] = [
    ["default (no toolset)", ""],
    ["all", "?toolset=all"],
    ["data", "?toolset=data"],
    ["core", "?toolset=core"],
    ["read", "?toolset=read"],
    ["kons", "?toolset=kons"],
  ];
  for (const [label, query] of lists) {
    const s = await mcpSession(key.token, query);
    const r = await rpc(s, key.token, "tools/list");
    const tools = (r.result?.tools ?? []) as { name: string }[];
    toolsList[label] = {
      tools: tools.length,
      mode: r.result?._meta?.["kitsuden/tools"]?.mode ?? "direct",
      ...measure(JSON.stringify(tools)),
    };
  }
  // The default again with a budget that this install does not reach, to show
  // what an installation over budget gets (a checkout without discovery mode
  // ignores the variable and returns the full list).
  const budget = process.env.MCP_TOOLS_LIST_MAX_BYTES;
  process.env.MCP_TOOLS_LIST_MAX_BYTES = "1";
  {
    const s = await mcpSession(key.token);
    const r = await rpc(s, key.token, "tools/list");
    const tools = (r.result?.tools ?? []) as { name: string }[];
    toolsList["default over budget (MCP_TOOLS_LIST_MAX_BYTES=1)"] = {
      tools: tools.length,
      mode: r.result?._meta?.["kitsuden/tools"]?.mode ?? "direct",
      ...measure(JSON.stringify(tools)),
    };
  }
  if (budget === undefined) delete process.env.MCP_TOOLS_LIST_MAX_BYTES;
  else process.env.MCP_TOOLS_LIST_MAX_BYTES = budget;
  result.toolsList = toolsList;

  // ── tool results ──────────────────────────────────────────────────────────
  const s = await mcpSession(key.token, "?toolset=data");
  const query = async (args: Record<string, unknown>) => {
    const r = await rpc(s, key.token, "tools/call", {
      name: "kitsuden_query_collection",
      arguments: { collection: slug, ...args },
    });
    const text = (r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r)) as string;
    let rows: number | null = null;
    try {
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed.length : null;
    } catch {
      /* TOON or TRON text */
    }
    return { rows, ...measure(text) };
  };
  result.queryResults = {
    "no limit, json": await query({ format: "json" }),
    "no limit, auto": await query({}),
    "limit 50, json": await query({ limit: 50, format: "json" }),
    "fields title+price, json": await query({ fields: ["title", "price"], format: "json" }),
    "fields title+price, auto": await query({ fields: ["title", "price"] }),
  };

  // ── agent guide ───────────────────────────────────────────────────────────
  const guide = async (path: string) => {
    const res = await app.request(req(path));
    return { status: res.status, ...measure(await res.text()) };
  };
  result.guide = {
    "/llms.txt": await guide("/llms.txt"),
    "/llms.txt?full=1": await guide("/llms.txt?full=1"),
    "/llms.txt?kon=blog": await guide("/llms.txt?kon=blog"),
  };

  await db.delete(dataSets).where(eq(dataSets.slug, slug));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
