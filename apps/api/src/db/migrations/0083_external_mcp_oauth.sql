-- 0083 — OAuth for external MCP servers (docs/agents/external-mcp.md, "OAuth")
-- ============================================================================
-- Until now an external MCP server took a static auth header or nothing. Many
-- hosted servers only accept OAuth 2.1 (the MCP authorization specification:
-- protected-resource metadata, authorization-server metadata, PKCE). This adds
-- it as an OPTION next to the header; a server uses one or the other.
--
--   external_mcp_servers.oauth_config   what is not secret: the authorization
--                                       server's endpoints, the client id, the
--                                       scopes and when the access token ends.
--   external_mcp_servers.oauth_secret  the access token, the refresh token and
--                                       the client secret, encrypted with the
--                                       secrets-manager key like the auth
--                                       header (AES-256-GCM). Never returned.
--   external_mcp_oauth_states           one row per authorization in progress:
--                                       the hash of the `state`, the PKCE
--                                       verifier (encrypted) and who started
--                                       it. Single use, ten minutes.
--
-- Number 0082 is left for a migration in review on another branch.

ALTER TABLE external_mcp_servers ADD COLUMN IF NOT EXISTS oauth_config jsonb;
ALTER TABLE external_mcp_servers ADD COLUMN IF NOT EXISTS oauth_secret jsonb;

CREATE TABLE IF NOT EXISTS external_mcp_oauth_states (
  state_hash    text PRIMARY KEY,
  server_id     uuid NOT NULL REFERENCES external_mcp_servers(id) ON DELETE CASCADE,
  -- Encrypted (EncryptedValue). It never leaves the API.
  code_verifier jsonb NOT NULL,
  -- The endpoints and client this authorization was started with: the callback
  -- must finish against the same ones, whatever the server announces by then.
  pending       jsonb NOT NULL,
  started_by    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_mcp_oauth_states_expiry_idx
  ON external_mcp_oauth_states (expires_at);

DO $$
BEGIN
  ALTER TABLE external_mcp_oauth_states ENABLE ROW LEVEL SECURITY;
  ALTER TABLE external_mcp_oauth_states FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS external_mcp_oauth_states_system_only ON external_mcp_oauth_states;
  CREATE POLICY external_mcp_oauth_states_system_only ON external_mcp_oauth_states
    FOR ALL TO PUBLIC
    USING (
      ((current_setting('app.current_user_id', true) = ''
        OR current_setting('app.current_user_id', true) IS NULL)
       AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) = 'admin'
    )
    WITH CHECK (
      ((current_setting('app.current_user_id', true) = ''
        OR current_setting('app.current_user_id', true) IS NULL)
       AND COALESCE(current_setting('app.current_user_role', true), '') = '')
      OR current_setting('app.current_user_role', true) = 'admin'
    );

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON external_mcp_oauth_states TO kitsuden_app;
  END IF;
END $$;
