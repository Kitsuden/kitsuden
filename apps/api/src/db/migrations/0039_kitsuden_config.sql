-- kitsuden_config: the table that kon-media created on the fly
-- ============================================================================
--
-- `packages/core/media/media.routes.ts` stored its configuration in a table
-- `kitsuden_config` that it created itself on every save:
--
--     await ctx.db.instance.execute(sql`
--       CREATE TABLE IF NOT EXISTS kitsuden_config (...)
--     `);
--
-- And no migration created it, so in production the table DOES NOT EXIST: the
-- the API connects with a role that has no CREATE privilege, the CREATE fails, the INSERT
-- that follows fails too, and `POST /api/media/config` returns 500. Saving the
-- kon-media configuration has never worked on a server.
--
-- The read path also swallowed the error with an empty `catch {}` commented
-- "Table might not exist yet", so it returned the default configuration and
-- it looked like nothing had been saved — instead of saving being impossible.
--
-- ── DEBT THIS DOES NOT RESOLVE ─────────────────────────────────────────────
--
-- kon settings already live in `modules.settings`, which is where the
-- panel writes. `kitsuden_config` is a SECOND store for the same thing. It is created here
-- so that the existing code works, but unifying them is a pending
-- design decision, not something that should sneak into a migration.

CREATE TABLE IF NOT EXISTS kitsuden_config (
  key        VARCHAR(100) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
