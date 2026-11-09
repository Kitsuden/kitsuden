-- 0049 — The human signer of each agent
-- ============================================================================
-- Idempotent: ADD COLUMN IF NOT EXISTS.
--
-- 1. agent_identities.sponsor_user_id: the human account that SIGNS what the
--    agent creates (author of a blog entry, owner of a dataset
--    entry). NULL = no signer (the previous behavior). Chosen by an admin.
--
--    WITHOUT a foreign key on purpose: if the account is deleted, the id stays and the
--    API knows the agent HAD a signer and it is no longer valid (403
--    KITSUDEN_E_AGENT_SPONSOR_INVALID until an admin reassigns it). With
--    `ON DELETE SET NULL` the agent would silently go back to "no signer".
--
-- 2. agent_proposals.sponsor_user_id: the signer it was proposed with and,
--    after approval, the one it was executed with (agent + signer + approver).

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS sponsor_user_id text;
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS sponsor_user_id text;
CREATE INDEX IF NOT EXISTS agent_identities_sponsor_idx ON agent_identities (sponsor_user_id);
