/**
 * MCP errors with the same fields as the REST API
 * ============================================================================
 *
 * MCP is JSON-RPC: the problem goes in `error.data` (protocol errors) or
 * in `structuredContent` + the text (a tool that fails). The test against
 * the real `/api/mcp` route (with database and SSE session) is in
 * apps/api/src/tests/mcp.test.ts.
 */

import { KITSUDEN_ERRORS } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";

import {
  withProblem,
  errorJsonRpc,
  exceptionProblem,
  errorResult,
} from "../../apps/api/src/lib/problems-mcp";

const FIELDS = [
  "type",
  "title",
  "status",
  "detail",
  "code",
  "retryable",
  "retry_after",
  "hint",
  "docs",
  "error",
];

describe("JSON-RPC errors", () => {
  it("error.code and error.message do not change; the problem goes in error.data", () => {
    const r = errorJsonRpc(-32601, "Method not found: x", 7);
    expect(r).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found: x" },
    });
    for (const c of FIELDS) expect(r.error.data, c).toHaveProperty(c);
    expect(r.error.data.code).toBe("KITSUDEN_E_NOT_FOUND");
    expect(r.error.data.instance).toBe("/api/mcp");
  });

  it("each standard JSON-RPC code has its catalog code", () => {
    expect(errorJsonRpc(-32602, "x", 1).error.data.code).toBe("KITSUDEN_E_VALIDATION");
    expect(errorJsonRpc(-32603, "x", 1).error.data.code).toBe("KITSUDEN_E_INTERNAL");
    expect(errorJsonRpc(-32700, "x", null).error.data.code).toBe("KITSUDEN_E_BAD_REQUEST");
    expect(errorJsonRpc(-32002, "x", 1).error.data.code).toBe("KITSUDEN_E_NOT_FOUND");
    expect(errorJsonRpc(-32000, "x", null, "KITSUDEN_E_FORBIDDEN").error.data).toMatchObject({
      code: "KITSUDEN_E_FORBIDDEN",
      status: 403,
    });
  });
});

describe("tools that fail (isError)", () => {
  it("an exception: structuredContent with the problem and the text with code/retryable", () => {
    const r = errorResult(
      exceptionProblem(
        new Error("Unknown hardcoded MCP tool: foo"),
        "Unknown hardcoded MCP tool: foo"
      )
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe("KITSUDEN_E_NOT_FOUND");
    expect(r.content[0]!.text).toMatch(/^Error: Unknown hardcoded MCP tool: foo\n\{/);
    const summary = JSON.parse(r.content[0]!.text.split("\n")[1]!);
    expect(summary).toMatchObject({
      code: "KITSUDEN_E_NOT_FOUND",
      retryable: false,
      retry_after: null,
    });
  });

  it("the fixed messages of the core tools do not come out as INTERNAL", () => {
    const codeOf = (m: string) => exceptionProblem(new Error(m), m).code;
    expect(codeOf("Invalid arguments for 'x': limit: Expected number")).toBe(
      "KITSUDEN_E_VALIDATION"
    );
    expect(codeOf("Agent lacks required scope 'admin' to execute tool 'x'")).toBe(
      "KITSUDEN_E_FORBIDDEN"
    );
    expect(codeOf("something odd")).toBe("KITSUDEN_E_INTERNAL");
    // An AppError (or anything with status/code) takes precedence over the message
    expect(
      exceptionProblem({ status: 429, code: "RATE_LIMITED", message: "x" }, "x")
    ).toMatchObject({
      code: "KITSUDEN_E_RATE_LIMITED",
      retryable: true,
      retry_after: KITSUDEN_ERRORS.KITSUDEN_E_RATE_LIMITED.retryAfter,
    });
  });

  it("an action result with isError gets the problem without losing its text", () => {
    const r = withProblem({
      content: [{ type: "text", text: "Error: out of stock" }],
      isError: true,
    });
    expect(r.content[0]).toEqual({ type: "text", text: "Error: out of stock" });
    expect(
      (r as unknown as { structuredContent: { detail: string } }).structuredContent.detail
    ).toBe("out of stock");
    // A successful result is left alone
    const ok = { content: [{ type: "text", text: "{}" }], isError: false };
    expect(withProblem(ok)).toBe(ok);
  });
});
