/**
 * Deprecating an operation (docs/api-contract.md, deprecation policy):
 *
 *   - `defineOperation` refuses dates that are not days, a sunset before `since`, and a
 *     replacement that is not another operation of the kon;
 *   - every response carries `Deprecation` (RFC 9745) and `Sunset` (RFC 8594), errors too,
 *     and each call leaves a warning with the caller;
 *   - the OpenAPI says `deprecated` + `x-sunset` (what oasdiff reads), the MCP tool's
 *     description starts with the note, and the generated clients mark the method;
 *   - `unpaginated` is for a GET, with a reason.
 * Plus the `?filter=` language of GET /api/docs/operations.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkDeprecations, defineOperation, type KonContext } from "@kitsuden/shared";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { operationFilter } from "../../apps/api/src/lib/operation-filter";
import { mcpTool, openApiOperation } from "../../apps/api/src/lib/operations-openapi";
import { operationsRouter } from "../../packages/engine/src/operations";

const ROOT = resolve(__dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "kitsuden-deprecation-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  method: "GET" as const,
  summary: "Old list",
  description: "The old way to list things.",
  access: "public" as const,
  output: { schema: z.object({ ok: z.boolean() }) },
  handle: () => ({ ok: true }),
};
const oldOp = defineOperation({
  ...base,
  id: "old-list",
  route: "/old",
  deprecated: { since: "2026-11-01", sunset: "2027-03-01", use: "new-list" },
});
const newOp = defineOperation({ ...base, id: "new-list", route: "/new", summary: "New list" });

describe("defineOperation: deprecated and unpaginated", () => {
  const bad = (deprecated: unknown) => () =>
    defineOperation({ ...base, id: "x", route: "/x", deprecated: deprecated as never });

  it("refuses what would publish a wrong date or a dead replacement", () => {
    expect(bad({ since: "2026-11-01", sunset: "next year" })).toThrow(/days \(YYYY-MM-DD\)/);
    expect(bad({ since: "2026-02-30", sunset: "2027-01-01" })).toThrow(/days/);
    expect(bad({ since: "2027-01-01", sunset: "2026-01-01" })).toThrow(/after/);
    expect(bad({ since: "2026-01-01", sunset: "2027-01-01", use: "x" })).toThrow(
      /another operation/
    );
    expect(() => checkDeprecations("kon-demo", [oldOp])).toThrow(/'new-list'.*not an operation/);
    expect(() => checkDeprecations("kon-demo", [oldOp, newOp])).not.toThrow();
  });

  it("unpaginated is for a GET, with its reason", () => {
    expect(() =>
      defineOperation({ ...base, id: "list-x", route: "/x", unpaginated: "small" })
    ).toThrow(/reason/);
    expect(() =>
      defineOperation({
        ...base,
        method: "POST",
        id: "list-y",
        route: "/y",
        unpaginated: "A fixed catalogue of ten.",
      })
    ).toThrow(/GET/);
    expect(() =>
      defineOperation({
        ...base,
        id: "list-z",
        route: "/z",
        unpaginated: "A fixed catalogue of ten.",
      })
    ).not.toThrow();
  });
});

describe("what a deprecated operation publishes", () => {
  it("OpenAPI: deprecated + x-sunset, and the declaration under x-kitsuden-operation", () => {
    const { operation } = openApiOperation("kon-demo", "/api/demo", oldOp as never);
    expect(operation.deprecated).toBe(true);
    expect(operation["x-sunset"]).toBe("2027-03-01");
    expect((operation["x-kitsuden-operation"] as Record<string, unknown>).deprecated).toEqual({
      since: "2026-11-01",
      sunset: "2027-03-01",
      use: "new-list",
    });
    const fresh = openApiOperation("kon-demo", "/api/demo", newOp as never).operation;
    expect(fresh.deprecated).toBeUndefined();
  });

  it("MCP: the first line of the description names the sunset and the replacement tool", () => {
    const tool = mcpTool("kon-demo", "/api/demo", oldOp as never)!;
    expect(tool.description.split("\n")[0]).toBe(
      "Deprecated: removed after 2027-03-01; use demo__new-list."
    );
  });

  it("REST: Deprecation and Sunset on every response, and a warning with the caller", async () => {
    const warn = vi.fn();
    const ctx = {
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    } as unknown as KonContext;
    const router = operationsRouter("kon-demo", [oldOp, newOp] as never, ctx);
    const res = await router.request("/old");
    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe(`@${Date.UTC(2026, 10, 1) / 1000}`);
    expect(res.headers.get("Sunset")).toBe("Mon, 01 Mar 2027 00:00:00 GMT");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/kon-demo\/old-list called by anonymous.*use new-list/)
    );
    const plain = await router.request("/new");
    expect(plain.headers.get("Deprecation")).toBeNull();
  });

  it("generated clients: @deprecated in TypeScript, a DeprecationWarning in Python", () => {
    const snapshot = JSON.parse(
      readFileSync(join(ROOT, "packages/sdk/openapi/kitsuden.openapi.json"), "utf8")
    );
    const op = snapshot.paths["/page-builder/templates"].get;
    op.deprecated = true;
    op["x-sunset"] = "2027-03-01";
    op["x-kitsuden-operation"].deprecated = {
      since: "2026-11-01",
      sunset: "2027-03-01",
      use: "list-pages",
    };
    const spec = join(dir, "spec.json");
    writeFileSync(spec, JSON.stringify(snapshot));
    const r = spawnSync(
      process.execPath,
      [
        join(ROOT, "scripts/sdk/generate.mjs"),
        `--spec=${spec}`,
        `--out-ts=${join(dir, "ts")}`,
        `--out-py=${join(dir, "py")}`,
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(r.status, r.stderr).toBe(0);
    const ts = readFileSync(join(dir, "ts/kons/blocks.ts"), "utf8");
    expect(ts).toContain("@deprecated Removed after 2027-03-01. Use `listPages` instead.");
    const py = readFileSync(join(dir, "py/kons/blocks.py"), "utf8");
    expect(py).toContain("import warnings\n");
    expect(py).toContain(
      'warnings.warn("kon-blocks.list_templates is deprecated: removed after 2027-03-01; use list_pages", DeprecationWarning, stacklevel=2)'
    );
    // Only the kon that has a deprecated operation changes.
    expect(readFileSync(join(dir, "py/kons/media.py"), "utf8")).not.toContain("import warnings");
  });
});

describe("GET /api/docs/operations?filter=", () => {
  const ops = [
    {
      konId: "kon-media",
      operationId: "media.list-folders",
      method: "GET",
      path: "/api/media/folders",
      summary: "Folders",
      tags: ["kon-media"],
      sdk: true,
      deprecated: false,
    },
    {
      konId: "kon-media",
      operationId: "media.upload",
      method: "POST",
      path: "/api/media/upload",
      summary: "Upload a file",
      tags: ["kon-media", "files"],
      sdk: true,
      deprecated: false,
    },
    {
      konId: "kon-blocks",
      operationId: "blocks.old",
      method: "GET",
      path: "/api/page-builder/old/{id}",
      summary: "Old page",
      tags: ["kon-blocks"],
      sdk: true,
      deprecated: true,
    },
    {
      konId: "kon-blog",
      operationId: "blog_get__posts",
      method: "GET",
      path: "/api/blog/posts",
      summary: "Posts",
      tags: ["Blog"],
      sdk: false,
      deprecated: false,
    },
  ];
  const ids = (f: string) => ops.filter(operationFilter(f)).map((o) => o.operationId);

  it("every plain term must match, no ! term may", () => {
    expect(ids("")).toHaveLength(4);
    expect(ids("kon:media")).toEqual(["media.list-folders", "media.upload"]);
    expect(ids("kon:media method:post")).toEqual(["media.upload"]);
    expect(ids("tag:files")).toEqual(["media.upload"]);
    expect(ids("deprecated")).toEqual(["blocks.old"]);
    expect(ids("sdk !deprecated")).toEqual(["media.list-folders", "media.upload"]);
    expect(ids("sdk !deprecated !kon:media")).toEqual([]);
    expect(ids("!sdk")).toEqual(["blog_get__posts"]);
    expect(ids("/api/media/*")).toEqual(["media.list-folders", "media.upload"]);
    expect(ids("/api/page-builder/**")).toEqual(["blocks.old"]);
    expect(ids("blocks.old")).toEqual(["blocks.old"]);
    expect(ids("folder")).toEqual(["media.list-folders"]);
  });
});

describe("recursive schemas in the OpenAPI document", () => {
  it("their $defs refs resolve from the document root (they pointed at a #/$defs that is not there)", () => {
    type Node = { name: string; children: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(NodeSchema) })
    );
    const op = defineOperation({
      ...base,
      id: "tree",
      route: "/tree",
      output: { schema: z.object({ root: NodeSchema }) },
    });
    const { path, method, operation } = openApiOperation("kon-demo", "/api/demo", op as never);
    const doc = { paths: { [path]: { [method]: operation } } };
    const refs: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (k === "$ref" && typeof v === "string" && v.startsWith("#/paths/")) refs.push(v);
        else walk(v);
      }
    };
    walk(operation);
    expect(refs.length).toBeGreaterThan(0);
    const resolve = (ref: string) =>
      ref
        .slice(2)
        .split("/")
        .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], doc);
    for (const ref of refs) expect(resolve(ref), ref).toBeTypeOf("object");
    expect(JSON.stringify(operation)).not.toContain('"#/$defs/');
    // The MCP tool keeps its own self-contained `#/$defs/…`.
    expect(
      JSON.stringify(mcpTool("kon-demo", "/api/demo", op as never)!.inputSchema)
    ).not.toContain("#/paths/");
  });
});
