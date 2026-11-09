-- 0064 — External effects of actions, at most once (2026-11-03)
-- ============================================================================
-- The queue delivers at least once: a job that throws after sending an email
-- is retried and sends it again. `ctx.effect(key, fn)` records each external
-- effect here, OUTSIDE the job's transaction, so a retry finds it done and
-- returns its result instead of running it again.
--
-- States, per (scope, key):
--   running  the effect started. If it stays running past the stale time, the
--            process died midway and nobody knows whether it happened: begin
--            answers `unknown` and the action stops, unless it asked to retry.
--   done     it happened; `result` is what it returned.
--   failed   it threw; the next begin runs it again.
--
-- Same permissions as the queue: the application role has no access to the
-- table, only to the two functions below.

CREATE TABLE IF NOT EXISTS kitsuden_action_effects (
  scope text NOT NULL,
  key text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  job_id text,
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CONSTRAINT kitsuden_action_effects_status CHECK (status IN ('running', 'done', 'failed')),
  CONSTRAINT kitsuden_action_effects_key_length CHECK (length(key) BETWEEN 1 AND 500)
);

REVOKE ALL ON kitsuden_action_effects FROM PUBLIC;

-- What to do with an effect:
--   run      nobody ran it, or it failed: it is now `running` for this caller
--   done     already happened: `result` is its result
--   busy     another worker is running it right now
--   unknown  it was left running past `p_stale_ms`: it may or may not have happened
-- With `p_retry_unknown`, an unknown effect is taken over and answered `run`.
CREATE OR REPLACE FUNCTION kitsuden_effect_begin(
  p_scope text, p_key text, p_job_id text, p_stale_ms integer, p_retry_unknown boolean
)
RETURNS TABLE (decision text, result jsonb, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r kitsuden_action_effects%ROWTYPE;
BEGIN
  INSERT INTO kitsuden_action_effects (scope, key, status, job_id)
  VALUES (p_scope, p_key, 'running', p_job_id)
  ON CONFLICT (scope, key) DO NOTHING;
  IF FOUND THEN
    RETURN QUERY SELECT 'run'::text, NULL::jsonb, 1;
    RETURN;
  END IF;

  SELECT * INTO r FROM kitsuden_action_effects e
   WHERE e.scope = p_scope AND e.key = p_key
   FOR UPDATE;

  IF r.status = 'done' THEN
    RETURN QUERY SELECT 'done'::text, r.result, r.attempts;
  ELSIF r.status = 'running'
        AND r.started_at > now() - (GREATEST(p_stale_ms, 0) * interval '1 millisecond') THEN
    RETURN QUERY SELECT 'busy'::text, NULL::jsonb, r.attempts;
  ELSIF r.status = 'running' AND NOT p_retry_unknown THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::jsonb, r.attempts;
  ELSE
    UPDATE kitsuden_action_effects e
       SET status = 'running', attempts = e.attempts + 1, job_id = p_job_id,
           error = NULL, started_at = now(), finished_at = NULL
     WHERE e.scope = p_scope AND e.key = p_key;
    RETURN QUERY SELECT 'run'::text, NULL::jsonb, r.attempts + 1;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_effect_finish(
  p_scope text, p_key text, p_ok boolean, p_result jsonb, p_error text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_action_effects e
     SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
         result = CASE WHEN p_ok THEN p_result ELSE NULL END,
         error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END,
         finished_at = now()
   WHERE e.scope = p_scope AND e.key = p_key AND e.status = 'running';
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_effect_begin(text, text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_effect_finish(text, text, boolean, jsonb, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_effect_begin(text, text, text, integer, boolean) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_effect_finish(text, text, boolean, jsonb, text) TO kitsuden_app;
  END IF;
END $$;
