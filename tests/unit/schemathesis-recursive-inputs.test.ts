/**
 * Schemathesis: operations with a recursive input skip the coverage phase
 * ============================================================================
 *
 * On 2026-11-20 the coverage phase sent ~280,000 requests to kon-dc's
 * `POST /api/dc/blueprints` (a body that nests itself) until the kons job hit
 * its time limit. The runner now tests those operations in a second pass
 * without coverage. This checks how they are recognised and the split.
 */

import { describe, expect, it } from "vitest";

import {
  hasRecursiveInput,
  operationCount,
  splitRecursiveInputs,
} from "../../apps/api/scripts/lib/recursive-inputs";

const recursiveBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: { steps: { $ref: "#/paths/~1dc~1blueprints/post/x/$defs/__schema0" } },
        $defs: {
          __schema0: {
            type: "array",
            items: { $ref: "#/paths/~1dc~1blueprints/post/x/$defs/__schema0" },
          },
        },
      },
    },
  },
};
const flatBody = {
  content: {
    "application/json": {
      schema: { type: "object", properties: { name: { type: "string" } } },
    },
  },
};

describe("hasRecursiveInput", () => {
  it("a body that holds $defs is recursive", () => {
    expect(hasRecursiveInput({ requestBody: recursiveBody })).toBe(true);
  });

  it("a flat body, no body, or $defs only in the responses is not", () => {
    expect(hasRecursiveInput({ requestBody: flatBody })).toBe(false);
    expect(hasRecursiveInput({})).toBe(false);
    expect(
      hasRecursiveInput({
        requestBody: flatBody,
        responses: { "200": { content: { "application/json": { schema: { $defs: {} } } } } },
      })
    ).toBe(false);
  });

  it("a recursive schema in a parameter counts too", () => {
    expect(
      hasRecursiveInput({ parameters: [{ name: "q", in: "query", schema: { $defs: { a: {} } } }] })
    ).toBe(true);
  });
});

describe("splitRecursiveInputs", () => {
  const doc = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    components: { schemas: { Problem: { type: "object" } } },
    paths: {
      "/dc/blueprints": {
        get: { responses: {} },
        post: { requestBody: recursiveBody, responses: {} },
      },
      "/dc/blueprints/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: { requestBody: recursiveBody, responses: {} },
        delete: { responses: {} },
      },
      "/agile/issues": { post: { requestBody: flatBody, responses: {} } },
    },
  };

  it("moves only the operations with a recursive input, method by method", () => {
    const { flat, recursive, recursiveKeys } = splitRecursiveInputs(doc, "/api");
    expect(recursiveKeys).toEqual(["POST /api/dc/blueprints", "PATCH /api/dc/blueprints/{id}"]);
    expect(Object.keys(recursive.paths["/dc/blueprints"]!)).toEqual(["post"]);
    expect(Object.keys(flat.paths["/dc/blueprints"]!)).toEqual(["get"]);
    expect(Object.keys(flat.paths["/agile/issues"]!)).toEqual(["post"]);
    expect(recursive.paths["/agile/issues"]).toBeUndefined();
  });

  it("no operation is lost or doubled, and both halves keep the rest of the document", () => {
    const { flat, recursive } = splitRecursiveInputs(doc);
    expect(operationCount(flat) + operationCount(recursive)).toBe(operationCount(doc));
    expect(operationCount(doc)).toBe(5);
    for (const half of [flat, recursive]) {
      expect(half.components).toBe(doc.components);
      expect(half.info).toBe(doc.info);
    }
  });

  it("path-level parameters go with every operation of that path", () => {
    const { flat, recursive } = splitRecursiveInputs(doc);
    expect(flat.paths["/dc/blueprints/{id}"]!.parameters).toBeDefined();
    expect(recursive.paths["/dc/blueprints/{id}"]!.parameters).toBeDefined();
  });

  it("the input document is not changed", () => {
    const before = JSON.stringify(doc);
    splitRecursiveInputs(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
