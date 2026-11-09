-- 0059 — Second opinion on a proposal: does it look like an instruction injection?
-- ============================================================================
-- With INJECTION_CLASSIFIER_URL configured, each new proposal is sent (through
-- the queue, in the background) to a classifier and the result is stored here:
-- `{ "label", "score", "checkedAt" }`. The panel shows it to the reviewer.
--
-- It is a SECOND layer, never the first: it neither approves nor rejects anything on its
-- own (a classifier gives false negatives). The decision remains human.

ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS injection_check jsonb;
