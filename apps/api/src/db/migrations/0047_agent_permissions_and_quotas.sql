-- 0047 — Fine-grained permissions, keys and quotas for agents
-- ============================================================================
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS on everything. Running it twice
-- changes nothing.
--
-- 1. agent_api_keys: name, revocation (the row STAYS for auditing: before,
--    revoking was a DELETE and the key's trace disappeared) and which key
--    it comes from when rotated. Expiry (`expires_at`) and last use
--    (`last_used_at`) already existed.
-- 2. agent_identities: quotas per UTC day. NULL = no limit. `rate_limit`
--    (requests per minute) already existed.
-- 3. agent_quota_usage: the daily counter when Valkey is not there (the reservation;
--    with Valkey up, counting happens there). Without RLS on purpose: only the
--    quota middleware touches it, and the key is the agent, not a user.
--
-- Scopes remain in `agent_identities.scopes` (jsonb): fine-grained ones
-- (`kon:<kon>:<op>`, `datasets:<slug>:<action>`) and denials
-- (`!pattern`) are text in the same list. No new column is needed.

ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS revoked_by text;
ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS rotated_from text;

CREATE INDEX IF NOT EXISTS agent_api_keys_revoked_at_idx ON agent_api_keys (revoked_at);

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS writes_per_day integer;
ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS budget_units_per_day integer;

CREATE TABLE IF NOT EXISTS agent_quota_usage (
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  day date NOT NULL,
  writes integer NOT NULL DEFAULT 0,
  units integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, day)
);

-- Application role permissions (same as 0046): `start-with-check.sh`
-- grants the same at every startup; this covers migrating with the runner by hand.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_quota_usage TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_api_keys TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities TO kitsuden_app;
  END IF;
END $$;
