/**
 * MCP: tools whose permission is checked in the handler
 * ============================================================================
 *
 * Seventeen kons check their policy in the handler (`policy.inHandler`). The MCP
 * advertised all of those tools to every agent, so a read-only agent searching
 * for "comment" was offered `comments__create-comment` and got 403 calling it.
 * (Found by the 2026-11-19 web app test.)
 *
 * Now a rule that does not read the resource — `create: (user) => …`, which
 * the handler checks with `h.can({})` — is checked when listing, like any other
 * permission. A rule that reads it — `update: (user, item) => …` — is still
 * advertised, because only the call can decide it.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/api/src/db", () => ({ db: {}, mergedSchema: {}, isPgMem: false }));

import { definePolicy, policyReadsResource } from "../../packages/engine/src/authz";
import { registerMountedOperations, type AnyOperation } from "../../packages/engine/src/operations";

const KON = "kon-qa-notes";
const op = (id: string, method: string, route: string, action: string) =>
  ({
    id,
    method,
    route,
    summary: id,
    description: id,
    access: "session",
    permission: { policy: { resource: "qa-notes", action, inHandler: true } },
  }) as unknown as AnyOperation;

const agent = (scopes: string[]) => ({
  agentId: "agent-1",
  agentName: "qa",
  apiKeyId: "key-1",
  scopes,
  allowedTools: [],
});

let operationTools: typeof import("../../apps/api/src/lib/operations-mcp").operationTools;

beforeAll(async () => {
  definePolicy<{ authorId?: string }>("qa-notes", {
    create: (user) => Boolean(user?.id) && user?.role !== "agent",
    update: (user, item) => Boolean(item?.authorId) && item.authorId === user?.id,
  });
  registerMountedOperations(
    KON,
    "/api/qa-notes",
    [op("create-note", "POST", "/", "create"), op("update-note", "PATCH", "/:id", "update")],
    {} as never
  );
  ({ operationTools } = await import("../../apps/api/src/lib/operations-mcp"));
});

const names = async (scopes: string[]) =>
  (await operationTools(agent(scopes))).map((t) => t.name).filter((n) => n.startsWith("qa-notes"));

describe("policyReadsResource", () => {
  it("tells rules that read the resource from those that do not", () => {
    expect(policyReadsResource("qa-notes", "create")).toBe(false);
    expect(policyReadsResource("qa-notes", "update")).toBe(true);
    expect(policyReadsResource("qa-notes", "nonexistent")).toBeUndefined();
  });
});

describe("tools an agent sees", () => {
  it("a read-only agent is not offered a create it would be refused", async () => {
    const seen = await names(["mcp:connect", "mcp:read"]);
    expect(seen.some((n) => n.includes("create-note"))).toBe(false);
  });

  it("an agent with the scope is offered it", async () => {
    const seen = await names(["mcp:connect", "qa-notes:create"]);
    expect(seen.some((n) => n.includes("create-note"))).toBe(true);
  });

  it("a rule that reads the resource is still advertised: the call decides", async () => {
    const seen = await names(["mcp:connect", "mcp:read"]);
    expect(seen.some((n) => n.includes("update-note"))).toBe(true);
  });
});
