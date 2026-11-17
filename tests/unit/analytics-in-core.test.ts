/**
 * kon-analytics moved into the core: the data stays, the old kon is not mounted twice
 * ============================================================================
 *
 * Migration 0083 runs on three kinds of database (PGlite):
 *   - a fresh one: it creates the table;
 *   - one that had kon-analytics from 0.8, with its Spanish index names and real counts: the rows stay
 *     and the indexes are renamed in place;
 *   - one that already ran it: nothing changes the second time.
 *
 * And the loader: an installation that still has kon-analytics in packages/kons gets a warning and the
 * core's routes, never the kon mounted on the same path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { ABSORBED_KONS, absorbedReason } from "../../apps/api/src/lib/absorbed-kons";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "apps/api/src/db/migrations/0083_analytics.sql"), "utf8");

/** What kon-analytics 0.8 left: its first migration, Spanish index names. */
const KON_08 = `
  CREATE TABLE analytics_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_type varchar(40) NOT NULL,
    subject_id uuid NOT NULL,
    day date NOT NULL,
    views integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX analytics_views_sujeto_dia_idx ON analytics_views (subject_type, subject_id, day);
  CREATE INDEX analytics_views_tipo_dia_idx ON analytics_views (subject_type, day);
  INSERT INTO analytics_views (subject_type, subject_id, day, views) VALUES
    ('game', '11111111-1111-4111-8111-111111111111', '2026-11-01', 42),
    ('blog_post', '22222222-2222-4222-8222-222222222222', '2026-11-02', 7);
`;

async function indexes(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'analytics_views' ORDER BY 1"
  );
  return r.rows.map((x) => x.indexname);
}

describe("migration 0083", () => {
  it("creates the table on a fresh database, and runs twice without changing anything", async () => {
    const pg = new PGlite();
    await pg.exec(MIGRATION);
    await pg.exec(MIGRATION);
    expect(await indexes(pg)).toEqual([
      "analytics_views_pkey",
      "analytics_views_subject_day_idx",
      "analytics_views_type_day_idx",
    ]);
    await pg.close();
  });

  it("keeps every row of an installation that had kon-analytics 0.8, and renames its indexes in place", async () => {
    const pg = new PGlite();
    await pg.exec(KON_08);
    await pg.exec(MIGRATION);
    const rows = await pg.query<{ subject_type: string; views: number }>(
      "SELECT subject_type, views FROM analytics_views ORDER BY subject_type"
    );
    expect(rows.rows).toEqual([
      { subject_type: "blog_post", views: 7 },
      { subject_type: "game", views: 42 },
    ]);
    expect(await indexes(pg)).toEqual([
      "analytics_views_pkey",
      "analytics_views_subject_day_idx",
      "analytics_views_type_day_idx",
    ]);
    // The counter's upsert still finds its natural key.
    await pg.exec(`
      INSERT INTO analytics_views (subject_type, subject_id, day, views)
      VALUES ('game', '11111111-1111-4111-8111-111111111111', '2026-11-01', 1)
      ON CONFLICT (subject_type, subject_id, day) DO UPDATE SET views = analytics_views.views + 1`);
    const game = await pg.query<{ views: number }>(
      "SELECT views FROM analytics_views WHERE subject_type = 'game'"
    );
    expect(game.rows[0]!.views).toBe(43);
    await pg.close();
  });

  it("has no column for anything that identifies who looks", () => {
    for (const column of [
      "ip",
      "ip_address",
      "user_agent",
      "session",
      "cookie",
      "visitor",
      "fingerprint",
      "referer",
    ]) {
      expect(MIGRATION.toLowerCase(), column).not.toMatch(new RegExp(`^\\s+${column}\\b`, "m"));
    }
  });
});

describe("the old kon", () => {
  it("is absorbed, and the loader says how to remove it instead of mounting it", () => {
    expect(Object.keys(ABSORBED_KONS)).toContain("kon-analytics");
    expect(absorbedReason("kon-analytics")).toMatch(/kitsuden kon remove analytics/);
    expect(absorbedReason("kon-blog")).toBeNull();
  });

  it("the loader checks it before mounting a kon", () => {
    const loader = readFileSync(join(ROOT, "apps/api/src/lib/module-loader.ts"), "utf8");
    const check = loader.indexOf("absorbedReason(kon.id)");
    const mount = loader.indexOf("let mountPath = isGrimoireKon");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(mount);
  });
});
