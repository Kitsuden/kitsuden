-- 0070 — External MCP servers and the review of their tools (2026-11-04)
-- ============================================================================
-- Kitsuden is an MCP server; this is the first piece of it as a CLIENT. An
-- administrator registers an external MCP server; a refresh connects, reads
-- `tools/list` and keeps a fingerprint of each tool (SHA-256 of its name,
-- description and input schema). A tool that is new, changed or gone is
-- `needs_review` until a PERSON approves the fingerprint they saw. Agents do
-- not call these tools yet: this is the review gate for when they can
-- (lib/external-mcp.ts, docs/agents/external-mcp.md).
--
-- `auth_header_value` is encrypted with the secrets-manager key (AES-256-GCM,
-- services/secrets.ts) and never returned by the API.
--
-- Both tables are system tables: admin or system context only (the same
-- policy as `rls-system-only.sql`, which also lists them), and no generic
-- route writes them (`TABLES_ONLY_VIA_THEIR_ROUTE`).

CREATE TABLE IF NOT EXISTS external_mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  auth_header_name text,
  auth_header_value jsonb,
  enabled boolean NOT NULL DEFAULT true,
  last_refreshed_at timestamptz,
  last_error text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_mcp_servers_name_length CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT external_mcp_servers_url_length CHECK (length(url) BETWEEN 1 AND 2000)
);

CREATE TABLE IF NOT EXISTS external_mcp_tools (
  server_id uuid NOT NULL REFERENCES external_mcp_servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  input_schema jsonb,
  -- What the server announces now (or announced last, if it is gone).
  fingerprint text NOT NULL,
  -- What a person approved. A tool is usable only while both are equal.
  approved_fingerprint text,
  status text NOT NULL DEFAULT 'needs_review',
  -- Why it needs review: new, changed or removed (NULL once approved).
  change text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  PRIMARY KEY (server_id, name),
  CONSTRAINT external_mcp_tools_status CHECK (status IN ('approved', 'needs_review')),
  CONSTRAINT external_mcp_tools_change CHECK (change IS NULL OR change IN ('new', 'changed', 'removed'))
);

CREATE INDEX IF NOT EXISTS external_mcp_tools_review_idx
  ON external_mcp_tools (server_id) WHERE status = 'needs_review';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['external_mcp_servers', 'external_mcp_tools'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_solo_sistema', t);
    EXECUTE format($POLICY$
      CREATE POLICY %I ON %I
        FOR ALL
        TO PUBLIC
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
        )
    $POLICY$, t || '_solo_sistema', t);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON external_mcp_servers TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON external_mcp_tools TO kitsuden_app;
  END IF;
END $$;
