/**
 * Per-operation guide and agent friction (backend-side ideas)
 * ============================================================================
 *
 *   · `guide` in `defineOperation`: an example that does not validate against the
 *     operation's schemas is rejected WHEN IT IS DECLARED (a guide that teaches
 *     how to fail is worse than none).
 *   · The MCP tool carries the short part of the guide in its description and points
 *     to the resource `kitsuden://guide/<tool>`; OpenAPI publishes it in
 *     `x-kitsuden-guide`.
 *   · `summarizeCall` stores the NAMES of the arguments, never their values.
 *   · `frictionReport` aggregates by tool and says what to change.
 */

import { defineOperation } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { frictionReport, summarizeCall } from "../../apps/api/src/lib/agent-friction";
import { mcpTool, openApiOperation } from "../../apps/api/src/lib/operations-openapi";

const base = {
  id: "create-thing",
  method: "POST" as const,
  route: "/:group/things",
  summary: "Create a thing",
  description: "Creates a thing in a group.",
  access: "session" as const,
  input: {
    params: z.object({ group: z.guid() }),
    body: z.object({ name: z.string().min(1), when: z.string().datetime().optional() }),
  },
  output: { status: 201 as const, schema: z.object({ id: z.string() }) },
  handle: () => ({ id: "x" }),
};

const GROUP = "3f2a8c1e-8b7d-4c1e-9a2b-1c2d3e4f5a6b";

describe("guide in defineOperation", () => {
  it("accepts examples that validate", () => {
    expect(() =>
      defineOperation({
        ...base,
        guide: {
          whenToUse: "To create one.",
          examples: [
            {
              title: "minimum",
              args: { group: GROUP, body: { name: "a" }, idempotency_key: "key-0001" },
            },
          ],
        },
      })
    ).not.toThrow();
  });

  it("rejects an example with a wrong body", () => {
    expect(() =>
      defineOperation({
        ...base,
        guide: { examples: [{ title: "bad", args: { group: GROUP, body: { wrong: "a" } } }] },
      })
    ).toThrow(/example «bad» does not validate: name/);
  });

  it("rejects an example without the path parameter", () => {
    expect(() =>
      defineOperation({
        ...base,
        guide: { examples: [{ title: "no group", args: { body: { name: "a" } } }] },
      })
    ).toThrow(/missing 'group'/);
  });

  it("rejects query keys in an operation without a query", () => {
    expect(() =>
      defineOperation({
        ...base,
        guide: {
          examples: [{ title: "query", args: { group: GROUP, body: { name: "a" }, limit: 3 } }],
        },
      })
    ).toThrow(/has no query/);
  });

  it("rejects idempotency_key in an already idempotent operation", () => {
    expect(() =>
      defineOperation({
        ...base,
        method: "PUT",
        guide: {
          examples: [
            {
              title: "put",
              args: { group: GROUP, body: { name: "a" }, idempotency_key: "key-0001" },
            },
          ],
        },
      })
    ).toThrow(/remove idempotency_key/);
  });

  it("rejects empty pitfalls", () => {
    expect(() => defineOperation({ ...base, guide: { traps: [{ if: " ", then: "x" }] } })).toThrow(
      /pitfall is empty/
    );
  });
});

describe("the guide reaches MCP and OpenAPI", () => {
  const op = defineOperation({
    ...base,
    guide: {
      whenToUse: "To create one; to rename use things__edit-thing.",
      before: ["group comes from things__list-groups."],
      traps: [{ if: "you send `name`", then: "send `name`." }],
    },
  });

  it("tool description: the short part and the resource URI", () => {
    const h = mcpTool("kon-things", "/api/things", op)!;
    expect(h.description).toContain(
      "When to use: To create one; to rename use things__edit-thing."
    );
    expect(h.description).toContain("Before: group comes from things__list-groups.");
    expect(h.description).toContain("kitsuden://guide/things__create-thing");
    // The pitfalls do not bloat tools/list: they go in the resource
    expect(h.description).not.toContain("you send `name`");
  });

  it("without a guide, the description does not change shape", () => {
    const h = mcpTool("kon-things", "/api/things", defineOperation(base))!;
    expect(h.description).not.toContain("When to use");
    expect(h.description).not.toContain("kitsuden://guide/");
  });

  it("OpenAPI: x-kitsuden-guide", () => {
    const { operation: operation } = openApiOperation("kon-things", "/api/things", op);
    expect(operation["x-kitsuden-guide"]).toEqual(op.guide);
  });
});

