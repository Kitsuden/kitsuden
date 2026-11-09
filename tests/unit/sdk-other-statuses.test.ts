/**
 * `output.otherStatuses`: an upsert answers 201 on create and 200 on rewrite
 * ============================================================================
 *
 * The SDK published ONE success status. `PUT /api/tierlist/templates` answers
 * both and did so before the SDK, and Schemathesis counts as broken the one that does not
 * appear in the OpenAPI (`status_code_conformance`). `otherStatuses` publishes it with the
 * same body, without changing what the route answers.
 */

import { defineOperation } from "@kitsuden/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openApiOperation } from "../../apps/api/src/lib/operations-openapi";

const base = {
  id: "save-thing",
  method: "PUT" as const,
  route: "/things",
  summary: "Upsert a thing",
  description: "Creates (201) or rewrites (200) a thing by slug.",
  access: "session" as const,
  input: { body: z.object({ slug: z.string() }) },
  handle: () => ({ id: "x" }),
};

const schema = z.object({ id: z.string() });

describe("otherStatuses", () => {
  it("they are published in OpenAPI with the same body as the main status", () => {
    const op = defineOperation({ ...base, output: { schema, otherStatuses: [201] } });
    const { operation } = openApiOperation("kon-things", "/api/things", op);
    const responses = operation.responses as Record<string, { content?: unknown }>;
    expect(responses["200"]?.content).toBeDefined();
    expect(responses["201"]?.content).toEqual(responses["200"]?.content);
  });

  it("without declaring them, only the main one comes out", () => {
    const op = defineOperation({ ...base, output: { schema } });
    const { operation } = openApiOperation("kon-things", "/api/things", op);
    expect(Object.keys(operation.responses as object)).not.toContain("201");
  });

  it("rejects repeating the main status", () => {
    expect(() =>
      defineOperation({ ...base, output: { status: 201, schema, otherStatuses: [201] } })
    ).toThrow(/otherStatuses/);
  });

  it("rejects combining them with a 204 (there is no body to share)", () => {
    expect(() =>
      defineOperation({ ...base, output: { status: 204, otherStatuses: [200] } })
    ).toThrow(/otherStatuses/);
  });

  it("rejects a non-success status with a body", () => {
    expect(() =>
      defineOperation({
        ...base,
        output: { schema, otherStatuses: [204 as unknown as 200] },
      })
    ).toThrow(/otherStatuses/);
  });
});
