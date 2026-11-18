-- 0088 — The agent audit log becomes a verifiable, append-only hash chain
-- ============================================================================
-- Until now `agent_audit_logs` was a plain table: anyone with write access to
-- the database could edit a row, delete the evening an agent misbehaved, or
-- lose an agent's whole history by deleting the agent (ON DELETE CASCADE).
-- Nothing would show it. See docs/agents/audit-chain.md.
--
-- What changes:
--
--   1. Every new row carries `seq` (1, 2, 3… with no gaps, one chain for the
--      whole table), `prev_hash` (the previous row's `row_hash`), `row_hash`
--      (sha256 of a canonical form of the row's audited fields + prev_hash) and
--      `mac` (HMAC-SHA256 of row_hash with a key derived from
--      KITSUDEN_SECRETS_KEY; `key_version` says which key). The API computes
--      them (services/agent-audit.ts, lib/audit-chain.ts) inside a transaction
--      that takes the chain's advisory lock; the INSERT trigger below refuses a
--      row that does not extend the current head.
--   2. UPDATE is always refused. DELETE is refused except for retention
--      pruning, which only `kitsuden_audit_prune()` can do: it removes a PREFIX
--      of the chain and first writes a checkpoint (`agent_audit_checkpoints`)
--      so what remains still verifies. TRUNCATE is refused.
--   3. The foreign key to `agent_identities` is dropped. ON DELETE CASCADE
--      erased an agent's history with the agent; ON DELETE SET NULL would be an
--      UPDATE (refused above) that also breaks the row's hash and forgets which
--      agent acted. `agent_id` stays as the id it had: deleting an agent keeps
--      its rows, and the panel shows them without a name.
--
-- Rows written before this migration keep `seq` NULL: they are "legacy", not
-- chained (the MAC needs a key the database does not have, so they cannot be
-- backfilled here). The verifier counts them and skips them; retention prunes
-- them as before.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE … IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER.

ALTER TABLE agent_audit_logs ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE agent_audit_logs ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE agent_audit_logs ADD COLUMN IF NOT EXISTS row_hash text;
ALTER TABLE agent_audit_logs ADD COLUMN IF NOT EXISTS mac text;
ALTER TABLE agent_audit_logs ADD COLUMN IF NOT EXISTS key_version text;

CREATE UNIQUE INDEX IF NOT EXISTS agent_audit_seq_idx ON agent_audit_logs (seq);

-- ── 3. No foreign key: deleting an agent no longer deletes its history ───────
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'agent_audit_logs'::regclass AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE agent_audit_logs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- ── Checkpoints: where the chain starts after a prune ───────────────────────
CREATE TABLE IF NOT EXISTS agent_audit_checkpoints (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The LAST pruned row: the first remaining row has seq = this + 1 and
  -- prev_hash = this row_hash.
  seq                bigint NOT NULL,
  row_hash           text NOT NULL,
  mac                text NOT NULL,
  key_version        text NOT NULL,
  rows_pruned        integer NOT NULL,
  legacy_rows_pruned integer NOT NULL DEFAULT 0,
  pruned_before      timestamptz,
  pruned_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_audit_checkpoints_seq_idx ON agent_audit_checkpoints (seq);

-- ── The guard ───────────────────────────────────────────────────────────────
-- Is the role running this statement the table's owner (or a superuser)? Inside
-- `kitsuden_audit_prune` (SECURITY DEFINER) `current_user` is the function's
-- owner, the role that ran the migrations. The application role is not: setting
-- `kitsuden.audit_prune` by hand does not let it delete.
CREATE OR REPLACE FUNCTION kitsuden_audit_is_owner(p_rel oid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = p_rel), 'MEMBER')
$$;

CREATE OR REPLACE FUNCTION kitsuden_audit_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_seq bigint;
  v_hash text;
  v_cp_seq bigint;
  v_cp_hash text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.seq IS NULL OR NEW.prev_hash IS NULL OR NEW.row_hash IS NULL
       OR NEW.mac IS NULL OR NEW.key_version IS NULL THEN
      RAISE EXCEPTION 'agent_audit_logs is a hash chain: a new row needs seq, prev_hash, row_hash, mac and key_version (written by services/agent-audit.ts)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The head: the last chained row or, after a prune of everything, the last checkpoint.
    SELECT l.seq, l.row_hash INTO v_seq, v_hash
      FROM agent_audit_logs l WHERE l.seq IS NOT NULL ORDER BY l.seq DESC LIMIT 1;
    SELECT c.seq, c.row_hash INTO v_cp_seq, v_cp_hash
      FROM agent_audit_checkpoints c ORDER BY c.seq DESC LIMIT 1;
    IF v_cp_seq IS NOT NULL AND (v_seq IS NULL OR v_cp_seq > v_seq) THEN
      v_seq := v_cp_seq;
      v_hash := v_cp_hash;
    END IF;
    IF v_seq IS NULL THEN
      v_seq := 0;
      v_hash := repeat('0', 64);
    END IF;
    IF NEW.seq <> v_seq + 1 OR NEW.prev_hash <> v_hash THEN
      RAISE EXCEPTION 'agent_audit_logs: row % does not extend the chain (head is %)', NEW.seq, v_seq
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(current_setting('kitsuden.audit_prune', true), '') = 'on'
       AND kitsuden_audit_is_owner(TG_RELID) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'agent_audit_logs is append-only: rows are removed only by retention (kitsuden_audit_prune)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- UPDATE (and TRUNCATE, a statement trigger)
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Checkpoints: written only by the prune, never changed.
CREATE OR REPLACE FUNCTION kitsuden_audit_checkpoint_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND COALESCE(current_setting('kitsuden.audit_prune', true), '') = 'on'
     AND kitsuden_audit_is_owner(TG_RELID) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_audit_checkpoints is written only by kitsuden_audit_prune: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS agent_audit_logs_guard ON agent_audit_logs;
CREATE TRIGGER agent_audit_logs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON agent_audit_logs
  FOR EACH ROW EXECUTE FUNCTION kitsuden_audit_guard();

DROP TRIGGER IF EXISTS agent_audit_logs_no_truncate ON agent_audit_logs;
CREATE TRIGGER agent_audit_logs_no_truncate
  BEFORE TRUNCATE ON agent_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION kitsuden_audit_guard();

DROP TRIGGER IF EXISTS agent_audit_checkpoints_guard ON agent_audit_checkpoints;
CREATE TRIGGER agent_audit_checkpoints_guard
  BEFORE INSERT OR UPDATE OR DELETE ON agent_audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION kitsuden_audit_checkpoint_guard();

DROP TRIGGER IF EXISTS agent_audit_checkpoints_no_truncate ON agent_audit_checkpoints;
CREATE TRIGGER agent_audit_checkpoints_no_truncate
  BEFORE TRUNCATE ON agent_audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION kitsuden_audit_checkpoint_guard();

-- ── Retention: prune a prefix, checkpoint first ─────────────────────────────
-- Removes every chained row up to the newest one created on or before
-- `p_before` (a prefix of the chain: the ones before it go too, even if a
-- clock made one a few ms newer), and the legacy rows (seq NULL) older than
-- `p_before`. Before deleting, it records the last pruned row's seq, row_hash,
-- mac and key_version as a checkpoint: the first remaining row links to it.
--
-- The cutoff must be at least 23 hours old: whoever reaches this function with
-- the application role cannot erase the last day (their own trail). The lock is
-- the writers' (lib/audit-chain.ts, AUDIT_CHAIN_LOCK): no row is added while the
-- prefix is being removed.
CREATE OR REPLACE FUNCTION kitsuden_audit_prune(p_before timestamptz)
RETURNS TABLE (rows_pruned integer, legacy_rows_pruned integer, checkpoint_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_last record;
  v_rows integer := 0;
  v_legacy integer := 0;
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '23 hours' THEN
    RAISE EXCEPTION 'kitsuden_audit_prune: the cutoff must be at least one day in the past'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(7243290401);
  PERFORM set_config('kitsuden.audit_prune', 'on', true);

  SELECT l.seq, l.row_hash, l.mac, l.key_version INTO v_last
    FROM agent_audit_logs l
   WHERE l.seq = (SELECT max(x.seq) FROM agent_audit_logs x
                   WHERE x.seq IS NOT NULL AND x.created_at <= p_before);

  IF v_last.seq IS NOT NULL THEN
    SELECT count(*) INTO v_rows FROM agent_audit_logs WHERE seq <= v_last.seq;
    SELECT count(*) INTO v_legacy FROM agent_audit_logs WHERE seq IS NULL AND created_at <= p_before;
    INSERT INTO agent_audit_checkpoints
      (seq, row_hash, mac, key_version, rows_pruned, legacy_rows_pruned, pruned_before)
    VALUES
      (v_last.seq, v_last.row_hash, v_last.mac, v_last.key_version, v_rows, v_legacy, p_before);
    DELETE FROM agent_audit_logs WHERE seq <= v_last.seq;
  END IF;

  DELETE FROM agent_audit_logs WHERE seq IS NULL AND created_at <= p_before;
  GET DIAGNOSTICS v_legacy = ROW_COUNT;

  PERFORM set_config('kitsuden.audit_prune', 'off', true);
  RETURN QUERY SELECT v_rows, v_legacy, v_last.seq;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_audit_prune(timestamptz) FROM PUBLIC;

-- The application role writes and reads the log; it neither edits nor deletes
-- it, and it only reads checkpoints. (docker/start-with-check.sh repeats this
-- after its blanket GRANT.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON agent_audit_logs FROM kitsuden_app;
    REVOKE ALL ON agent_audit_checkpoints FROM kitsuden_app;
    GRANT SELECT ON agent_audit_checkpoints TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_audit_prune(timestamptz) TO kitsuden_app;
  END IF;
END $$;
