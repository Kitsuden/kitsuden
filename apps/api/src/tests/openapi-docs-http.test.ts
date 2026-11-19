/**
 * GET /api/docs/openapi.json and /api/docs.
 *
 * A dataset with `schema = {}` (or with the shape `{fields: [...]}`) took down the
 * whole document: the aggregator did `for (const field of ds.schema || [])`
 * and responded 500 «{} is not iterable». Now it reads the fields with
 * `schemaFields`, and the document has to come out complete and coherent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import pins from "../lib/docs-viewers.json";

import { isDatabaseAvailable, generateTestId } from "./setup";

// The viewers' files are downloaded by the API build, not by the test jobs:
// stand-ins with the pinned names, so the pages render (lib/docs-viewers.ts).
const viewersDir = mkdtempSync(join(tmpdir(), "kitsuden-docs-viewers-"));
for (const [id, v] of Object.entries(pins.viewers)) {
  mkdirSync(join(viewersDir, `${id}@${v.version}`), { recursive: true });
  for (const file of Object.keys(v.files)) {
    writeFileSync(join(viewersDir, `${id}@${v.version}`, file), `/* ${id} stand-in */`);
  }
}
process.env.KITSUDEN_DOCS_VIEWERS_DIR = viewersDir;

let dbAvailable = false;
let app: { request: (r: Request | string) => Promise<Response> };
const suffix = generateTestId()
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");
const slugs = {
  empty: `openapi-empty-${suffix}`,
  fields: `openapi-fields-${suffix}`,
  list: `openapi-list-${suffix}`,
};

/** All the document's local `$ref`s point to something that exists. */
function brokenRefs(doc: Record<string, any>): string[] {
  const broken: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("#/")) {
        let target: any = doc;
        for (const part of v.slice(2).split("/")) target = target?.[part];
        if (target === undefined) broken.push(v);
      } else visit(v);
    }
  };
  visit(doc);
  return broken;
}

describe("OpenAPI", () => {
  beforeAll(async () => {
    app = (await import("../index")).app as never;
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    // Public: the anonymous document only lists what an anonymous visitor may read
    // (a dataset without a policy is admin-only, and appeared here only while the
    // test database had no administrator yet).
    await db.execute(sql`
      INSERT INTO data_sets (name, slug, schema, policy_json) VALUES
        (${"OpenAPI empty"}, ${slugs.empty}, '{}'::jsonb, '{"readAccess":"public"}'::jsonb),
        (${"OpenAPI fields"}, ${slugs.fields},
          '{"fields":[{"name":"title","type":"text","required":true}]}'::jsonb,
          '{"readAccess":"public"}'::jsonb),
        (${"OpenAPI list"}, ${slugs.list}, '[{"fieldName":"price","fieldType":"number"}]'::jsonb,
          '{"readAccess":"public"}'::jsonb)
    `);
    // Mounting the app with all the kons takes longer than the default limit.
  }, 60_000);

  afterAll(async () => {
    rmSync(viewersDir, { recursive: true, force: true });
    if (!dbAvailable) return;
    await db.execute(
      sql`DELETE FROM data_sets WHERE slug IN (${slugs.empty}, ${slugs.fields}, ${slugs.list})`
    );
  });

  it("every document names the session cookie better-auth really sets", async () => {
    // Two of the three generators said `session` (and `bearerFormat: JWT`);
    // they now share SECURITY_SCHEMES (lib/operations-openapi.ts).
    const { SECURITY_SCHEMES } = await import("../lib/operations-openapi");
    for (const url of ["/api/docs/openapi.json", "/api/docs-legacy/openapi.json"]) {
      const res = await app.request(`http://localhost:3000${url}`);
      expect(res.status, url).toBe(200);
      const doc = (await res.json()) as Record<string, any>;
      expect(doc.components?.securitySchemes, url).toEqual(
        JSON.parse(JSON.stringify(SECURITY_SCHEMES))
      );
      expect(doc.components.securitySchemes.cookieAuth.name).toBe("better-auth.session_token");
      expect(doc.components.securitySchemes.bearerAuth.bearerFormat).toBeUndefined();
    }
  });

  it("GET /api/docs/openapi.json returns a valid OpenAPI 3 document", async () => {
    const res = await app.request("http://localhost:3000/api/docs/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;

    expect(doc.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(typeof doc.info?.title).toBe("string");
    expect(typeof doc.info?.version).toBe("string");
    expect(doc.paths && typeof doc.paths).toBe("object");

    for (const [path, item] of Object.entries(doc.paths as Record<string, any>)) {
      expect(path.startsWith("/")).toBe(true);
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        expect(op.responses && Object.keys(op.responses).length > 0).toBe(true);
      }
    }
    expect(brokenRefs(doc)).toEqual([]);

    if (!dbAvailable) return;
    const schemas = doc.components.schemas as Record<string, any>;
    expect(schemas[`Dataset_${slugs.empty}`]?.required).toEqual(["id"]);
    expect(schemas[`Dataset_${slugs.fields}`]?.properties?.title).toEqual({ type: "string" });
    expect(schemas[`Dataset_${slugs.fields}`]?.required).toContain("title");
    expect(schemas[`Dataset_${slugs.list}`]?.properties?.price).toEqual({ type: "number" });
  });

  it("GET /api/docs serves the HTML interface", async () => {
    const res = await app.request("http://localhost:3000/api/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("/api/docs/openapi.json");
  });

  it("both viewers load pinned code from this API, with SRI and a strict CSP", async () => {
    for (const url of ["/api/docs", "/api/docs/modern"]) {
      const res = await app.request(`http://localhost:3000${url}`);
      expect(res.status, url).toBe(200);
      const html = await res.text();
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce, url).toBeTruthy();
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("default-src 'none'");
      expect(html).not.toMatch(/cdn\.jsdelivr|unpkg\.com|@latest/);
      // Every script is ours: a src under /api/docs/assets with its integrity, or inline with the nonce.
      for (const tag of html.match(/<script[^>]*>/g) ?? []) {
        expect(tag, url).toContain(`nonce="${nonce}"`);
        if (tag.includes("src=")) {
          expect(tag).toMatch(/src="\/api\/docs\/assets\/[a-z-]+@[\d.]+\//);
          expect(tag).toMatch(/integrity="sha384-/);
        }
      }
    }
    const modern = await (await app.request("http://localhost:3000/api/docs/modern")).text();
    expect(modern).toContain('"telemetry":false');
    expect(modern).toContain('"url":"/api/docs/openapi.json"');
  });

  it("serves only the pinned viewer files, cached forever under a versioned URL", async () => {
    const v = pins.viewers.scalar.version;
    const ok = await app.request(`http://localhost:3000/api/docs/assets/scalar@${v}/standalone.js`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/javascript");
    expect(ok.headers.get("cache-control")).toContain("immutable");
    for (const bad of [
      `/api/docs/assets/scalar@${v}/..%2F..%2Fpackage.json`,
      `/api/docs/assets/scalar@0.0.1/standalone.js`,
      `/api/docs/assets/scalar@${v}/other.js`,
    ]) {
      expect((await app.request(`http://localhost:3000${bad}`)).status, bad).toBe(404);
    }
  });
});
