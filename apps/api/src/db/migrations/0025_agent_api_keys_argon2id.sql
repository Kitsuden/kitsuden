-- Migration: Argon2id support in agent_api_keys
-- Adds key_id for lookup of keys with slow hashing (Argon2id)
-- and an algorithm to tell legacy SHA-256 keys from new ones.

ALTER TABLE agent_api_keys
  ADD COLUMN IF NOT EXISTS key_id TEXT,
  ADD COLUMN IF NOT EXISTS algorithm TEXT NOT NULL DEFAULT 'sha256';

-- Unique index for fast lookup by key_id
CREATE UNIQUE INDEX IF NOT EXISTS agent_api_keys_key_id_idx
  ON agent_api_keys (key_id)
  WHERE key_id IS NOT NULL;

-- Backfill: for legacy keys without key_id, keep algorithm='sha256'
UPDATE agent_api_keys
SET algorithm = 'sha256'
WHERE key_id IS NULL;

-- New keys will use 'argon2id' and a non-null key_id
