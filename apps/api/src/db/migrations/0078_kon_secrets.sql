-- Secrets for kons (docs/kons/secrets.md).
--
-- A kon that stores a third party's credential seals it with `ctx.secrets`
-- (AES-256-GCM under the installation's secrets key, bound to the kon's id)
-- and keeps the sealed value in one of its own jsonb columns. Two tables make
-- that safe to operate:
--
--   secret_access_log         one row every time a sealed secret is opened or
--                             refused: which kon, why, for what, on whose
--                             behalf. Never the value. Until now nothing
--                             recorded the reading of a secret.
--
--   kitsuden_secret_columns   where kons keep sealed secrets, written by the
--                             loader from `defineKon({ secretColumns })`. The
--                             rekey script runs offline, with no kon loaded,
--                             and reads this to re-encrypt their rows too.
--
-- Both are system-only (rls-system-only.sql): the log says who touched which
-- credential, and only an administrator reads it, through the API.

CREATE TABLE IF NOT EXISTS secret_access_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kon_id        varchar(100) NOT NULL,
  -- 'opened' or 'refused' (sealed for another kon, tampered with, wrong key).
  outcome       varchar(20)  NOT NULL,
  purpose       varchar(200) NOT NULL,
  -- What the secret belongs to (`connection:<id>`). Free text chosen by the kon.
  subject       varchar(300),
  -- The account on whose behalf it was opened. No foreign key: the log outlives the account.
  actor_user_id text,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS secret_access_log_created_idx ON secret_access_log (created_at DESC);
CREATE INDEX IF NOT EXISTS secret_access_log_kon_idx ON secret_access_log (kon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS secret_access_log_subject_idx ON secret_access_log (subject);

CREATE TABLE IF NOT EXISTS kitsuden_secret_columns (
  kon_id      varchar(100) NOT NULL,
  table_name  varchar(63)  NOT NULL,
  column_name varchar(63)  NOT NULL,
  id_column   varchar(63)  NOT NULL DEFAULT 'id',
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, column_name)
);
