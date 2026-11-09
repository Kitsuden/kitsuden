#!/usr/bin/env bun
/**
 * Authorization matrix: every mounted route × every identity
 * ============================================================================
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * Mounts the REAL app (`src/index.ts`: the same middleware order, the same
 * gates, the kons loaded by `module-loader`), creates ten real identities
 * in the database —signed better-auth sessions and real agent keys— and
 * requests EVERY registered route with each of them:
 *
 *   anonymous · user (role `user`, freshly registered) · editor · admin ·
 *   agent without scopes · agent with `content:edit`
 *
 * and three with FINE-GRAINED permissions: only `kon:blog:create-post`, only
 * `datasets:<slug>:read` of a private dataset created here, and
 * `content:edit` + `!kon:blocks:*` (broad with a denial). For the
 * datasets one there are also probes against that real dataset (`FINE_PROBES`).
 *
 * It writes a JSON with the HTTP status of each combination. The comparison with
 * the declarative table (`src/middleware/authorization-matrix.ts`) is done by
 * `tests/unit/authorization-matrix.test.ts`, or by this same script with
 * `--check` (it exits with 1 if anything does not match).
 *
 * ── WHERE IT RUNS ──────────────────────────────────────────────────────────
 *
 * ONLY against a TEST database migrated with all the kons, because it creates
 * users, sessions and agents, and because the routes an identity
 * reaches are EXECUTED (with empty bodies and ids that do not exist, but they
 * are executed). That is why:
 *
 *   - it requires `NODE_ENV=test`, `KITSUDEN_TEST_DB=postgres` and a database whose
 *     name contains `test` (checked by `src/db/index.ts`); with pg-mem no
 *     kons are loaded and the matrix would say nothing, so it refuses;
 *   - it cuts off every `fetch` request to a host that is not local;
 *   - it does not execute as admin/editor the writes in `DO_NOT_RUN_WITH_PERMISSION`
 *     (they touch disk, the repository or the process). For those it only measures
 *     that the identities WITHOUT permission stay out — which is what matters.
 *
 *   docker run --rm -d --name kitsuden_matrix -p 127.0.0.1:55471:5432 \
 *     -e POSTGRES_USER=kitsuden -e POSTGRES_PASSWORD=... \
 *     -e POSTGRES_DB=kitsuden_matrix_test pgvector/pgvector:pg16
 *   DATABASE_URL=<superuser> bun run scripts/migrate.ts --all-kons
 *   (create the app role as in docker/start-with-check.sh)
 *   NODE_ENV=test KITSUDEN_TEST_DB=postgres DATABASE_URL=<app role> \
 *     DATABASE_ADMIN_URL=<superuser> REDIS_URL=redis://127.0.0.1:1 \
 *     bun run scripts/authorization-matrix.ts --output=matrix.json --check
 *
 * `DATABASE_ADMIN_URL` is only used here, BEFORE mounting the app, to
 * turn on all the kons in `modules` (the app role can do it
 * too; either one is accepted).
 */

import { writeFileSync } from "node:fs";

// ── 0. Nothing leaves the machine ───────────────────────────────────────────
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  );
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`[matrix] fetch blocked to ${url.hostname}`);
  }
  return fetchOriginal(input as never, init);
}) as typeof fetch;

if (process.env.NODE_ENV !== "test" || process.env.KITSUDEN_TEST_DB !== "postgres") {
  console.error(
    "The matrix creates users and runs routes: only with NODE_ENV=test and KITSUDEN_TEST_DB=postgres."
  );
  process.exit(2);
}

// The matrix measures GATES, not limits, and for that it empties the limiter's reserve
// before each request (`clearInMemoryReserve()`). With Valkey the count lives
// there and is not emptied: after hundreds of requests from the same IP, the
// kons' per-route limits (fail-closed) returned 429 to the anonymous identity, and a 429
// does not say whether the gate is closed. The limiter stays MOUNTED (its
// `ALL` entries are in the table), but it counts in memory.
process.env.REDIS_URL = "";
process.env.VALKEY_URL = "";

