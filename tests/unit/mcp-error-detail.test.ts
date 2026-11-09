/**
 * Over MCP, a kon's 5xx does not hand its internal message to the model
 * ============================================================================
 *
 * Security review 2026-11-03: REST masks the detail of 5xx in production for
 * whoever is not admin (`errorsWithoutDetail`), but the pipeline that runs SDK
 * operations as MCP tools (`lib/operations-mcp.ts`) did not mount it, so a kon
 * that answered `{ message: err.message }` with a 500 handed the SQL to the agent.
 *
 * Now the pipeline mounts the same middleware, and `withoutServerDetail` is the
 * last net for what it cannot see (a problem+json the kon built itself, a
 * flow's `error` event inside a 200). 4xx keep their message.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildProblem } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

import { withoutServerDetail } from "../../apps/api/src/lib/problems-mcp";

const SQL = 'Failed query: select * from "auth_users" where email = $1';

describe("withoutServerDetail", () => {
  const internal = buildProblem({
    code: "KITSUDEN_E_INTERNAL",
    status: 500,
    detail: SQL,
    instance: "/api/mcp",
    requestId: "req-1",
    extensions: { query: SQL },
  });

  it("production, agent without admin: code, status and requestId stay, the detail goes", () => {
    const p = withoutServerDetail(internal, ["mcp:connect", "kon:blog:write"], true);
    expect(p.status).toBe(500);
    expect(p.code).toBe("KITSUDEN_E_INTERNAL");
    expect(p.requestId).toBe("req-1");
    expect(JSON.stringify(p)).not.toContain("auth_users");
  });

  it("a 503 keeps its code and its wait", () => {
    const busy = buildProblem({
      code: "KITSUDEN_E_UNAVAILABLE",
      status: 503,
      detail: "pool exhausted on db.internal:5432",
      retryAfter: 7,
    });
    const p = withoutServerDetail(busy, [], true);
    expect(p.code).toBe("KITSUDEN_E_UNAVAILABLE");
    expect(p.retry_after).toBe(7);
    expect(JSON.stringify(p)).not.toContain("db.internal");
  });

  it("an agent with admin, and any agent outside production, still see it", () => {
    expect(withoutServerDetail(internal, ["admin"], true).detail).toBe(SQL);
    expect(withoutServerDetail(internal, [], false).detail).toBe(SQL);
  });

  it("4xx keep their message: it tells the agent what to fix", () => {
    const bad = buildProblem({ code: "KITSUDEN_E_VALIDATION", detail: "title is required" });
    expect(withoutServerDetail(bad, [], true)).toBe(bad);
  });
});

describe("the MCP operations pipeline mounts the REST net", () => {
  it("errorsWithoutDetail inside httpProblems, and every error result goes through the net", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "apps", "api", "src", "lib", "operations-mcp.ts"),
      "utf8"
    );
    const pipeline = src.slice(src.indexOf("function buildPipeline"));
    const problems = pipeline.indexOf("httpProblems()");
    const net = pipeline.indexOf("errorsWithoutDetail(inProduction)");
    const routes = pipeline.indexOf("mountedOperations()");
    expect(problems).toBeGreaterThan(-1);
    expect(net).toBeGreaterThan(problems);
    expect(routes).toBeGreaterThan(net);
    const run = src.slice(src.indexOf("export async function runOperationTool"));
    expect(run.match(/withoutServerDetail\(/g)?.length).toBe(2);
  });
});
