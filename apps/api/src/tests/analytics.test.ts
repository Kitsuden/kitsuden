/**
 * Analytics (docs/analytics.md): what is counted, what is ranked, and what is never stored
 * ============================================================================
 *
 * The whole API on real Postgres. It was kon-analytics; the routes, ids and answers are the same, so the
 * sites that call `/api/analytics` do not change.
 *
 *   · `hit` adds exactly one view per request (also ten at once), drops bots, ignores a number of views
 *     in the body, rejects a bad type or id, and answers a made-up subject exactly like a real one
 *     without counting it;
 *   · `top` sums the window, orders, bounds `limit`, filters by type and by `ids`;
 *   · `subject` returns the series oldest first with its total;
 *   · the table has no column that could identify who looks.
 */

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";

import { db } from "../db";
import { app } from "../index";

import { generateTestId, isDatabaseAvailable } from "./setup";

/** A hex prefix unique to this run (the test id itself has letters a uuid does not take). */
const id = createHash("sha256").update(generateTestId()).digest("hex").slice(0, 12);
/** Uuids unique to this run, so a parallel run or a leftover row never collides. */
const uuid = (n: number) =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-4000-8000-${String(n).padStart(12, "0")}`;
const DATASET = uuid(1);
const DATASET_2 = uuid(2);
const MADE_UP = uuid(99);
/** A subject whose table is not installed in the core (kon-esports): counted all the same. */
const TOURNAMENT = uuid(66);

let dbAvailable = false;
const BROWSER = "Mozilla/5.0 (X11; Linux) Firefox/131.0";

async function rows(query: ReturnType<typeof sql>): Promise<any[]> {
  const result = (await db.execute(query)) as any;
  return Array.isArray(result) ? result : (result.rows ?? []);
}

async function call(method: string, path: string, body?: unknown, agent = BROWSER) {
  const headers = new Headers({
    "user-agent": agent,
    "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.0.1`,
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  const res = await app.request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    })
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, json: parsed, text };
}

const hit = (body: unknown, agent?: string) => call("POST", "/api/analytics/hit", body, agent);

async function viewsOf(subjectId: string): Promise<number> {
  const [r] = await rows(
    sql`SELECT COALESCE(sum(views), 0)::int AS n FROM analytics_views WHERE subject_id = ${subjectId}`
  );
  return Number(r?.n ?? 0);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;
  // Two real datasets: `dataset` is a subject the core itself owns (`data_sets`).
  for (const [subject, slug] of [
    [DATASET, `an-${id}-1`],
    [DATASET_2, `an-${id}-2`],
  ]) {
    await db.execute(
      sql`INSERT INTO data_sets (id, name, slug, schema) VALUES (${subject}, ${`Analytics ${slug}`}, ${slug}, ${"{}"}::jsonb) ON CONFLICT DO NOTHING`
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(
    sql`DELETE FROM analytics_views WHERE subject_id::text LIKE ${`${id.slice(0, 8)}-%`}`
  );
});

afterAll(async () => {
  if (!dbAvailable) return;
  await db.execute(
    sql`DELETE FROM analytics_views WHERE subject_id::text LIKE ${`${id.slice(0, 8)}-%`}`
  );
  await db.execute(sql`DELETE FROM data_sets WHERE slug LIKE ${`an-${id}-%`}`);
});

describe("hit: one request, one view", () => {
  it("two views of the same subject on the same day are one row with 2, and the answer is an empty 204", async () => {
    if (!dbAvailable) return;
    const first = await hit({ type: "dataset", id: DATASET });
    expect(first.status).toBe(204);
    expect(first.text).toBe("");
    await hit({ type: "dataset", id: DATASET });
    const all = await rows(sql`SELECT views FROM analytics_views WHERE subject_id = ${DATASET}`);
    expect(all).toEqual([{ views: 2 }]);
  });

  it("ten views at once are ten: the UPSERT does not lose any", async () => {
    if (!dbAvailable) return;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => hit({ type: "dataset", id: DATASET }))
    );
    expect(results.every((r) => r.status === 204)).toBe(true);
    expect(await viewsOf(DATASET)).toBe(10);
  });

  it("a bot gets the same 204 and counts nothing", async () => {
    if (!dbAvailable) return;
    for (const agent of [
      "Googlebot/2.1",
      "facebookexternalhit/1.1",
      "curl/8.4.0",
      "python-requests/2.31",
    ]) {
      expect((await hit({ type: "dataset", id: DATASET }, agent)).status).toBe(204);
    }
    expect(await viewsOf(DATASET)).toBe(0);
  });

  it("a number of views in the body is ignored, even a negative one", async () => {
    if (!dbAvailable) return;
    await hit({ type: "dataset", id: DATASET, views: -1000, count: 50 });
    expect(await viewsOf(DATASET)).toBe(1);
  });

  it("400 for an unknown type, a bad id, no body or a body that is not JSON", async () => {
    if (!dbAvailable) return;
    expect((await hit({ type: "user", id: DATASET })).status).toBe(400);
    expect((await hit({ type: "dataset", id: "not-a-uuid" })).status).toBe(400);
    expect((await hit(undefined)).status).toBe(400);
    expect((await hit("{not json")).status).toBe(400);
  });

  it("a subject that does not exist answers the same 204 as one that does, and is not counted", async () => {
    if (!dbAvailable) return;
    const real = await hit({ type: "dataset", id: DATASET });
    const fake = await hit({ type: "dataset", id: MADE_UP });
    expect([real.status, real.text]).toEqual([fake.status, fake.text]);
    expect(await viewsOf(MADE_UP)).toBe(0);
  });

  it("a subject whose kon is not installed is still counted, and the request does not break", async () => {
    if (!dbAvailable) return;
    // Only meaningful where the esports kon is NOT installed: with it installed the
    // table exists and a made-up tournament is (correctly) not counted.
    const res = (await db.execute(
      sql`SELECT to_regclass('esports_tournaments') AS t`
    )) as unknown as { t: string | null }[] | { rows: { t: string | null }[] };
    const present = Array.isArray(res) ? res : res.rows;
    if (present[0]?.t) return;
    expect((await hit({ type: "tournament", id: TOURNAMENT })).status).toBe(204);
    expect(await viewsOf(TOURNAMENT)).toBe(1);
  });
});

