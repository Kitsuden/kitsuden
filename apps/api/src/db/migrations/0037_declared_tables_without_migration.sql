-- ═══════════════════════════════════════════════════════════════════════════
-- Tables declared in schema-core.ts that no migration created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by `scripts/verify-schema.ts` when comparing against a
-- REAL freshly initialized Postgres. The equivalent check with pg-mem was no good:
-- it does not understand part of the migrations' SQL and reported as absent tables that
-- do exist in Postgres.
--
-- `kitsuden_secrets` deserves a separate explanation. The secrets service ran
-- a hot `CREATE TABLE IF NOT EXISTS` at startup, and when it failed
-- it logged «[Secrets] Boot injection skipped (DB unavailable?)». The database
-- was perfectly available: what was missing was the table, and the message
-- blamed the connection.
--
-- That workaround also can no longer work: since the API connects with an
-- unprivileged role —so that RLS is actually applied— it has no CREATE on
-- the schema. And rightly so: creating tables is a migration's job,
-- not a service starting up.

-- ── Agent audit ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  key_id        text,
  action        text NOT NULL,
  resource      text,
  resource_id   text,
  details       jsonb DEFAULT '{}'::jsonb,
  ip_address    text,
  user_agent    text,
  duration_ms   integer,
  success       boolean NOT NULL DEFAULT true,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_audit_agent_id_idx   ON agent_audit_logs(agent_id);
CREATE INDEX IF NOT EXISTS agent_audit_created_at_idx ON agent_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS agent_audit_action_idx     ON agent_audit_logs(action);

-- ── Connections to external sources ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'data_source_type') THEN
    CREATE TYPE data_source_type AS ENUM
      ('postgresql', 'mysql', 'mongodb', 'redis', 'api', 'webhook');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS data_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  type         data_source_type NOT NULL,
  host         text,
  port         integer,
  database     text,
  username     text,
  -- Credential of the external source. It is advisable to store it as a secret and leave
  -- only the reference here; today the schema accepts it in the clear.
  password     text,
  url          text,
  headers      jsonb DEFAULT '{}'::jsonb,
  is_active    boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_sources_type_idx       ON data_sources(type);
CREATE INDEX IF NOT EXISTS data_sources_is_active_idx  ON data_sources(is_active);
CREATE INDEX IF NOT EXISTS data_sources_created_at_idx ON data_sources(created_at);

-- ── Secrets manager (AES-256-GCM) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kitsuden_secrets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              varchar(200) NOT NULL,
  -- Encrypted value in hexadecimal. Never in the clear, nor in logs.
  value_encrypted  text NOT NULL,
  iv               varchar(32) NOT NULL,
  auth_tag         varchar(32) NOT NULL,
  description      text,
  category         varchar(100) NOT NULL DEFAULT 'general',
  auto_inject      boolean NOT NULL DEFAULT true,
  last_rotated_at  timestamptz,
  last_injected_at timestamptz,
  created_by_id    text REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The key identifies the secret: two rows with the same one would make which one is
-- injected depend on read order.
CREATE UNIQUE INDEX IF NOT EXISTS kitsuden_secrets_key_unique ON kitsuden_secrets(key);
