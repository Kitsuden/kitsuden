/**
 * The standalone MCP server's guide and catalog tools
 * ============================================================================
 *
 *   · That the server —the one `kitsuden mcp` starts— registers them.
 *   · That a misnamed argument gives an error with a suggestion, like the API.
 *   · That the tools call the ROUTES, and that the API's error reaches
 *     the agent intact.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateAgentGuide } from "../../apps/api/src/lib/agent-guide";
import {
  DOMAIN_TOOL_DEFINITIONS,
  runDomainTool,
  type ApiCall,
} from "../../packages/mcp-server/src/domain-tools";

const ROOT = join(__dirname, "..", "..");

/** Fake API: answers by method and path, and records each call. */
function fakeApi(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: ApiCall = async (path, method = "GET", body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (!(key in responses))
      throw new Error(`API ${method} ${path} failed (404): no prepared response`);
    const r = responses[key];
    if (r instanceof Error) throw r;
    return r;
  };
  return { api, calls };
}

describe("the server registers its tools", () => {
  it("the standalone server registers them, and before the generic ones", () => {
    const source = readFileSync(join(ROOT, "packages/mcp-server/src/standalone.ts"), "utf-8");
    const start = source.indexOf("const TOOL_DEFINITIONS = [");
    const firstGeneric = source.indexOf('name: "kitsuden_list_tables"', start);
    const domain = source.indexOf("...DOMAIN_TOOL_DEFINITIONS", start);

    expect(domain, "are not registered").toBeGreaterThan(-1);
    expect(domain, "they have to come before the generic ones").toBeLessThan(firstGeneric);
    expect(source).toContain("runDomainTool(");
  });

  it("each tool is explained and closes its arguments", () => {
    for (const d of DOMAIN_TOOL_DEFINITIONS) {
      expect(d.description.length, `${d.name}: description too short`).toBeGreaterThan(60);
      expect(d.inputSchema.additionalProperties, d.name).toBe(false);
      for (const req of d.inputSchema.required ?? []) {
        expect(
          Object.keys(d.inputSchema.properties),
          `${d.name}: «${req}» required but undefined`
        ).toContain(req);
      }
    }
  });
});

describe("the guide does not send you to a contract that is not published", () => {
  it("with ENABLE_SWAGGER off it does not cite /docs/openapi.json; on, it does", () => {
    const base = "https://api.example.com/api";
    const off = generateAgentGuide({ baseUrl: base, routes: [], publishedContract: false });
    expect(off).not.toContain("/docs/openapi.json");
    expect(off).toContain("ENABLE_SWAGGER=false");
    expect(generateAgentGuide({ baseUrl: base, routes: [] })).toContain(
      `GET ${base}/docs/openapi.json`
    );
  });
});

describe("errors speak to the agent", () => {
  it("a misnamed argument suggests the right one", async () => {
    const { api, calls } = fakeApi({});
    const r = await runDomainTool("catalog_add_entries", { datasetID: "d1", entries: [] }, api);

    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toContain("«datasetID» does not exist (did you mean «datasetId»?)");
    expect(r?.content[0].text).toContain("missing «datasetId»");
    expect(calls, "with invalid arguments the API is not called").toHaveLength(0);
  });

  it("the API's error arrives as is", async () => {
    const { api } = fakeApi({
      "POST /data-sets/d1/entries": new Error(
        'API POST /data-sets/d1/entries failed (409): {"error":"entry conflict"}'
      ),
    });
    const r = await runDomainTool(
      "catalog_add_entries",
      { datasetId: "d1", entries: [{ title: "x" }] },
      api
    );
    expect(r?.isError).toBe(true);
    expect(r?.content[0].text).toContain("entry conflict");
  });

  it("a name that is not a domain one returns null so the server tries", async () => {
    expect(await runDomainTool("kitsuden_list_tables", {}, fakeApi({}).api)).toBeNull();
  });
});

describe("the tools use the domain routes", () => {
  it("the catalog asks for an image field of type url", async () => {
    // `image` stores the id of an uploaded media item; here external URLs are pasted.
    const { api, calls } = fakeApi({ "POST /data-sets": { id: "ds1", slug: "characters" } });
    await runDomainTool("catalog_create", { name: "Characters" }, api);
    expect((calls[0].body as { schema: unknown[] }).schema).toEqual([
      { name: "image", type: "url", label: "Image" },
    ]);
  });
});
