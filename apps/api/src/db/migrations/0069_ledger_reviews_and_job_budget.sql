-- 0069 — Agent work queue: budget per job and later reviews (2026-11-04)
-- ============================================================================
-- 1. A job queued by an agent is charged to the agent's daily budget when it
--    RUNS (lib/queue.ts). `cost` is what it costs (NULL = the default,
--    QUEUE_AGENT_JOB_COST); `budget_policy` says what happens when the budget is
--    spent: `postpone` (to the next UTC day, the attempt is not used) or `fail`
--    (dead letter with the reason). NULL = QUEUE_BUDGET_EXHAUSTED.
-- 2. `ledger_reviews`: a person asks to look again, later, at what was decided on
--    a proposal. A queue job with a run date turns it `due` at that time; the
--    inbox lists the due ones. Same access as `agent_proposals`: the API reads it
--    with the system's connection and only the human team reaches its routes.

ALTER TABLE kitsuden_outbox ADD COLUMN IF NOT EXISTS cost integer;
ALTER TABLE kitsuden_outbox ADD COLUMN IF NOT EXISTS budget_policy text;

-- A running job goes back to pending without spending an attempt, to run after
-- `p_seconds` (the budget opens again). Only the worker that holds it.
CREATE OR REPLACE FUNCTION kitsuden_queue_postpone(
  p_id uuid, p_worker text, p_seconds integer, p_reason text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_outbox
     SET status = 'pending',
         attempts = GREATEST(attempts - 1, 0),
         run_at = now() + make_interval(secs => GREATEST(p_seconds, 1)),
         locked_until = NULL,
         locked_by = NULL,
         last_error = left(p_reason, 2000)
   WHERE id = p_id AND status = 'running' AND locked_by = p_worker;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_queue_postpone(uuid, text, integer, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_queue_postpone(uuid, text, integer, text) TO kitsuden_app;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ledger_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES agent_proposals(id) ON DELETE CASCADE,
  -- The row the proposal wrote, when known (`dataset_entry` + id, …).
  entity text,
  row_id text,
  -- The fields to look at again (empty = the whole proposal).
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  scheduled_by text NOT NULL,
  job_id uuid,
  became_due_at timestamptz,
  done_by text,
  done_at timestamptz,
  done_comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_reviews_status CHECK (status IN ('scheduled', 'due', 'done', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS ledger_reviews_status_idx ON ledger_reviews (status, due_at);
CREATE INDEX IF NOT EXISTS ledger_reviews_proposal_idx ON ledger_reviews (proposal_id);
