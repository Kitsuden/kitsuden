-- ═══════════════════════════════════════════════════════════════════════════
-- The two authentication tables that no migration ever created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `auth_users` and `auth_sessions` are created by the base migration
-- (drizzle/0000_amusing_lethal_legion.sql). `auth_accounts` and
-- `auth_verifications` are declared by `src/db/schema-core.ts` and **nobody created
-- them**.
--
-- Consequence: on a clean database it was IMPOSSIBLE to create the first
-- administrator. The «System Init» screen returned 500 and the log said
--
--     relation "auth_accounts" does not exist
--
-- better-auth stores the user in `auth_users` and the CREDENTIAL in
-- `auth_accounts` (provider_id = 'credential'), so the insert failed
-- halfway: the user was created and the password was not. With the user already present,
-- retrying did not fix anything either.
--
-- It had not been detected because nobody had ever started against an
-- empty database: existing installations had those tables from before the
-- schema was moved to migrations.
--
-- The columns are copied from `schema-core.ts`, which is what the application
-- queries. If they diverge, `tests/unit/core-schema-drift.test.ts` detects it
-- by running a real SELECT against the migrated schema.

CREATE TABLE IF NOT EXISTS auth_accounts (
  id                       text PRIMARY KEY,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  user_id                  text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  -- Password hash for the 'credential' provider. Never in the clear.
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- better-auth looks up the credential by (user_id, provider_id) on every
-- login; without an index that is a full scan on every attempt.
CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx ON auth_accounts(user_id);
CREATE INDEX IF NOT EXISTS auth_accounts_provider_idx ON auth_accounts(provider_id, account_id);

CREATE TABLE IF NOT EXISTS auth_verifications (
  id         text PRIMARY KEY,
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Verifications are always looked up by `identifier` (email or token) and are
-- purged by `expires_at`.
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications(identifier);
CREATE INDEX IF NOT EXISTS auth_verifications_expires_idx ON auth_verifications(expires_at);
