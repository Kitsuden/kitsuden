-- 0008 — The "deck" block: a deck embedded in an article or a page
-- ============================================================================
-- Idempotent.
--
-- The editor offers it to show decks inside articles, and 0007 left it out: it added `card-browser`, `deck-builder` and
-- `deck-showcase`, but not `deck`. In an ARTICLE it went unnoticed
-- (`blog_posts.blocks` is unconstrained jsonb); in a builder
-- PAGE, the INSERT into `block_contents` failed with an invalid
-- enum value.
--
-- Same rule as 0002-0007: what the editor offers has to fit in the
-- enum. `ADD VALUE` cannot go inside a transaction; the runner executes
-- statement by statement.

ALTER TYPE block_content_type ADD VALUE IF NOT EXISTS 'deck';
