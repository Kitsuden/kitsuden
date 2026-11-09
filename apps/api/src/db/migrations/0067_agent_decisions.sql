-- 0067 — What an agent chose NOT to do, and why (2026-11-04)
-- ============================================================================
-- The panel showed rejected proposals and friction signals, but not the
-- agent's own choices: an action it considered and discarded leaves no trace.
-- An agent now records them itself (MCP `kitsuden_record_decision`, REST
-- `POST /api/agent/decisions`):
--
--   action        what it did not do ("send the refund email to X")
--   reason        why ("the order is disputed; a person must decide")
--   alternatives  what it did or suggests instead (up to 10 short texts)
--   context       free JSON for whoever reads it (ids, links), at most 16 KiB
--
-- Each row belongs to the agent that wrote it (the session decides it, never
-- the body). An agent reads only its own; admins read all of them. Nobody
-- edits a decision: it is a record, like the audit log. The version of the
-- agent that decided (0066) is kept with it.
--
-- Plain grants for the application role, like the other agent tables.

CREATE TABLE IF NOT EXISTS agent_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  agent_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL,
  trace_id uuid REFERENCES agent_traces(id) ON DELETE SET NULL,
  channel text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_decisions_channel CHECK (channel IN ('rest', 'mcp', 'engine')),
  CONSTRAINT agent_decisions_action_length CHECK (length(action) BETWEEN 1 AND 500),
  CONSTRAINT agent_decisions_reason_length CHECK (length(reason) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS agent_decisions_agent_idx ON agent_decisions (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_decisions_created_idx ON agent_decisions (created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_decisions TO kitsuden_app;
  END IF;
END $$;
