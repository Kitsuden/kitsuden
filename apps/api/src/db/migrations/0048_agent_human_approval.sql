-- 0048 — Human approval of what agents request
-- ============================================================================
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS on everything. Running it twice
-- changes nothing.
--
-- 1. agent_identities.approval_mode: `inherit` (the default: the global
--    switch decides), `propose` (everything it writes is held as a proposal)
--    or `direct` (never asks for approval). Validated by the API; no CHECK so that
--    adding a mode does not require another migration.
-- 2. approval_settings: the configuration (one row, `id = 'global'`): the
--    switch, the lifetime of a proposal, what is sensitive per operation and the
--    legacy route rules. No row = the default configuration (OFF).
-- 3. agent_proposals: each held request. The body is stored WITHOUT
--    secrets (a request with secrets cannot be held as a proposal: the
--    API rejects it with KITSUDEN_E_APPROVAL_UNSUPPORTED). The real result of
--    the execution stays here for the agent to read.
--
-- Without RLS on purpose (like agent_quota_usage): only the API and its
-- approval routes (human staff) and status routes (the agent, only its own,
-- filtered in code) touch them. They are not exposed in the data explorer (`/api/items`
-- is admin-only).
--
-- The audit (who turned what on, who proposed, approved or rejected, and the
-- result) goes to agent_audit_logs, with `approval_*` / `proposal_*` actions.

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS approval_mode text NOT NULL DEFAULT 'inherit';

CREATE TABLE IF NOT EXISTS approval_settings (
  id text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  key_id text,
  channel text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  kon_id text,
  operation_id text,
  operation_key text,
  tool text,
  body jsonb,
  content_type text,
  fingerprint text NOT NULL,
  idempotency_key text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL,
  diff jsonb,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,
  decision_comment text,
  executed_at timestamptz,
  result_status integer,
  result_content_type text,
  result_body jsonb,
  result_error text
);

CREATE INDEX IF NOT EXISTS agent_proposals_status_idx ON agent_proposals (status, created_at);
CREATE INDEX IF NOT EXISTS agent_proposals_agent_idx ON agent_proposals (agent_id, created_at);
CREATE INDEX IF NOT EXISTS agent_proposals_fingerprint_idx ON agent_proposals (agent_id, fingerprint);
-- An idempotency key belongs to ONE agent and ONE proposal (NULL does not collide).
CREATE UNIQUE INDEX IF NOT EXISTS agent_proposals_idempotency_idx
  ON agent_proposals (agent_id, idempotency_key);

-- Application role permissions (same as 0046/0047).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON approval_settings TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_proposals TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities TO kitsuden_app;
  END IF;
END $$;
