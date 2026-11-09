#!/usr/bin/env bun
/**
 * Schemathesis against the real app: the SDK contract, under attack
 * ============================================================================
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * Mounts the REAL app (`src/index.ts`, with all installed kons turned on,
 * like the authorization matrix), serves it on 127.0.0.1, writes the OpenAPI
 * of the kon SDK operations —the contract that declares input, output
 * and errors— and launches Schemathesis (https://github.com/schemathesis/schemathesis,
 * MIT) against it with an admin session: thousands of requests generated from
 * the schemas, looking for 500s, responses that do not meet what is declared, and
 * invalid inputs that get accepted.
 *
 * Schemathesis is NOT a dependency of Kitsuden: it runs with `uvx` (or with
 * `SCHEMATHESIS_CMD`) at a PINNED version, only here and in CI.
 *
 * ── WHERE IT RUNS ──────────────────────────────────────────────────────────
 *
 * ONLY against a TEST database (it creates users and runs POST/PUT/DELETE
 * with random data). That is why it requires `NODE_ENV=test`, `KITSUDEN_TEST_DB=postgres`
 * and a database whose name contains `test` (checked by `src/db/index.ts`), and
 * it cuts off every `fetch` request to a host that is not local. Do not run it at the
 * same time as the integration suite: its `clearTestData()` deletes ALL the
 * datasets of that database mid-run.
 *
 *   NODE_ENV=test KITSUDEN_TEST_DB=postgres DATABASE_URL=<test database> \
 *     REDIS_URL=<test valkey> bun run scripts/schemathesis.ts
 *
 *   --baseline-update   accepts this run's failures into the baseline
 *   --baseline-prune    removes from the baseline what this run tested and did not reproduce
 *   --only=<regex>      only the operations whose path matches
 *   --only-installed   only those of the installed kons (not core or API): what
 *                       a kons repository's CI uses
 *   --baseline=<path>   another baseline file (that repository's)
 *   --examples=<n>      cases per operation in the fuzzing phase (25)
 *   --spec-only         writes the OpenAPI and exits (no server or Schemathesis)
 *
 * The baseline (`schemathesis-baseline.json`) holds the ALREADY KNOWN failures:
 * CI fails only on new failures. Fixing one and running `--baseline-prune`
 * removes it from the file. Some failures depend on the generated data and on the
 * state of the database: the baseline is built on NEW databases (like CI),
 * with several `--baseline-update` runs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** PINNED version (two weeks old when it was pinned). */
export const VERSION_SCHEMATHESIS = "4.30.1";

const API_ROOT = resolve(import.meta.dir, "..");
const OUTPUT = join(API_ROOT, ".schemathesis");

// ── 0. Nothing leaves the machine, and only against tests ───────────────────
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  );
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`[schemathesis] fetch blocked to ${url.hostname}`);
  }
  return fetchOriginal(input as never, init);
}) as typeof fetch;

