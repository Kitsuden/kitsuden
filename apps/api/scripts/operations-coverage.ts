#!/usr/bin/env bun
/**
 * Operation coverage: every mounted route × OpenAPI × MCP, per kon
 * ============================================================================
 *
 * Mounts the REAL app (like `authorization-matrix.ts`: all the kons
 * turned on), and for each route in `app.routes` looks at:
 *
 *   - whether it appears in `GET /api/docs/openapi.json` (any operation),
 *   - whether that operation carries DECLARED schemas (the `x-kitsuden-operation`
 *     marker, which only the SDK operations of kons set),
 *   - whether it is a generated MCP tool, or is excluded with a reason.
 *
 * Writes the per-kon table (Markdown) and, with `--output=file.json`, the
 * detail. This is the report measured on the mounted app.
 *
 * ONLY against a TEST database migrated with all the kons (same
 * conditions as the matrix: `NODE_ENV=test`, `KITSUDEN_TEST_DB=postgres` and
 * a database name containing `test`).
 */

import { writeFileSync } from "node:fs";

if (process.env.NODE_ENV !== "test" || process.env.KITSUDEN_TEST_DB !== "postgres") {
  console.error(
    "Only with NODE_ENV=test and KITSUDEN_TEST_DB=postgres (it mounts the app with all the kons)."
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const output = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);

// ── 1. Turn on all the kons BEFORE mounting the app (same as the matrix) ──
{
  // The INSTALLED ones (core + kitsuden.kons.json + KITSUDEN_KONS): since
  // the kons are not in the core repo, they are installed.
  const { listInstalledKons } = await import("../src/lib/installed-kons");
  const ids = new Set<string>(
    listInstalledKons()
      .filter((k) => k.route && k.manifest)
      .map((k) => k.manifest!.id)
      .filter((id) => id.startsWith("kon-"))
  );
  const pg = (await import("pg")).default;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL,
  });
  await client.connect();
  for (const id of ids) {
    await client.query(
      `INSERT INTO modules (key, name, enabled) VALUES ($1, $1, true)
       ON CONFLICT (key) DO UPDATE SET enabled = true`,
      [id]
    );
  }
  await client.end();
}

const { app } = await import("../src/index");
const { routeKeys } = await import("../src/middleware/authorization-matrix");
const { konRoutes } = await import("../src/lib/kon-routes");

// The generated MCP tools (if the operations SDK is present).
let tools: { route: string; name: string | null; excluded: string | null }[] = [];
try {
  const mod = (await import("../src/lib/operations-mcp")) as {
    operationsMcpInventory?: () => {
      route: string;
      name: string | null;
      excluded: string | null;
    }[];
  };
  tools = mod.operationsMcpInventory?.() ?? [];
} catch {
  tools = [];
}

const log = (s: string) => process.stdout.write(`${s}\n`);
console.log = () => undefined;
console.info = () => undefined;
console.warn = () => undefined;

const routes = routeKeys(
  (app as unknown as { routes: { method: string; path: string }[] }).routes
).filter((k) => !k.startsWith("ALL "));

const res = await app.request("/api/docs/openapi.json");
const doc = (await res.json()) as {
  openapi?: string;
  paths?: Record<string, Record<string, Record<string, unknown>>>;
};
// The whole document, against the official OpenAPI schema (3.0 or 3.1).
const { Validator } = await import("@seriousme/openapi-schema-validator");
const validation = await new Validator().validate(doc as Record<string, unknown>);

const inOpenApi = new Map<string, Record<string, unknown>>();
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  for (const [method, operation] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const template = `/api${path}`.replace(/\{([^}]+)\}/g, ":$1").replace(/\/$/, "") || "/api";
    inOpenApi.set(`${method.toUpperCase()} ${template}`, operation);
  }
}

const konOf = new Map<string, string>();
for (const r of konRoutes()) konOf.set(`${r.method} ${r.path}`, r.konId);
const mcpOf = new Map(tools.map((h) => [h.route, h]));

/** A parameter's name does not change the route: `/x/:id` and `/x/:slug` are the same. */
const shape = (key: string) => key.replace(/:[^/]+/g, ":p");
const openApiByShape = new Map([...inOpenApi].map(([k, v]) => [shape(k), v]));

interface Row {
  kon: string;
  routes: number;
  openapi: number;
  withSchemas: number;
  mcp: number;
  excludedOnes: number;
}
const byKon = new Map<string, Row>();
const detail: Record<string, unknown>[] = [];
for (const key of routes) {
  const kon = konOf.get(key) ?? "host (apps/api)";
  const row = byKon.get(kon) ?? {
    kon,
    routes: 0,
    openapi: 0,
    withSchemas: 0,
    mcp: 0,
    excludedOnes: 0,
  };
  const op = inOpenApi.get(key) ?? openApiByShape.get(shape(key));
  const tool = mcpOf.get(key);
  row.routes++;
  if (op) row.openapi++;
  if (op && op["x-kitsuden-operation"]) row.withSchemas++;
  if (tool?.name) row.mcp++;
  if (tool?.excluded) row.excludedOnes++;
  byKon.set(kon, row);
  detail.push({
    key,
    kon,
    openapi: Boolean(op),
    withSchemas: Boolean(op?.["x-kitsuden-operation"]),
    mcp: tool?.name ?? null,
    mcpExcluded: tool?.excluded ?? null,
  });
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 1000) / 10}%`);
const rows = [...byKon.values()].sort((a, b) => b.routes - a.routes || a.kon.localeCompare(b.kon));
const total = rows.reduce(
  (t, f) => ({
    kon: "TOTAL",
    routes: t.routes + f.routes,
    openapi: t.openapi + f.openapi,
    withSchemas: t.withSchemas + f.withSchemas,
    mcp: t.mcp + f.mcp,
    excludedOnes: t.excludedOnes + f.excludedOnes,
  }),
  { kon: "TOTAL", routes: 0, openapi: 0, withSchemas: 0, mcp: 0, excludedOnes: 0 }
);

log(`OpenAPI ${doc.openapi ?? "?"} · ${routes.length} mounted routes`);
log(
  `OpenAPI validator: ${validation.valid ? "valid" : "NOT valid"}` +
    (validation.valid ? "" : ` — ${JSON.stringify(validation.errors).slice(0, 1500)}`)
);
log("");
log("| kon | routes | OpenAPI | OpenAPI with schemas | MCP | MCP excluded (with reason) |");
log("|---|---:|---:|---:|---:|---:|");
for (const f of [...rows, total]) {
  log(
    `| ${f.kon} | ${f.routes} | ${f.openapi} (${pct(f.openapi, f.routes)}) | ${f.withSchemas} (${pct(
      f.withSchemas,
      f.routes
    )}) | ${f.mcp} (${pct(f.mcp, f.routes)}) | ${f.excludedOnes} |`
  );
}

if (output) {
  writeFileSync(
    output,
    JSON.stringify(
      {
        generatedValue: new Date().toISOString(),
        openapi: doc.openapi,
        valid: validation.valid,
        errors: validation.errors,
        rows,
        total,
        detail,
      },
      null,
      1
    )
  );
}
process.exit(0);
