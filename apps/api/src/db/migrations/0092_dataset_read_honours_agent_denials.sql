-- data_entries_dataset_read honours an agent's per-dataset denial.
--
-- The policy opens every entry of a dataset whose policy_json says
-- `readAccess: public` (or `authenticated`, with a session) and has no rlsRules.
-- It did not look at the agent's scopes, so an agent with `!datasets:<slug>:read`
-- (or a broader denial such as `!datasets:*`) was still let through by
-- Postgres for a public dataset. The application refuses it (canViewDataset in
-- packages/core/datasets/datasets.policy.ts); the database is the second line
-- and now says the same. A denial wins, as everywhere else.
--
-- kitsuden_agent_denied comes from agent-functions.sql, which the migration
-- runner applies before any pending migration. Without app.agent_scopes
-- (humans, anonymous, the system) it returns false, so nothing changes for them.
--
-- Idempotent: the policy is dropped and created again (CREATE POLICY has no
-- OR REPLACE, and the RLS applier swallows "already exists"). rls-policies.sql
-- holds the same text and runs after the migrations.

DROP POLICY IF EXISTS data_entries_dataset_read ON data_entries;

CREATE POLICY data_entries_dataset_read ON data_entries
    FOR SELECT
    TO PUBLIC
    USING (
        data_set_id IN (
            SELECT ds.id FROM data_sets ds
            WHERE (
                ds.policy_json->>'readAccess' = 'public'
                OR (
                    ds.policy_json->>'readAccess' = 'authenticated'
                    AND COALESCE(current_setting('app.current_user_id', true), '') <> ''
                )
            )
            AND COALESCE(
                jsonb_array_length(
                    CASE WHEN jsonb_typeof(ds.policy_json->'rlsRules') = 'array'
                         THEN ds.policy_json->'rlsRules' END
                ), 0) = 0
            AND NOT kitsuden_agent_denied('datasets:' || ds.slug || ':read')
        )
    );
