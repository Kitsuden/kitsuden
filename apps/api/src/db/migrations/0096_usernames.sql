-- 0096 — Sign in with a username as well as the email (2026-11-27)
-- ============================================================================
-- better-auth's `username` plugin (lib/auth.ts) adds ONE column to the user:
--
--   username   optional; unique; stored lower-case. `/api/auth/sign-in/username`
--              looks the account up by it, checks the password and opens the
--              same session `/sign-in/email` would (two-factor and email
--              verification included). Every account keeps its email: the
--              email is still what password reset, magic links and
--              verification use.
--
-- `displayUsername` is turned off in lib/auth.ts, so there is no second column.
--
-- The CHECK repeats the plugin's rules (3–30 characters, a–z 0–9 _ .,
-- lower-case) so a raw INSERT cannot store a name the sign-in would never find
-- (the plugin lower-cases what it looks up) or one with an `@` that reads like
-- someone else's email.
--
-- Who may pick a username: lib/username-policy.ts (`KITSUDEN_USERNAMES`).
-- Idempotent.

ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS username text;

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_username_unique ON auth_users (username);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auth_users_username_shape' AND conrelid = 'auth_users'::regclass
  ) THEN
    ALTER TABLE auth_users
      ADD CONSTRAINT auth_users_username_shape
      CHECK (username IS NULL OR username ~ '^[a-z0-9_.]{3,30}$');
  END IF;
END $$;
