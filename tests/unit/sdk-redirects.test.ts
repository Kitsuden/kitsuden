/**
 * Redirects in `output.status` / `otherStatuses`
 * ============================================================================
 *
 * The dms download (302), the short code (307), the old slug (308) and the
 * newsletter click (302) answered a redirect that the OpenAPI did not
 * publish: the output said 200 `text/plain`. A redirect is not an
 * error (it carries no catalog code); it is declared as an output status, with no
 * body and with its `Location`.
 */

import { defineOperation, type KonContext } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openApiOperation } from "../../apps/api/src/lib/operations-openapi";
import { operationsRouter } from "../../packages/engine/src/operations";

const base = {
  id: "open-thing",
  method: "GET" as const,
  route: "/things/:id",
  summary: "Open a thing",
  description: "Redirects to where the thing lives.",
  access: "public" as const,
  input: { params: z.object({ id: z.string() }) },
};

type Responses = Record<string, { content?: unknown; headers?: Record<string, unknown> }>;

describe("redirects", () => {
  it("a 302 is published with no body and with Location", () => {
    const op = defineOperation({
      ...base,
      output: { status: 302, description: "Redirect to the file" },
      handle: () => new Response(null, { status: 302, headers: { Location: "/x" } }),
    });
    const r = openApiOperation("kon-things", "/api/things", op).operation.responses as Responses;
    expect(r["302"]?.content).toBeUndefined();
    expect(r["302"]?.headers?.Location).toBeDefined();
    expect(r["200"]).toBeUndefined();
  });

  it("a 308 in otherStatuses coexists with the 200 of the read", () => {
    const op = defineOperation({
      ...base,
      output: { schema: z.object({ id: z.string() }), otherStatuses: [308] },
      handle: () => ({ id: "x" }),
    });
    const r = openApiOperation("kon-things", "/api/things", op).operation.responses as Responses;
    expect(r["200"]?.content).toBeDefined();
    expect(r["308"]?.content).toBeUndefined();
    expect(r["308"]?.headers?.Location).toBeDefined();
  });

  it("rejects a schema in a redirect", () => {
    expect(() =>
      defineOperation({
        ...base,
        output: { status: 307, schema: z.object({}) },
        handle: () => ({}),
      })
    ).toThrow(/redirect/);
  });

  it("the handler that returns the Response serves it as is", async () => {
    const op = defineOperation({
      ...base,
      output: { status: 307 },
      handle: () => new Response(null, { status: 307, headers: { Location: "/y" } }),
    });
    const app = operationsRouter("kon-things", [op], { auth: {} } as unknown as KonContext);
    const res = await app.request("/things/1");
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/y");
  });

  it("a handler that returns data in a redirect is a kon failure, not a 200", async () => {
    const op = defineOperation({
      ...base,
      output: { status: 302 },
      handle: () => ({ url: "/z" }) as never,
    });
    const app = operationsRouter("kon-things", [op], { auth: {} } as unknown as KonContext);
    const res = await app.request("/things/1");
    expect(res.status).toBe(500);
  });
});
