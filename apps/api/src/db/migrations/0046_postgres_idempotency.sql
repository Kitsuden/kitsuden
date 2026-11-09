-- 0046 — Idempotency reservation table (2026-10-23)
-- ============================================================================
-- Idempotent: IF NOT EXISTS on everything.
--
-- The `Idempotency-Key` middleware (lib/idempotency.ts) stores its
-- records in Valkey and, if Valkey is not there, in this table. The code knows how to
-- create it itself on first use (`DDL_IDEMPOTENCY`), but in production the
-- API connects as `kitsuden_app`, which does NOT have CREATE on the schema
-- —and must not—: without this migration, the first retry with Valkey down
-- ended in "permission denied for schema public".
--
-- Same DDL as `DDL_IDEMPOTENCY`; if one changes, the other changes.
--
-- Without RLS on purpose: the key already includes the actor (hash of actor + route +
-- body) and the table is only touched by the middleware, through its own connection.

CREATE TABLE IF NOT EXISTS kitsuden_idempotencia (
  clave text PRIMARY KEY,
  registro jsonb NOT NULL,
  expira_en timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS kitsuden_idempotencia_expira_idx
  ON kitsuden_idempotencia (expira_en);

-- Application role permissions. `start-with-check.sh` grants the same on
-- all tables at every startup; this covers the case of migrating with the
-- runner by hand without going through that script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON kitsuden_idempotencia TO kitsuden_app;
  END IF;
END $$;
