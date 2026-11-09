-- 0072 — Two-factor sign-in (TOTP + backup codes) and magic links (2026-11-04)
-- ============================================================================
-- better-auth's `twoFactor` plugin adds one column to the user and one table;
-- `magicLink` needs nothing new (its tokens live in `auth_verifications`,
-- stored hashed: see `storeToken: "hashed"` in lib/auth.ts).
--
-- Columns follow better-auth's field names, mapped by the Drizzle schema in
-- `src/db/schema-core.ts` (`authUsers.twoFactorEnabled`, `authTwoFactors`).
--
--   two_factor_enabled   true once the user has confirmed a TOTP code. Set by
--                        better-auth only; `input: false`, a sign-up cannot set it.
--   auth_two_factors     one row per user: the TOTP secret and the backup
--                        codes, both ENCRYPTED with BETTER_AUTH_SECRET (rotating
--                        that secret makes every enrolment unreadable: users
--                        must enrol again). `verified = false` while the
--                        enrolment waits for its first code.
--
-- RLS: the table is system-only, not even admin (rls-system-only.sql), like
-- `auth_verifications`: only better-auth reads it, and it runs without context.

ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth_two_factors (
  id                        text PRIMARY KEY,
  secret                    text NOT NULL,
  backup_codes              text NOT NULL,
  user_id                   text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  verified                  boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0,
  locked_until              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- better-auth keeps ONE enrolment per user (it updates the row when the user
-- enrols again); the unique index makes two concurrent enables fail instead of
-- leaving two secrets behind.
CREATE UNIQUE INDEX IF NOT EXISTS auth_two_factors_user_id_idx ON auth_two_factors (user_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_two_factors TO kitsuden_app;
  END IF;
END $$;
