-- The password of a data source was stored in the clear in `data_sources.password`,
-- although the route said it encrypted it. It now goes encrypted (AES-256-GCM, the
-- secrets manager's `encryptSecret`) in `encrypted_password`, as
-- {valueEncrypted, iv, authTag}. The name ends in "password" so the table explorer
-- hides it like any other secret column (lib/explorable-tables.ts).
--
-- The existing plaintext values are discarded, not encrypted: the master key lives in
-- the API's environment and SQL cannot reach it. Nothing ever read them (the
-- connection test and the sync were stubs), so the only effect is that an admin has
-- to enter the password again; the API answers `hasPassword: false` for those rows.
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS encrypted_password jsonb;

ALTER TABLE data_sources DROP COLUMN IF EXISTS password;