const args = process.argv.slice(2);
const output = args.find((a) => a.startsWith("--output="))?.slice("--output=".length);
const check = args.includes("--check");

// ── 1. Turn on all the kons BEFORE mounting the app ─────────────────────────
//
// `loadKons()` only loads what the `modules` table says; an off kon leaves
// a wildcard delegate (`lib/deferred-kons.ts`) whose internal routes do not show up
// in `app.routes`. To see the whole surface they all have to be turned on.
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
  console.log(`[matrix] ${ids.size} kons turned on in 'modules'`);
}

// `--without-patches`: removes from ADMIN_ONLY_ROUTES the prefixes of kons that are only
// there as a patch and measures ONLY those routes, to see what the kon
// authorizes by itself (what would be left open if the gate is removed).
const PATCHED_PREFIXES = [
  "/api/crm",
  "/api/conta",
  "/api/directory",
  "/api/dms",
  "/api/agile",
  "/api/booking",
  "/api/ocr-training",
  "/api/ocr",
  "/api/payments/portal",
];
const withoutPatches = args.includes("--without-patches");
if (withoutPatches) {
  const { ADMIN_ONLY_ROUTES } = await import("../src/middleware/auth-guard");
  for (let i = ADMIN_ONLY_ROUTES.length - 1; i >= 0; i--) {
    if (PATCHED_PREFIXES.includes(ADMIN_ONLY_ROUTES[i]!.prefix)) ADMIN_ONLY_ROUTES.splice(i, 1);
  }
}

const { app } = await import("../src/index");
const { clearInMemoryReserve } = await import("../src/lib/rate-limiter");
const { isPgMem } = await import("../src/db");
const { auth } = await import("../src/lib/auth");
const { createAgent } = await import("../src/services/agent-auth");
const { SCOPE_CONTENT } = await import("../src/middleware/auth-guard");

if (isPgMem) {
  console.error(
    "[matrix] The database fell back to pg-mem: without test Postgres there are no kons to measure."
  );
  process.exit(2);
}

// ── 2. Real identities ──────────────────────────────────────────────────────

export type Identity =
  | "anonymous"
  | "user"
  | "editor"
  | "admin"
  | "agent"
  | "contentAgent"
  | "blogCreateAgent"
  | "datasetReadAgent"
  | "contentAgentMinusBlocks"
  | "adminAgent";
export const IDENTITIES: Identity[] = [
  "anonymous",
  "user",
  "editor",
  "admin",
  "agent",
  "contentAgent",
  "blogCreateAgent",
  "datasetReadAgent",
  "contentAgentMinusBlocks",
  // An agent with `admin` does NOT enter human approval.
  "adminAgent",
];

const ctx = await auth.$context;
const stamp = Date.now().toString(36);

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(ctx.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encodeURIComponent(`${value}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`);
}

async function sessionOf(role: "user" | "editor" | "admin"): Promise<Record<string, string>> {
  const user = await ctx.internalAdapter.createUser({
    email: `matrix-${role}-${stamp}@example.test`,
    name: `Matrix ${role}`,
    emailVerified: true,
    role,
  } as never);
  const session = await ctx.internalAdapter.createSession(user.id, false);
  const name = ctx.authCookies.sessionToken.name;
  return { cookie: `${name}=${await sign(session.token)}` };
}

async function agentKey(scopes: string[]): Promise<Record<string, string>> {
  const { plainApiKey } = await createAgent({
    name: `matrix-${scopes.join("+") || "no-scopes"}-${stamp}`,
    scopes,
    rateLimit: 1_000_000,
  });
  return { authorization: `Bearer ${plainApiKey}` };
}

// The PRIVATE dataset for the fine-grained probes (policyJson null = admin only).
const { db } = await import("../src/db");
const { dataSets, dataEntries } = await import("../src/db/schema");
const fineSlug = `matrix-fine-${stamp}`;
const [fineDataset] = await db
  .insert(dataSets)
  .values({ name: fineSlug, slug: fineSlug, schema: [], policyJson: null } as never)
  .returning({ id: dataSets.id });