if (process.env.NODE_ENV !== "test" || process.env.KITSUDEN_TEST_DB !== "postgres") {
  console.error(
    "Schemathesis runs random writes: only with NODE_ENV=test and KITSUDEN_TEST_DB=postgres."
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const specOnly = args.includes("--spec-only");
const filter = arg("solo");
const examples = Number(arg("examples") ?? 25);
// A kons repository (kitsuden-kons) tests ITS OWN with its own baseline.
const onlyInstalled = args.includes("--only-installed");
const BASELINE = resolve(arg("baseline") ?? join(API_ROOT, "schemathesis-baseline.json"));

// The limiter (300/min per route and client) would turn the run into 429s.
process.env.RATE_LIMIT_ENABLED = "false";

// ── 1. Turn on all installed kons BEFORE mounting the app ───────────────────
/** The installed kons that are NOT core (for `--only-installed`). */
const externalKons = new Set<string>();
{
  const { listInstalledKons } = await import("../src/lib/installed-kons");
  for (const k of listInstalledKons()) {
    if (k.source !== "core" && k.manifest?.id) externalKons.add(k.manifest.id);
  }
  const ids = new Set<string>(
    listInstalledKons()
      .filter((k) => k.path && k.manifest)
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
  console.log(`[schemathesis] ${ids.size} kons turned on in 'modules'`);
}

const { app } = await import("../src/index");
const { isPgMem } = await import("../src/db");
if (isPgMem) {
  console.error(
    "[schemathesis] The database fell back to pg-mem: a migrated test Postgres is needed."
  );
  process.exit(2);
}
const { mountedOperations } = await import("../../../packages/engine/src/operations");
const { commonComponents, openApiOperation } = await import("../src/lib/operations-openapi");
const { DO_NOT_RUN_WITH_PERMISSION } = await import("../src/middleware/authorization-matrix");

// ── 2. The contract's OpenAPI (SDK operations) ──────────────────────────────
//
// Same document that apps/api/scripts/operations-coverage.ts validates.
// Out go those that touch disk, the repository or the process (the matrix's list)
// and those that only work by calling an outside service, which is cut off here.
const WITH_EXTERNAL_SERVICE = [
  // Asks Facebook to re-read the entry's Open Graph tags.
  "POST /api/blog/{slug}/refresh-og-cache",
  // They download the tournament from start.gg / Matcherino before looking at the database (otherwise,
  // the request's transaction expires waiting on the network).
  "POST /api/esports/import/tournament/{id}/import",
  "POST /api/esports/import/tournament/{id}/prize-pool/sync",
  // The SES adapter downloads the `SubscribeURL` and the SNS signing certificate.
  "POST /api/newsletter/webhook/{provider}",
  // They call the payment provider (Stripe, Lemon Squeezy…).
  "POST /api/payments/checkout",
  "POST /api/payments/portal",
  "POST /api/payments/cancel",
  // Asks storage for a signed download URL.
  "GET /api/dms/files/{fileId}/download",
  // They call the OCR service or a (paid) vision LLM provider.
  "GET /api/ocr-training/overview",
  "POST /api/ocr-training/vision-config/test",
  "POST /api/ocr-training/vision-reprocess/{jobId}",
  "GET /api/ocr-training/health",
  "GET /api/ocr/health",
];
const excludedOnes: string[] = [];
const doc = {
  openapi: "3.1.0",
  info: { title: "Kitsuden — kon SDK operations", version: "schemathesis" },
  servers: [{ url: "/api" }],
  paths: {} as Record<string, Record<string, unknown>>,
  components: commonComponents(),
};
for (const { konId, mountPath, operations: operations } of mountedOperations()) {
  if (onlyInstalled && !externalKons.has(konId)) continue;
  for (const op of operations) {
    const g = openApiOperation(konId, mountPath, op);
    const key = `${op.method} /api${g.path}`;
    const dangerous = DO_NOT_RUN_WITH_PERMISSION.some((p) => {
      const [m, prefix] = p.split(" ");
      return (
        m === op.method && (`/api${g.path}` === prefix || `/api${g.path}`.startsWith(`${prefix}/`))
      );
    });
    if (dangerous || op.input?.format === "multipart" || WITH_EXTERNAL_SERVICE.includes(key)) {
      excludedOnes.push(key);
      continue;
    }
    if (filter && !new RegExp(filter).test(`/api${g.path}`)) continue;
    (doc.paths[g.path] ??= {})[g.method] = g.operation;
  }
}
mkdirSync(OUTPUT, { recursive: true });
const specPath = join(OUTPUT, "openapi.json");
writeFileSync(specPath, JSON.stringify(doc, null, 2));
const total = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(
  `[schemathesis] ${total} operations in ${specPath}; excluded: ${excludedOnes.join(", ") || "none"}`
);
if (specOnly) process.exit(0);

// ── 3. A real admin session (like the matrix) ───────────────────────────────
const { auth } = await import("../src/lib/auth");
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
const user = await ctx.internalAdapter.createUser({
  email: `schemathesis-admin-${stamp}@example.test`,
  name: "Schemathesis",
  emailVerified: true,
  role: "admin",
} as never);
const session = await ctx.internalAdapter.createSession(user.id, false);
const cookie = `${ctx.authCookies.sessionToken.name}=${await sign(session.token)}`;

// ── 4. Serve the app and launch Schemathesis ────────────────────────────────
const serverValue = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  fetch: (req, server) => app.fetch(req, { ip: server.requestIP(req) }),
});
const origin = `http://127.0.0.1:${serverValue.port}`;
console.log(`[schemathesis] app en ${origin}`);

const command = (
  process.env.SCHEMATHESIS_CMD ?? `uvx --from schemathesis==${VERSION_SCHEMATHESIS} st`
).split(" ");
// Neither prune nor update by default: in CI nobody keeps the changed file,
// and failures that depend on generated data come and go.
const baselineArgs = ["--baseline-update", "--baseline-prune"].filter((a) => args.includes(a));
// Asynchronous ON PURPOSE: the app lives in this same process, and a `spawnSync`
// blocks the event loop: the server answers nothing and each request
// from Schemathesis ends in «Read timed out» (it happened on the first run).
const child = Bun.spawn(
  [
    ...command,
    "run",
    specPath,
    "--url",
    `${origin}/api`,
    "--header",
    `Cookie: ${cookie}`,
    // Without Origin, better-auth's CSRF protection rejects writes with a session.
    "--header",
    `Origin: ${process.env.ADMIN_URL || "http://localhost:5173"}`,
    "--phases",
    "examples,coverage,fuzzing",
    "--checks",
    "not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance",
    "--max-examples",
    String(examples),
    "--seed",
    "20261025",
    "--request-timeout",
    "30",
    "--continue-on-failure",
    "--baseline",
    BASELINE,
    ...baselineArgs,
    "--report",
    "junit,ndjson",
    "--report-dir",
    OUTPUT,
  ],
  {
    stdio: ["inherit", "inherit", "inherit"],
    // On Windows the console inherits `utf-8:surrogateescape`, which Schemathesis's `click`
    // does not understand and makes it crash before the first request.
    env: { ...process.env, NO_COLOR: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  }
);
const status = await child.exited;
serverValue.stop(true);
process.exit(status);
