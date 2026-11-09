-- 0009 — The block type stops being a Postgres enum
-- ============================================================================
-- Idempotent.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- From 0002 to 0008, SEVEN consecutive migrations did nothing but add
-- values to `block_content_type`. Every new editor block cost a
-- migration against the PRODUCTION database, and `deck` could not be
-- saved in a page waiting for precisely that.
--
-- And for that price the enum only half protected: the blocks of an ARTICLE go
-- in `blog_posts.blocks`, an unconstrained jsonb. Only builder
-- pages went through the enum.
--
-- ── WHAT HAPPENS FROM HERE ON ──────────────────────────────────────────────
--
-- The column is text. The authority on which types are valid is `BLOCK_TYPES`
-- in `blocks.schema.ts`: the publishing route validates against that list and
-- `tests/unit/blocks-that-do-not-fit.test.ts` checks that it contains everything
-- the editor offers. Adding a block is once again adding a line of code.
--
-- The database safety net is lost. This is accepted knowingly: it only covered
-- half of the doors and the other half had been open for years without incident.
--
-- This migration does NOT touch any data: the stored values are the same,
-- only the column type changes.

ALTER TABLE IF EXISTS block_contents  ALTER COLUMN type TYPE varchar(64) USING type::text;
ALTER TABLE IF EXISTS block_templates ALTER COLUMN type TYPE varchar(64) USING type::text;

-- Nobody uses the type any more. If an installation had another column
-- hanging from it, the DROP would fail and take the whole migration down
-- just to clean up something harmless: a warning is given and it moves on.
DO $$
BEGIN
  DROP TYPE IF EXISTS block_content_type;
EXCEPTION
  WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'block_content_type is still used by another column: it is left in place.';
END $$;
