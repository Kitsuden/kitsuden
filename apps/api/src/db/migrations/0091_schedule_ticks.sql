-- 0091 — One replica per scheduled tick (lib/schedule-claim.ts)
-- ============================================================================
-- Every API process runs the same timers: a cron action, and now a kon's
-- `schedules`, fired once per process, so with three replicas the nightly sync
-- ran three times. Each timer now CLAIMS its tick first: the first process to
-- insert (key, tick) runs it; the others find the row and skip. The tick is the
-- scheduled instant (not "now"), the same on every replica.
--
-- The application role reaches the table only through the SECURITY DEFINER
-- function, like the queue.

CREATE TABLE IF NOT EXISTS kitsuden_schedule_ticks (
  key text NOT NULL,
  tick_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  PRIMARY KEY (key, tick_at)
);

REVOKE ALL ON kitsuden_schedule_ticks FROM PUBLIC;

CREATE OR REPLACE FUNCTION kitsuden_schedule_claim(p_key text, p_tick timestamptz, p_by text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO kitsuden_schedule_ticks (key, tick_at, claimed_by)
  VALUES (p_key, p_tick, left(p_by, 200))
  ON CONFLICT (key, tick_at) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- Old claims are worthless once their tick passed: prune now and then, not on every claim.
  IF v_rows = 1 AND random() < 0.02 THEN
    DELETE FROM kitsuden_schedule_ticks WHERE tick_at < now() - interval '7 days';
  END IF;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_schedule_claim(text, timestamptz, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_schedule_claim(text, timestamptz, text) TO kitsuden_app;
  END IF;
END $$;
