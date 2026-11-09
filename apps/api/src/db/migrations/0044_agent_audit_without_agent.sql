-- ============================================================================
-- 0044 — Audit authentication attempts by agents that do not exist
-- ============================================================================
--
-- When an agent failed to authenticate with a nonexistent or malformed
-- key, `authenticateAgent` wrote to `agent_audit_logs` with
-- `agent_id = 'unknown'`. That row violates the FK to `agent_identities`
-- (23503): the INSERT failed, the log said "Failed to write agent audit log"
-- and the attempt was NOT recorded. That is: exactly the attempts most worth
-- auditing —someone trying keys— were the only ones that got lost.
--
-- NULL is allowed in `agent_id` instead of creating another table: an authentication
-- failure is one more entry of the same audit (same columns,
-- same queries in the panel and in /metrics), and NULL is exactly "there is no
-- agent". The FK is kept for rows that do have one: NULL does not
-- check it, and an id that does not exist is still an error.
--
-- The table is a system table (`rls-system-only.sql`): its RLS does not change.
-- Idempotent: DROP NOT NULL on a column that already allows NULL does nothing.

ALTER TABLE agent_audit_logs ALTER COLUMN agent_id DROP NOT NULL;

-- Failure rows without an agent are queried by date and action (indexes that
-- already exist); no new index is needed.
