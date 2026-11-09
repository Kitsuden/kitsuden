-- Why a job was queued, in the words of whoever queued it. Optional, for people and
-- agents reading the queue later.
ALTER TABLE kitsuden_outbox ADD COLUMN IF NOT EXISTS reason text;

DROP FUNCTION kitsuden_queue_dead(integer);

CREATE OR REPLACE FUNCTION kitsuden_queue_dead(p_limit integer)
RETURNS TABLE (
  id uuid, queue text, name text, reason text, attempts integer, max_attempts integer,
  last_error text, user_id text, agent_id text, created_at timestamptz, finished_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT o.id, o.queue, o.name, o.reason, o.attempts, o.max_attempts, o.last_error,
         o.user_id, o.agent_id, o.created_at, o.finished_at
    FROM kitsuden_outbox o
   WHERE o.status = 'dead'
   ORDER BY o.finished_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(p_limit, 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_queue_dead(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_queue_dead(integer) TO kitsuden_app;
  END IF;
END $$;
