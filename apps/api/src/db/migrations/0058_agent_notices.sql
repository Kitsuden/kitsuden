-- 0058 — Notify the agent when its proposal is resolved
-- ============================================================================
-- Until now the agent only had the `/api/proposals/<id>` URL and polled.
-- Now, when a proposal is executed, fails, is rejected or expires:
--
--   · SIGNED webhook to the URL an admin configures for that agent
--     (`X-Kitsuden-Signature: t=<unix>,v1=<HMAC-SHA256>`), delivered by the
--     Postgres queue: retries with backoff and a "dead letter" in the panel.
--   · SSE event on `GET /api/proposals/<id>/events` (nothing to configure).
--
-- Separate table (and not columns in agent_identities) on purpose: the agent
-- routes do `SELECT *` and return the whole row; the signing secret
-- must never travel, not even encrypted. It is stored encrypted (AES-256-GCM, the same
-- key as the secrets manager) and only shown when created or rotated.

CREATE TABLE IF NOT EXISTS agent_notify_settings (
  agent_id text PRIMARY KEY REFERENCES agent_identities(id) ON DELETE CASCADE,
  url text,
  secret jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_notify_settings TO kitsuden_app;
  END IF;
END $$;