describe("top: the most viewed in a window", () => {
  it("sums the days of the window, most viewed first, leaving out older days", async () => {
    if (!dbAvailable) return;
    await db.execute(sql`
      INSERT INTO analytics_views (subject_type, subject_id, day, views) VALUES
        ('dataset', ${DATASET}, ${daysAgo(0)}, 3), ('dataset', ${DATASET}, ${daysAgo(2)}, 4),
        ('dataset', ${DATASET_2}, ${daysAgo(1)}, 5), ('dataset', ${DATASET_2}, ${daysAgo(40)}, 100)`);
    const res = await call(
      "GET",
      `/api/analytics/top?type=dataset&days=30&limit=50&ids=${DATASET},${DATASET_2}`
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      type: "dataset",
      days: 30,
      docs: [
        { subjectId: DATASET, views: 7 },
        { subjectId: DATASET_2, views: 5 },
      ],
    });
  });

  it("`ids` with nothing valid returns nothing, never the subjects outside the set", async () => {
    if (!dbAvailable) return;
    await hit({ type: "dataset", id: DATASET });
    const res = await call("GET", "/api/analytics/top?type=dataset&ids=nope,also-nope");
    expect(res.json.docs).toEqual([]);
  });

  it("400 for an unknown type", async () => {
    if (!dbAvailable) return;
    expect((await call("GET", "/api/analytics/top?type=user")).status).toBe(400);
  });
});

describe("subject: one subject's series", () => {
  it("returns the days oldest first, with the total, inside the window", async () => {
    if (!dbAvailable) return;
    await db.execute(sql`
      INSERT INTO analytics_views (subject_type, subject_id, day, views) VALUES
        ('dataset', ${DATASET}, ${daysAgo(1)}, 2), ('dataset', ${DATASET}, ${daysAgo(3)}, 1), ('dataset', ${DATASET}, ${daysAgo(50)}, 9)`);
    const res = await call("GET", `/api/analytics/subject/dataset/${DATASET}?days=7`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ type: "dataset", id: DATASET, days: 7, total: 3 });
    expect(res.json.docs.map((d: { views: number }) => d.views)).toEqual([1, 2]);
  });

  it("a subject with no views is an empty series, not a 404", async () => {
    if (!dbAvailable) return;
    const res = await call("GET", `/api/analytics/subject/dataset/${MADE_UP}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ total: 0, docs: [] });
  });
});

describe("what is never stored", () => {
  it("the table has no column that could identify who looks", async () => {
    if (!dbAvailable) return;
    const cols = (
      await rows(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'analytics_views' ORDER BY 1`
      )
    ).map((r) => r.column_name);
    expect(cols).toEqual([
      "created_at",
      "day",
      "id",
      "subject_id",
      "subject_type",
      "updated_at",
      "views",
    ]);
  });
});
