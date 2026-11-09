-- 0053 — Promotion of code written by agents
-- ============================================================================
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO $$ … $$ on everything.
-- Guide: docs/agents/promotion.md. Code: apps/api/src/lib/promotion.ts.
--
-- 1. agent_identities.promotion_mode: how THAT agent's code is promoted:
--    `suggestion` (the default: always a proposal for a human) or
--    `turbo` (activates by itself only if EVERYTHING passes and nothing widens permissions; and only if the
--    global cap `turboAllowed`, in approval_settings id='code_promotion',
--    allows it). Changed by a human admin.
--
-- 2. code_versions: each draft of an action's code, versioned. The
--    active version is NEVER edited: a change is another row. It stores the code,
--    what it DECLARES (scopes, hosts, limits), its tests, the test
--    and scan reports, the capability diff, the decision and its reason,
--    the inbox proposal, the activation and monitoring, and the
--    rollback (who, when, why). `origin = 'baseline'` is the snapshot
--    of the action BEFORE its first promoted version (so it can be rolled back to);
--    `origin = 'manual'`, a code edit made by hand by a person
--    (admin) in /api/actions, which is also versioned and audited.
--    RLS (rls-owned-tables.sql, "Code promotion"): an agent reads ONLY its own
--    rows; a human admin and the system, all of them; only the system (the
--    API) or a human admin writes.

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS promotion_mode text NOT NULL DEFAULT 'suggestion';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_promotion_mode_chk') THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_promotion_mode_chk CHECK (promotion_mode IN ('suggestion', 'turbo'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS code_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL DEFAULT 'action',
  target_id uuid REFERENCES actions(id) ON DELETE SET NULL,
  target_slug text NOT NULL,
  target_name text NOT NULL,
  version_number integer NOT NULL,
  origin text NOT NULL DEFAULT 'agent',
  agent_id text,
  key_id text,
  sponsor_user_id text,
  channel text NOT NULL DEFAULT 'rest',
  description text,
  code text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  tests jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL,
  base_hash text,
  parent_version_id uuid,
  mode text NOT NULL DEFAULT 'suggestion',
  status text NOT NULL,
  test_report jsonb,
  scan_report jsonb,
  capability_diff jsonb,
  decision jsonb,
  proposal_id uuid REFERENCES agent_proposals(id) ON DELETE SET NULL,
  previous_version_id uuid,
  activated_at timestamptz,
  activated_by text,
  watch_until timestamptz,
  watch jsonb,
  rolled_back_at timestamptz,
  rolled_back_by text,
  rollback_reason text,
  activation_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_versions_origin_chk CHECK (origin IN ('agent', 'baseline', 'manual')),
  CONSTRAINT code_versions_mode_chk CHECK (mode IN ('suggestion', 'turbo')),
  CONSTRAINT code_versions_status_chk CHECK (status IN (
    'awaiting_approval', 'approved', 'active', 'superseded', 'rolled_back', 'rejected', 'expired', 'failed'
  )),
  CONSTRAINT code_versions_agent_chk CHECK (origin <> 'agent' OR agent_id IS NOT NULL)
);

-- A database that already had the table with the checks of the first version
-- of this migration (without `manual`): they are redefined (idempotent).
DO $$
BEGIN
  ALTER TABLE code_versions DROP CONSTRAINT IF EXISTS code_versions_origin_chk;
  ALTER TABLE code_versions ADD CONSTRAINT code_versions_origin_chk CHECK (origin IN ('agent', 'baseline', 'manual'));
  ALTER TABLE code_versions DROP CONSTRAINT IF EXISTS code_versions_agent_chk;
  ALTER TABLE code_versions ADD CONSTRAINT code_versions_agent_chk CHECK (origin <> 'agent' OR agent_id IS NOT NULL);
END $$;

-- Resending the SAME draft does not create another: (agent, action, content fingerprint).
CREATE UNIQUE INDEX IF NOT EXISTS code_versions_dedupe_idx
  ON code_versions (agent_id, target_slug, content_hash) WHERE origin = 'agent';
CREATE UNIQUE INDEX IF NOT EXISTS code_versions_number_idx ON code_versions (target_slug, version_number);
-- Only one active version per action.
CREATE UNIQUE INDEX IF NOT EXISTS code_versions_one_active_idx
  ON code_versions (target_slug) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS code_versions_agent_idx ON code_versions (agent_id, created_at);
CREATE INDEX IF NOT EXISTS code_versions_status_idx ON code_versions (status, created_at);
CREATE INDEX IF NOT EXISTS code_versions_proposal_idx ON code_versions (proposal_id);
CREATE INDEX IF NOT EXISTS code_versions_watch_idx
  ON code_versions (watch_until) WHERE status = 'active' AND watch_until IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON code_versions TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities TO kitsuden_app;
  END IF;
END $$;
