-- agent_api_keys.created_by: the person who minted each key.
--
-- A static agent key (kitsuden_agent_*) is minted by an administrator, but the
-- table did not record which one. When that administrator was later demoted
-- (or their account deleted), the keys they had minted kept working: nothing
-- could tell them apart from the keys of the administrators who remain.
--
-- From now on every place that mints a key writes created_by (the panel's
-- /api/admin/agents and /api/v1/agents routes, /api/keys, the key and rotation
-- routes under /api/v1/agents/:id/keys, and the OAuth consent row). When that
-- person stops being an administrator, the application revokes the live static
-- keys they created (revoked_by = 'system:demotion') and writes an audit entry;
-- see docs/agents/permissions.md ("Who minted a key").
--
-- No foreign key, on purpose (as agent_identities.sponsor_user_id, 0049): with
-- ON DELETE SET NULL a deleted creator would turn their keys into keys with no
-- creator, which keep working. The id stays, and authentication refuses a key
-- whose creator no longer exists.
--
-- Existing keys keep created_by NULL and keep working as before: nobody knows
-- who minted them. Rotate them to bind them to a person.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.

ALTER TABLE agent_api_keys ADD COLUMN IF NOT EXISTS created_by text;

-- The demotion sweep looks up the live keys of one person.
CREATE INDEX IF NOT EXISTS agent_api_keys_created_by_idx
  ON agent_api_keys (created_by)
  WHERE created_by IS NOT NULL AND revoked_at IS NULL;
