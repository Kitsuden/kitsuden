#!/usr/bin/env bun
/**
 * Seed of the SDK integration run (scripts/sdk/integration.mjs) — TEST DB ONLY
 * ============================================================================
 *
 * Against an API that is already running on a test database:
 *
 *   1. signs up an admin (HTTP sign-up, then `role = admin` in the DB, then
 *      sign-in) and keeps its session cookie;
 *   2. creates two agents with `createAgent`: `direct` (scope `admin`) and
 *      `propose` (scope `admin`, its writes become proposals once the test
 *      turns approvals on);
 *   3. writes `{ cookie, direct: {id, token}, propose: {id, token} }` to the
 *      file given in `--out=` (never to stdout: they are credentials, even
 *      if they only open a throwaway database).
 *
 * Refuses to run unless NODE_ENV=test, KITSUDEN_TEST_DB=postgres, the DB is
 * local and its name contains `test` (and not `prod`).
 */

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const api = arg("api");
const output = arg("out");
if (!api || !output) {
  console.error(
    "usage: bun --no-env-file scripts/sdk-integration-seed.ts --api=<origin> --out=<file>"
  );
  process.exit(2);
}

const url = new URL(process.env.DATABASE_URL ?? "postgres://x/none");
const base = url.pathname.slice(1);
if (
  process.env.NODE_ENV !== "test" ||
  process.env.KITSUDEN_TEST_DB !== "postgres" ||
  !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
  !base.includes("test") ||
  base.includes("prod")
) {
  console.error(
    "[sdk-seed] only against a local test database (NODE_ENV=test, KITSUDEN_TEST_DB=postgres, name with 'test')."
  );
  process.exit(2);
}

const { eq } = await import("drizzle-orm");
const { db } = await import("../src/db");
const { authUsers, agentIdentities } = await import("../src/db/schema");
const { createAgent } = await import("../src/services/agent-auth");

const stamp = Date.now().toString(36);
const email = `sdk-it-admin-${stamp}@example.test`;
const password = `Sdk-It-${stamp}-${Math.random().toString(36).slice(2)}!`;

async function post(route: string, body: unknown) {
  return fetch(`${api}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: api! },
    body: JSON.stringify(body),
  });
}

const high = await post("/api/auth/sign-up/email", {
  email,
  password,
  name: "SDK integration admin",
});
if (high.status !== 200)
  throw new Error(`sign-up → ${high.status}: ${(await high.text()).slice(0, 300)}`);
const [row] = await db
  .update(authUsers)
  .set({ emailVerified: true, role: "admin" })
  .where(eq(authUsers.email, email))
  .returning({ id: authUsers.id });
if (!row) throw new Error("the admin is not in auth_users");
const input = await post("/api/auth/sign-in/email", { email, password });
if (input.status !== 200) throw new Error(`sign-in → ${input.status}`);
const cookies = input.headers.getSetCookie?.() ?? [];
const cookie = (cookies.find((c) => c.includes("session_token=")) ?? "").split(";")[0]!.trim();
if (!cookie) throw new Error("no session cookie");

const direct = await createAgent({
  name: `sdk-it-direct-${stamp}`,
  scopes: ["admin"],
  rateLimit: 100_000,
});
const propose = await createAgent({
  name: `sdk-it-propose-${stamp}`,
  scopes: ["admin"],
  rateLimit: 100_000,
});
await db
  .update(agentIdentities)
  .set({ approvalMode: "direct" } as never)
  .where(eq(agentIdentities.id, direct.agent.id));

writeFileSync(
  output,
  JSON.stringify({
    cookie,
    adminId: row.id,
    direct: { id: direct.agent.id, token: direct.plainApiKey },
    propose: { id: propose.agent.id, token: propose.plainApiKey },
  })
);
console.error(`[sdk-seed] admin + 2 agents → ${output}`);
process.exit(0);
