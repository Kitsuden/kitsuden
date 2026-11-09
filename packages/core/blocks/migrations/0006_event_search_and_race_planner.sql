-- 0006 — Two new blocks the editor offers
-- ============================================================================
-- Idempotent.
--
-- They come from the Umamusume tools, but neither is specific to that game:
--
--   event-search   searches a dataset of events and shows what each option gives
--                  (training events, dialogues, decisions…)
--   race-planner   a dataset with game-specific dates (turn: year, month and
--                  half) laid out on a calendar and filterable
--
-- Same rule as 0002-0005: what the editor offers has to fit in the
-- enum. `ADD VALUE` cannot go inside a transaction; the runner executes
-- statement by statement.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'event-search';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'race-planner';
