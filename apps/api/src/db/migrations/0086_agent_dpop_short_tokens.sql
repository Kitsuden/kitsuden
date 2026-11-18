-- 0086 — Agent credentials: proof of possession (DPoP) and short-lived tokens
-- ============================================================================
-- docs/agents/dpop-and-short-tokens.md.
--
-- A stolen agent key or OAuth token worked for whoever held it. Two changes:
--
--   · DPoP (RFC 9449): a credential can be BOUND to the thumbprint (`jkt`,
--     RFC 7638) of a public key; it then needs a fresh proof signed with that
--     key on every request. `dpop_jkt` on static keys (set by a person) and on
--     OAuth tokens (set when the token request carried a proof).
--     `require_dpop` on an agent refuses any of its credentials that is not
--     bound and presented with a valid proof.
--   · Short-lived tokens (`kitsuden_ast_*`): an agent trades its long-lived
--     credential for a token of minutes with fewer scopes, and every in-process
--     run gets its own credential (`run_id`), revoked when the run ends. Only
--     the SHA-256 of a token is stored. A row lives on while it is expired so
--     that a proposal made under it can still be executed once a human approves
--     it; the hourly sweep deletes it afterwards (services/agent-audit.ts).
--
-- Unbound credentials work as before. System-only under RLS like the keys
-- (rls-system-only.sql).

ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS dpop_jkt text;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS dpop_jkt text;
ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS require_dpop boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS agent_short_tokens (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  -- The long-lived key it was exchanged from (NULL for a run credential).
  parent_key_id text REFERENCES agent_api_keys(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Path prefix the token is valid on (NULL = any route the scopes open).
  audience text,
  dpop_jkt text,
  -- The in-process run this credential belongs to (NULL = exchanged over HTTP).
  run_id text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_short_tokens_hash_idx ON agent_short_tokens (token_hash);
CREATE INDEX IF NOT EXISTS agent_short_tokens_agent_idx ON agent_short_tokens (agent_id);
CREATE INDEX IF NOT EXISTS agent_short_tokens_parent_idx ON agent_short_tokens (parent_key_id);
CREATE INDEX IF NOT EXISTS agent_short_tokens_expires_idx ON agent_short_tokens (expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_short_tokens TO kitsuden_app;
  END IF;
END $$;
