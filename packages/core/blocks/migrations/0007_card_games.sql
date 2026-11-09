-- 0007 — Three new blocks the editor offers: card games
-- ============================================================================
-- Idempotent.
--
-- None of them is specific to one game: all three
-- read kon-cardsim and kon-deckshow, so they work for any loaded TCG.
--
--   card-browser    the card catalog of a game, with search and filters
--                   by the properties each card carries (cost, type,
--                   color, rarity…)
--   deck-builder    build a deck against the game rules (size,
--                   copies, banlist, per-group limits) with live
--                   validation and a test hand
--   deck-showcase   the showcase: the published decks of that game, with their
--                   author and their "likes"
--
-- Same rule as 0002-0006: what the editor offers has to fit in the
-- enum. `ADD VALUE` cannot go inside a transaction; the runner executes
-- statement by statement.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'card-browser';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'deck-builder';
ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'deck-showcase';
