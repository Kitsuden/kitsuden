-- 0076 — Per-record change history (2026-11-11)
-- ============================================================================
-- The panel's record page had no history to show beyond the row's own timestamps:
-- nothing kept who changed a record, when, or what. `agent_audit_logs` is the
-- agents' own trail (one row per call, deleted with the agent, pruned after 90
-- days) and `audit_logs` (0022) was never written. This table is the history of
-- a RECORD, addressed like `field_evidence` (0068):
--
--   entity   `dataset_entry` (data_entries) or `table:<name>` (a kon or model
--            table, whichever route wrote it)
--   row_id   the record's primary key, as text
--   action   create | update | delete
--   actor_*  who did it: a person (`user`), an agent (`agent`) or the system.
--            The name is the one they had then: the row outlives the account.
--   changes  `[{ field, before?, after?, redacted? }]`, only the fields that
--            changed. A secret column (token, password, hash) is listed as
--            `redacted` and its values are never stored; long values are cut.
--   proposal_id / approved_by   set when the write was an approved proposal.
--
-- Written by lib `recordChange` (packages/engine/src/record-history.ts) in the
-- same transaction as the write.

CREATE TABLE IF NOT EXISTS record_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL,
  row_id text NOT NULL,
  action text NOT NULL,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id text,
  actor_name text,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The list or one of its values was cut to stay within the size limit.
  truncated boolean NOT NULL DEFAULT false,
  proposal_id uuid,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT record_changes_action CHECK (action IN ('create', 'update', 'delete')),
  CONSTRAINT record_changes_actor_type CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT record_changes_entity_length CHECK (length(entity) BETWEEN 1 AND 300),
  CONSTRAINT record_changes_row_id_length CHECK (length(row_id) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS record_changes_row_idx
  ON record_changes (entity, row_id, created_at DESC);
CREATE INDEX IF NOT EXISTS record_changes_created_idx ON record_changes (created_at);

-- RLS, the same shape as `field_evidence`. Reading: the system and the human
-- team (admin, editor) see everything; anyone else sees the history of a dataset
-- entry only when they can see the entry itself (the subquery runs under
-- data_entries' own policy), and never the history of another table. Writing:
-- only the system (`recordChange` writes as the system inside the request's
-- transaction).
ALTER TABLE record_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_changes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS record_changes_read ON record_changes;
CREATE POLICY record_changes_read ON record_changes FOR SELECT TO PUBLIC USING (
  (COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_user_role', true), '') = '')
  OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
  OR CASE
       WHEN entity = 'dataset_entry' AND row_id ~ '^[0-9a-fA-F-]{36}$'
         THEN EXISTS (SELECT 1 FROM data_entries e WHERE e.id = row_id::uuid)
       ELSE false
     END
);

DROP POLICY IF EXISTS record_changes_write ON record_changes;
CREATE POLICY record_changes_write ON record_changes FOR ALL TO PUBLIC
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_user_role', true), '') = ''
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_user_role', true), '') = ''
  );
