-- 0068 — Agent data ledger: per-field decisions and evidence per field (2026-11-04)
-- ============================================================================
-- An agent proposes a record (a dataset entry, a row of a kon operation) with the
-- evidence for each field; a person accepts or rejects it FIELD BY FIELD, and may
-- edit a value. See docs/agents/ledger.md and lib/ledger.ts.
--
-- On the proposal:
--   field_diff       the per-field diff computed when the agent proposed it:
--                    `{ target, fields: [{ field, before, after, change }] }`
--   evidence         what the agent attached (`_evidence`), validated:
--                    `[{ field, source, quote, confidence, retrievedAt }]`
--   field_decisions  the reviewer's decision per field, once decided:
--                    `[{ field, decision: "accept" | "reject", value?, edited }]`
--
-- `field_evidence` keeps, once applied, the evidence of each accepted field of
-- the row it landed on. Several rows per field are history: the newest wins.

ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS field_diff jsonb;
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS evidence jsonb;
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS field_decisions jsonb;

CREATE TABLE IF NOT EXISTS field_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `dataset_entry` (data_entries), `table:<name>` (a native table written over
  -- MCP) or `sdk:<kon id>` (a kon operation whose answer carried the row id).
  entity text NOT NULL,
  row_id text NOT NULL,
  -- `title`, `status`, `data.<key>` for an entry; the body key for an operation.
  field text NOT NULL,
  -- The value that was applied (trimmed), to tell later whether the row still
  -- holds what the evidence supports.
  value jsonb,
  source text NOT NULL,
  quote text,
  confidence real,
  retrieved_at timestamptz,
  -- The reviewer changed the agent's value: the evidence backs the agent's value,
  -- not necessarily the one applied.
  edited boolean NOT NULL DEFAULT false,
  proposal_id uuid REFERENCES agent_proposals(id) ON DELETE SET NULL,
  agent_id text,
  accepted_by text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_evidence_field_length CHECK (length(field) BETWEEN 1 AND 300),
  CONSTRAINT field_evidence_source_length CHECK (length(source) BETWEEN 1 AND 2000),
  CONSTRAINT field_evidence_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS field_evidence_row_idx
  ON field_evidence (entity, row_id, field, created_at DESC);
CREATE INDEX IF NOT EXISTS field_evidence_proposal_idx ON field_evidence (proposal_id);

-- RLS. Reading: the system and the human team (admin, editor) see everything; anyone
-- else sees the evidence of a dataset entry only when they can see the entry itself
-- (the subquery runs under data_entries' own policy). Writing: only the system (the
-- execution of an approved proposal, with no request context).
ALTER TABLE field_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS field_evidence_read ON field_evidence;
CREATE POLICY field_evidence_read ON field_evidence FOR SELECT TO PUBLIC USING (
  (COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_user_role', true), '') = '')
  OR current_setting('app.current_user_role', true) IN ('admin', 'editor')
  OR CASE
       WHEN entity = 'dataset_entry' AND row_id ~ '^[0-9a-fA-F-]{36}$'
         THEN EXISTS (SELECT 1 FROM data_entries e WHERE e.id = row_id::uuid)
       ELSE false
     END
);

DROP POLICY IF EXISTS field_evidence_write ON field_evidence;
CREATE POLICY field_evidence_write ON field_evidence FOR ALL TO PUBLIC
  USING (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_user_role', true), '') = ''
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    AND COALESCE(current_setting('app.current_user_role', true), '') = ''
  );
