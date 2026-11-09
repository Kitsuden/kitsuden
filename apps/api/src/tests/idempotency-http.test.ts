/**
 * Idempotency-Key and problem+json against the REAL app (index.ts)
 * ============================================================================
 *
 * The fine rules (concurrency, expiry, Valkey down, secrets) are
 * tested in tests/unit/idempotency.test.ts with controlled stores. Here
 * we check that the real setup —middleware order, authentication,
 * Valkey or the backing table— does the same with real routes:
 *
 *   - POST /api/data-sets with the same key twice → a single dataset;
 *   - POST /api/keys (returns the token in clear) → the retry does NOT repeat the
 *     secret: 409 NOT_REPLAYABLE, and only one key was created;
 *   - real errors (route 404, panel 401) in problem+json with `error`.
 *
 * If there is no store (Valkey down and the role without permission to create the table),
 * the API responds 503 without executing: that path is also checked.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { app } from "../index";

import { isDatabaseAvailable, generateTestId, enterAs } from "./setup";

let dbAvailable = false;
let cookie = "";

function req(route: string, init: RequestInit = {}, extra: Record<string, string> = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  if (init.body) headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Request(`http://localhost:3000${route}`, { ...init, headers });
}

/** Number from the first row of a `count(*)::int AS n` (node-postgres or PGlite). */
async function count(query: ReturnType<typeof sql>): Promise<number> {
  const res = (await db.execute(query)) as unknown as { rows?: Array<{ n: number }> };
  return (res.rows ?? (res as unknown as Array<{ n: number }>))[0]!.n;
}

/** With a store, it runs once; without a store (503 fail-closed), never. */
async function availableStore(res: Response): Promise<boolean> {
  if (res.status !== 503) return true;
  const p = (await res.clone().json()) as { code?: string };
  expect(p.code).toBe("KITSUDEN_E_IDEMPOTENCY_UNAVAILABLE");
  return false;
}

describe("Idempotency-Key in the real app", () => {
  beforeAll(async () => {
    dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) return;
    ({ cookie } = await enterAs(app, {
      email: `idem-admin-${generateTestId()}@example.com`,
      password: "TestPassword123!",
      name: "Idem Admin",
      role: "admin",
    }));
  });

  it("repeated POST /api/data-sets: a single dataset and the same response", async () => {
    if (!dbAvailable) return;
    const slug = `idem-${generateTestId()}`;
    const body = JSON.stringify({
      name: `Idem ${slug}`,
      slug,
      schema: {
        fields: [{ id: "f1", key: "title", type: "text", label: "Title" }],
        version: "2.0",
      },
    });
    const key = { "Idempotency-Key": `create-${slug}` };

    const r1 = await app.request(req("/api/data-sets", { method: "POST", body }, key));
    if (!(await availableStore(r1))) {
      expect(await count(sql`SELECT count(*)::int AS n FROM data_sets WHERE slug = ${slug}`)).toBe(
        0
      );
      return;
    }
    const r2 = await app.request(req("/api/data-sets", { method: "POST", body }, key));

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(await r2.json()).toEqual(await r1.json());

    expect(await count(sql`SELECT count(*)::int AS n FROM data_sets WHERE slug = ${slug}`)).toBe(1);

    // Same key, different body → 422 in problem+json
    const r3 = await app.request(
      req("/api/data-sets", { method: "POST", body: body.replace("Idem", "Other") }, key)
    );
    expect(r3.status).toBe(422);
    expect(r3.headers.get("content-type")).toContain("application/problem+json");
    expect(((await r3.json()) as { code: string }).code).toBe("KITSUDEN_E_IDEMPOTENCY_KEY_REUSED");
  });

  it("POST /api/keys: the token is not stored or repeated; only one key created", async () => {
    if (!dbAvailable) return;
    const name = `Idem key ${generateTestId()}`;
    const key = { "Idempotency-Key": `key-${generateTestId()}` };
    const body = JSON.stringify({ name });

    const r1 = await app.request(req("/api/keys", { method: "POST", body }, key));
    if (!(await availableStore(r1))) return;
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { token: string }).token).toMatch(/^kitsuden_agent_/);

    const r2 = await app.request(req("/api/keys", { method: "POST", body }, key));
    expect(r2.status).toBe(409);
    const p = (await r2.json()) as { code: string; token?: string };
    expect(p.code).toBe("KITSUDEN_E_IDEMPOTENCY_NOT_REPLAYABLE");
    expect(JSON.stringify(p)).not.toContain("kitsuden_agent_");

    expect(
      await count(sql`SELECT count(*)::int AS n FROM agent_identities WHERE name = ${name}`)
    ).toBe(1);
  });

  it("malformed key → 422 KITSUDEN_E_IDEMPOTENCY_KEY_INVALID", async () => {
    if (!dbAvailable) return;
    const r = await app.request(
      req("/api/data-sets", { method: "POST", body: "{}" }, { "Idempotency-Key": "short" })
    );
    expect(r.status).toBe(422);
    expect(((await r.json()) as { code: string }).code).toBe("KITSUDEN_E_IDEMPOTENCY_KEY_INVALID");
  });
});

describe("problem+json on real routes", () => {
  it("nonexistent route → 404 with didYouMean, code and `error`", async () => {
    const res = await app.request(new Request("http://localhost:3000/api/data-setz"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const p = (await res.json()) as Record<string, unknown>;
    expect(p).toMatchObject({
      error: "Not found",
      code: "KITSUDEN_E_NOT_FOUND",
      status: 404,
      retryable: false,
    });
    expect(Array.isArray(p.didYouMean)).toBe(true);
    expect(String(p.docs)).toContain("errors-and-retries.md#kitsuden_e_not_found");
  });

  it("panel without a session → 401 UNAUTHENTICATED", async () => {
    const res = await app.request(new Request("http://localhost:3000/api/admin/agents"));
    expect(res.status).toBe(401);
    const p = (await res.json()) as Record<string, unknown>;
    expect(p.code).toBe("KITSUDEN_E_UNAUTHENTICATED");
    expect(p.error).toBeDefined();
  });

  it("invalid agent key → 401 with the old reason in legacy_code", async () => {
    const res = await app.request(
      new Request("http://localhost:3000/api/data-sets", {
        headers: { Authorization: "Bearer kitsuden_agent_missing00000000000000000" },
      })
    );
    expect(res.status).toBe(401);
    const p = (await res.json()) as Record<string, unknown>;
    expect(p.code).toBe("KITSUDEN_E_UNAUTHENTICATED");
    expect(typeof p.legacy_code).toBe("string");
  });
});
