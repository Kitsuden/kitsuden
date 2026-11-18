-- 0083 — Analytics in the core: views per subject and day (docs/analytics.md)
-- Idempotent.
--
-- This table was kon-analytics'. An installation that had the kon already has it, with its data:
-- nothing here drops or rewrites a row. A fresh installation gets it created.
--
-- ONE row per (subject, day) with a counter that goes up. No IP, no cookie, no user agent.

CREATE TABLE IF NOT EXISTS analytics_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type varchar(40) NOT NULL,
  subject_id   uuid NOT NULL,
  day          date NOT NULL,
  views        integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A database from the kon's FIRST migration only (0.8, Spanish index names) is brought to the
-- current names in place, as the kon's own 0001 did.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('analytics_views_sujeto_dia_idx', 'analytics_views_subject_day_idx'),
    ('analytics_views_tipo_dia_idx', 'analytics_views_type_day_idx')
  ) AS v(old_name, new_name) LOOP
    IF to_regclass('public.' || quote_ident(r.old_name)) IS NOT NULL
       AND to_regclass('public.' || quote_ident(r.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;

-- The natural key: it is what makes the counter's UPSERT atomic.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_views_subject_day_idx
  ON analytics_views (subject_type, subject_id, day);
-- The front page query: the most viewed of the last N days.
CREATE INDEX IF NOT EXISTS analytics_views_type_day_idx
  ON analytics_views (subject_type, day);
