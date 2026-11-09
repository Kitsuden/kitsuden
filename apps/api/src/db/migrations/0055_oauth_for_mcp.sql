-- 0055 — OAuth 2.1 for MCP (2026-10-28)
-- ============================================================================
-- Idempotent: IF NOT EXISTS on everything. See lib/oauth/ and docs/agents/oauth.md.
--
-- Spec: MCP Authorization 2026-07-28 (OAuth 2.1 + RFC 8414/9728/8707/7591/7009/
-- 9207 + Client ID Metadata Documents).
--
-- What an MCP client (Claude, Cursor…) gets with OAuth is the SAME as
-- with a static key: acting as an EXISTING agent (or one created on the
-- consent screen). That is why each grant hangs from a row of
-- `agent_api_keys` with algorithm = 'oauth' (its key_hash is a marker that never
-- verifies): scopes, denials, approvals, quotas, RLS, signer and
-- audit keep reading that row and the agent, with no parallel path. Revoking
-- that row (the agent's "Keys" tab) cuts the connection just like revoking the
-- grant.
--
-- No secrets in clear: codes, tokens and client secrets are stored
-- as the SHA-256 of the value (all are random 256-bit values; argon2 adds
-- nothing over a secret that cannot be guessed).
--
-- No per-owner RLS: only the API touches them, with system context; they are listed in
-- rls-system-only.sql (system or admin), like agent_api_keys.

-- 1. Clients: registered by DCR (RFC 7591) or read from a Client ID
--    Metadata Document (client_id = URL https).
CREATE TABLE IF NOT EXISTS oauth_clients (
  id text PRIMARY KEY,                         -- the client_id
  kind text NOT NULL DEFAULT 'dcr',            -- 'dcr' | 'cimd'
  client_name text NOT NULL,
  client_uri text,
  logo_uri text,
  software_id text,
  software_version text,
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  grant_types jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  secret_hash text,                            -- confidential clients only
  registered_ip text,
  metadata_expires_at timestamptz,             -- CIMD: when to re-read the document
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_clients_created_at_idx ON oauth_clients (created_at);

-- 2. Authorization requests pending consent (10 min).
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  state text,
  code_challenge text NOT NULL,
  requested_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_expires_idx ON oauth_authorization_requests (expires_at);

-- 3. Grants: a human let a client act as an agent.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  key_id text NOT NULL REFERENCES agent_api_keys(id) ON DELETE CASCADE,
  user_id text NOT NULL,                       -- the human who consented (signer)
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revoked_reason text
);
CREATE INDEX IF NOT EXISTS oauth_grants_agent_idx ON oauth_grants (agent_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON oauth_grants (client_id);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_key_idx ON oauth_grants (key_id);

-- 4. Authorization codes (60 s, single use).
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  family_id text                               -- the family that issued it (to revoke it if reused)
);
CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx ON oauth_codes (expires_at);

-- 5. Access and refresh tokens. A FAMILY = everything that comes from one
--    code; reusing an already spent refresh token revokes the whole family.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL,
  kind text NOT NULL,                          -- 'access' | 'refresh'
  grant_id text NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  family_id text NOT NULL,
  client_id text NOT NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  family_expires_at timestamptz NOT NULL,
  used_at timestamptz,                         -- refresh token already redeemed
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_hash_idx ON oauth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_expires_idx ON oauth_tokens (expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      oauth_clients, oauth_authorization_requests, oauth_grants, oauth_codes, oauth_tokens
      TO kitsuden_app;
  END IF;
END $$;