await db
  .insert(dataEntries)
  .values({ dataSetId: fineDataset!.id, title: "row", data: {} } as never);

const HEADERS: Record<Identity, Record<string, string>> = {
  anonymous: {},
  user: await sessionOf("user"),
  editor: await sessionOf("editor"),
  admin: await sessionOf("admin"),
  agent: await agentKey([]),
  contentAgent: await agentKey([SCOPE_CONTENT]),
  blogCreateAgent: await agentKey(["kon:blog:create-post"]),
  datasetReadAgent: await agentKey([`datasets:${fineSlug}:read`]),
  contentAgentMinusBlocks: await agentKey([SCOPE_CONTENT, "!kon:blocks:*"]),
  adminAgent: await agentKey(["admin"]),
};

// ── 3. Routes ───────────────────────────────────────────────────────────────

const { routeKeys, specify, DO_NOT_RUN_WITH_PERMISSION } =
  await import("../src/middleware/authorization-matrix");

const routes = routeKeys(
  (app as unknown as { routes: { method: string; path: string }[] }).routes
).filter(
  (key) =>
    !withoutPatches ||
    PATCHED_PREFIXES.some((p) => {
      const path = key.split(" ")[1]!;
      return path === p || path.startsWith(`${p}/`);
    })
);

const HIGH_PERMISSION: Identity[] = [
  "admin",
  "editor",
  "contentAgent",
  "contentAgentMinusBlocks",
  "adminAgent",
];
const { routeOperation } = await import("../../../packages/engine/src/operations");
const { operationFineScope } = await import("@kitsuden/shared");

interface Measure {
  key: string;
  statuses: Partial<Record<Identity, number>>;
  /** Fine-grained scope of the SDK operation that serves the route. */
  operation?: string | null;
}
const measures: Measure[] = [];

// The log of each request (hono/logger, pino) costs more than the request
// itself when there are thousands of them: it is silenced while measuring.
const log = (s: string) => process.stdout.write(`${s}\n`);
console.log = () => undefined;
console.info = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

/**
 * Reads and discards the body, except for an SSE stream (`GET /api/mcp` with an agent that
 * can connect, e.g. the `admin` one from human approval): that one never ends and the
 * matrix kept waiting. It is cancelled.
 */
async function discardBody(res: Response): Promise<void> {
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await res.body?.cancel().catch(() => undefined);
    return;
  }
  await res.arrayBuffer().catch(() => undefined);
}