describe("summarizeCall", () => {
  it("an MCP validation error: code and invented keys, without values", () => {
    const r = summarizeCall(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          structuredContent: {
            code: "KITSUDEN_E_VALIDATION",
            unknownKeys: ["tags"],
            validKeys: ["body"],
          },
        },
      },
      { tags: ["secret"], body: { password: "do-not-store" } }
    );
    expect(r).toEqual({
      success: false,
      code: "KITSUDEN_E_VALIDATION",
      repeated: false,
      proposal: false,
      unknownKeys: ["tags"],
      args: ["body", "tags"],
    });
    expect(JSON.stringify(r)).not.toContain("do-not-store");
  });

  it("JSON-RPC error: the code goes in error.data", () => {
    const r = summarizeCall(
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "x", data: { code: "KITSUDEN_E_FORBIDDEN" } },
      },
      {}
    );
    expect(r.success).toBe(false);
    expect(r.code).toBe("KITSUDEN_E_FORBIDDEN");
  });

  it("success, repetition and proposal", () => {
    expect(
      summarizeCall(
        { result: { structuredContent: { status: 201, idempotentReplayed: true } } },
        {}
      )
    ).toMatchObject({
      success: true,
      repeated: true,
    });
    expect(
      summarizeCall(
        { result: { structuredContent: { code: "KITSUDEN_E_APPROVAL_REQUIRED", status: 202 } } },
        {}
      )
    ).toMatchObject({ success: true, proposal: true });
  });
});

describe("frictionReport", () => {
  const call = (
    tool: string,
    success: boolean,
    details: Record<string, unknown> = {},
    agentId = "a1"
  ) => ({
    tool,
    agentId,
    success,
    details,
  });

  it("aggregates by tool and sorts by failures", () => {
    const rows = [
      call("blog__create-post", false, { code: "KITSUDEN_E_VALIDATION", unknownKeys: ["tags"] }),
      call(
        "blog__create-post",
        false,
        { code: "KITSUDEN_E_VALIDATION", unknownKeys: ["tags"] },
        "a2"
      ),
      call("blog__create-post", true),
      call("blog__list-posts", true),
    ];
    const [first, second] = frictionReport(rows, new Map(), {
      withGuide: new Set(["blog__list-posts"]),
    });
    expect(first).toMatchObject({
      tool: "blog__create-post",
      calls: 3,
      failures: 2,
      agents: 2,
      byCode: { KITSUDEN_E_VALIDATION: 2 },
      madeUpKeys: { tags: 2 },
      hasGuide: false,
    });
    expect(first!.signals.map((s) => s.type)).toEqual(["unknown-keys", "no-guide"]);
    expect(first!.signals[0]!.message).toContain("'tags' (2)");
    expect(second).toMatchObject({ tool: "blog__list-posts", failures: 0, signals: [] });
  });

  it("does not judge rates with few calls", () => {
    const rows = [call("x__y", false, { code: "KITSUDEN_E_NOT_FOUND" })];
    expect(frictionReport(rows)[0]!.signals).toEqual([]);
  });

  it("flags ids that do not exist and permissions with enough sample", () => {
    const rows = [
      ...Array.from({ length: 3 }, () => call("x__y", false, { code: "KITSUDEN_E_NOT_FOUND" })),
      ...Array.from({ length: 2 }, () => call("x__y", false, { code: "KITSUDEN_E_FORBIDDEN" })),
      ...Array.from({ length: 5 }, () => call("x__y", true)),
    ];
    const types = frictionReport(rows)[0]!.signals.map((s) => s.type);
    expect(types).toEqual(["permission", "not-found"]);
  });

  it("rejected proposals, even if the tool has no calls in the period", () => {
    const rows = [call("blog__delete-post", true, { proposal: true })];
    const [f] = frictionReport(rows, new Map([["blog__delete-post", 1]]));
    expect(f).toMatchObject({ proposals: 1, rejectedProposals: 1 });
    expect(f!.signals.map((s) => s.type)).toEqual(["rejections"]);
  });
});
