-- 0052 — MCP: per-agent settings and per-day format savings (2026-10-28)
-- ============================================================================
-- Idempotent: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS on everything.
--
-- 1. agent_identities.mcp_settings: what the panel sets for the agent's
--    MCP sessions. Today two keys (see lib/mcp-settings.ts):
--      toolset        default tool set (`read`, `kon:blog`…).
--                     It only NARROWS what `allowedTools` and the scopes allow;
--                     `?toolset=` on connect narrows further, never widens.
--      untrustedWrap  how to wrap text written by third parties in the
--                     results: `none` (the default, as always),
--                     `delimiters` or `object`. See docs/agents/untrusted-content.md.
--    `{}` = nothing set = the behavior from before this migration.
--
-- 2. agent_format_savings: what the `auto` format saved versus compact
--    JSON, per agent, UTC day and channel (`mcp` | `rest`). Counters only:
--    no arguments, no responses, no user identity. Without RLS on purpose
--    (like agent_quota_usage): only the API writes it and only the admin panel
--    reads it; the key is the agent, not a person.

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS mcp_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS agent_format_savings (
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  day date NOT NULL,
  channel text NOT NULL DEFAULT 'mcp',
  responses integer NOT NULL DEFAULT 0,
  -- responses where `auto` chose something that was not JSON
  compacted integer NOT NULL DEFAULT 0,
  json_bytes bigint NOT NULL DEFAULT 0,
  sent_bytes bigint NOT NULL DEFAULT 0,
  json_tokens_est bigint NOT NULL DEFAULT 0,
  sent_tokens_est bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, day, channel)
);

CREATE INDEX IF NOT EXISTS agent_format_savings_day_idx ON agent_format_savings (day);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_format_savings TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities TO kitsuden_app;
  END IF;
END $$;