async function measure(key: string): Promise<Measure> {
  const [method, pattern] = key.split(" ") as [string, string];
  const path = specify(pattern);
  const statuses: Partial<Record<Identity, number>> = {};
  for (const id of IDENTITIES) {
    if (HIGH_PERMISSION.includes(id) && DO_NOT_RUN_WITH_PERMISSION.some((p) => key.startsWith(p))) {
      continue;
    }
    const m = method === "ALL" ? "POST" : method;
    const withBody = !["GET", "HEAD"].includes(m);
    // Without Valkey, the kons' fail-closed limits count in memory per
    // route and IP, and the matrix makes ALL its requests from the same IP: a
    // route with 10 attempts every 5 min (`POST /api/cardsim/sessions/:id/join`),
    // measured twice (`ALL` and `POST`) by ten identities, answered 429 to
    // the eleventh depending on order. The matrix measures the gates, not the limits.
    clearInMemoryReserve();
    try {
      const res = await app.request(
        path,
        {
          method: m,
          headers: {
            ...HEADERS[id],
            ...(withBody ? { "content-type": "application/json" } : {}),
            // Same origin as the panel: the Origin check (CSRF) is not
            // what this matrix measures.
            origin: process.env.ADMIN_URL || "http://localhost:5173",
          },
          ...(withBody ? { body: "{}" } : {}),
        },
        { ip: { address: "127.0.0.1", family: "IPv4", port: 0 } }
      );
      statuses[id] = res.status;
      await discardBody(res);
    } catch {
      statuses[id] = 0;
    }
    // A 5xx with the machine under load is usually the exhausted test pool
    // (connection timeout), not the route: it is retried up to twice before
    // recording it, so that an infrastructure failure does not look like «got in».
    // A 429 says nothing about the gate either: it is the matrix's own per-route
    // limit (POST /api/datasets/export allows 10 per minute and ten identities
    // with retries get past it depending on which second they land in). It waits for the
    // window to open and retries.
    for (
      let attempt = 0;
      attempt < 2 && (statuses[id]! >= 500 || statuses[id] === 0 || statuses[id] === 429);
      attempt++
    ) {
      if (statuses[id] === 429) await new Promise((r) => setTimeout(r, 61_000));
      clearInMemoryReserve();
      try {
        const res = await app.request(
          path,
          {
            method: m,
            headers: {
              ...HEADERS[id],
              ...(withBody ? { "content-type": "application/json" } : {}),
              origin: process.env.ADMIN_URL || "http://localhost:5173",
            },
            ...(withBody ? { body: "{}" } : {}),
          },
          { ip: { address: "127.0.0.1", family: "IPv4", port: 0 } }
        );
        statuses[id] = res.status;
        await discardBody(res);
      } catch {
        statuses[id] = 0;
      }
    }
  }
  const m = method === "ALL" ? "POST" : method;
  const ofRoute = routeOperation(m, path);
  return {
    key,
    statuses,
    operation: ofRoute ? operationFineScope(ofRoute.konId, ofRoute.op.id) : null,
  };
}

// Several routes at once (each requests its identities serially): the test
// pool has 5 connections.
const CONCURRENCY = Number(process.env.CONCURRENCY_MATRIX) || 2;
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < routes.length) {
      const key = routes[next++]!;
      measures.push(await measure(key));
      if (measures.length % 100 === 0) log(`[matrix] ${measures.length}/${routes.length}`);
    }
  })
);
measures.sort((a, b) => a.key.localeCompare(b.key));

// ── 4. Fine-grained probes against the real dataset ───────────────
const { FINE_PROBES } = await import("../src/middleware/authorization-matrix");
const probes: { probe: string; status: number; expected: number[]; ok: boolean }[] = [];
for (const probe of FINE_PROBES) {
  const path = probe.path.replace(":id", fineDataset!.id);
  const res = await app.request(
    path,
    {
      method: probe.method,
      headers: {
        ...HEADERS[probe.identity],
        ...(probe.body ? { "content-type": "application/json" } : {}),
        origin: process.env.ADMIN_URL || "http://localhost:5173",
      },
      ...(probe.body ? { body: JSON.stringify(probe.body) } : {}),
    },
    { ip: { address: "127.0.0.1", family: "IPv4", port: 0 } }
  );
  await res.arrayBuffer().catch(() => undefined);
  probes.push({
    probe: `${probe.identity} ${probe.method} ${probe.path} — ${probe.reason}`,
    status: res.status,
    expected: probe.expected,
    ok: probe.expected.includes(res.status),
  });
}
for (const s of probes) log(`[matrix] probe ${s.ok ? "✓" : "✗"} ${s.probe}: ${s.status}`);

const report = {
  generatedValue: new Date().toISOString(),
  total: measures.length,
  measures,
  probes,
};
if (output) writeFileSync(output, JSON.stringify(report, null, 1));
log(`[matrix] ${measures.length} routes × ${IDENTITIES.length} identities measured`);

if (check) {
  const { compareWithMatrix } = await import("../src/middleware/authorization-matrix");
  const failures = compareWithMatrix(measures);
  for (const s of probes) {
    if (!s.ok) failures.push(`probe ${s.probe}: ${s.status} (expected ${s.expected.join("/")})`);
  }
  for (const f of failures) log(`  ✗ ${f}`);
  log(`[matrix] ${failures.length} mismatches`);
  process.exit(failures.length === 0 ? 0 : 1);
}
process.exit(0);
