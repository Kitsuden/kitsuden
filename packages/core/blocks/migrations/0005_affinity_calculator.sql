-- 0005 — New block the editor offers: affinity (affinity calculator)
-- ============================================================================
-- Idempotent.
--
-- It comes from the Umamusume load: the game stores tables of KINSHIP between
-- characters (`succession_relations`), and with them you can calculate how much
-- affinity there is between the trainee and the chosen pair of parents.
--
--   affinity   two or more dataset rows and the kinship points they
--              share, summed by pairs in the inheritance tree
--
-- Same rule as 0002, 0003 and 0004: what the editor offers has to fit
-- in the enum. `ADD VALUE` cannot go inside a transaction; the runner executes
-- statement by statement.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'affinity';
