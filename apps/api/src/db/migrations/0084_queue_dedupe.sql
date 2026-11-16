-- 0084 — Job queue: do not queue the same work twice (docs/install/queue.md)
-- ============================================================================
-- `queue.dispatch(queue, name, payload, { dedupeKey })`: while a job with that
-- key is pending or running on that queue, a second dispatch queues nothing and
-- answers the id of the one already there. Once it is done or dead the key is
-- free again. What a kon uses so that two events about the same record
-- ("identify contact 42") do not become two jobs.
--
-- The application role only INSERTs into the queue (no SELECT), so the
-- "insert unless it is there, and tell me which" lives in a SECURITY DEFINER
-- function, like the rest of the queue's operations.

ALTER TABLE kitsuden_outbox ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS kitsuden_outbox_dedupe_idx
  ON kitsuden_outbox (queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

CREATE OR REPLACE FUNCTION kitsuden_queue_dispatch_unique(
  p_id uuid, p_queue text, p_name text, p_payload jsonb, p_reason text,
  p_user_id text, p_user_role text, p_agent_id text, p_request_id text,
  p_max_attempts integer, p_delay_ms integer, p_cost integer, p_budget_policy text,
  p_dedupe_key text
) RETURNS TABLE (job_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Twice at most: the job that held the key can finish between the INSERT that
  -- found it and the SELECT that looks for it.
  FOR i IN 1..3 LOOP
    INSERT INTO kitsuden_outbox
      (id, queue, name, payload, reason, user_id, user_role, agent_id, request_id,
       max_attempts, run_at, cost, budget_policy, dedupe_key)
    VALUES
      (p_id, p_queue, p_name, p_payload, p_reason, p_user_id, p_user_role, p_agent_id, p_request_id,
       p_max_attempts, now() + (GREATEST(p_delay_ms, 0) * interval '1 millisecond'),
       p_cost, p_budget_policy, p_dedupe_key)
    ON CONFLICT (queue, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running')
      DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, true;
      RETURN;
    END IF;
    SELECT o.id INTO v_id FROM kitsuden_outbox o
     WHERE o.queue = p_queue AND o.dedupe_key = p_dedupe_key
       AND o.status IN ('pending', 'running')
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false;
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'kitsuden_queue_dispatch_unique: could not queue %', p_dedupe_key;
END;
$$;

-- Retrying a dead job puts its key back in use. If another job took the key in
-- the meantime, the retry is refused (false) instead of failing on the index:
-- that work is already queued.
CREATE OR REPLACE FUNCTION kitsuden_queue_retry(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_outbox
     SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL, last_error = NULL
   WHERE id = p_id AND status = 'dead';
  RETURN FOUND;
EXCEPTION WHEN unique_violation THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_queue_dispatch_unique(
  uuid, text, text, jsonb, text, text, text, text, text, integer, integer, integer, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_retry(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_queue_dispatch_unique(
      uuid, text, text, jsonb, text, text, text, text, text, integer, integer, integer, text, text
    ) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_retry(uuid) TO kitsuden_app;
  END IF;
END $$;
