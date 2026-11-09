-- ═══════════════════════════════════════════════════════════════════════════
-- auth_sessions: bring the table to the shape the code expects
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The base migration (drizzle/0000_amusing_lethal_legion.sql) created an OLD
-- version of the table:
--
--     id, value, expires_at, created_at, updated_at
--
-- The code (`schema-core.ts`) declares the current better-auth one:
--
--     id, expires_at, token, ip_address, user_agent, user_id, created_at, updated_at
--
-- `value` was renamed `token`, and `user_id`, `ip_address` and
-- `user_agent` were added. Nobody wrote the corresponding migration.
--
-- ── WHY IT WAS SO HARD TO SEE ───────────────────────────────────────────────
--
-- Because the table EXISTED. A check that only looks at table names takes
-- the schema as good and moves on; the failure shows up on the first
-- query that uses one of the new columns. Here that was signing in —
-- exactly the final step of creating the first administrator, after having
-- created the user and credential correctly:
--
--     column "token" of relation "auth_sessions" does not exist
--
-- That is why `scripts/verify-schema.ts` now compares column by column, and not
-- just the list of tables.
--
-- ── ABOUT DELETING THE SESSIONS ─────────────────────────────────────────────
--
-- `token` and `user_id` are NOT NULL, and there is no reasonable value to invent for
-- the old rows: `value` is a token in the old format and `user_id` does not
-- exist anywhere in that row. Since a session is ephemeral by
-- definition, the table is emptied: whoever was signed in signs in again. The
-- cost is one sign-in; the alternative would be to guess which user
-- each session belongs to.

DELETE FROM auth_sessions;

ALTER TABLE auth_sessions DROP COLUMN IF EXISTS value;

ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS token text;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS user_id text;

-- Constraints are added AFTER creating the columns and with the table already
-- empty, which is when NOT NULL can be applied without inventing values.
ALTER TABLE auth_sessions ALTER COLUMN token SET NOT NULL;
ALTER TABLE auth_sessions ALTER COLUMN user_id SET NOT NULL;

-- The token identifies the session: two identical ones would make which one is validated
-- depend on read order.
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_unique ON auth_sessions(token);

-- When a user is deleted, their sessions must die with them; otherwise there remain
-- valid credentials pointing at an account that no longer exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auth_sessions_user_id_fkey'
  ) THEN
    ALTER TABLE auth_sessions
      ADD CONSTRAINT auth_sessions_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE;
  END IF;
END
$$;

-- Every authenticated request looks up the session by its token, and a user's sign-out
-- looks up all of them by user_id.
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
