-- ============================================================================
-- 0051 — Agent memory (brain): owner, visibility, claims with evidence and
--        provenance of connections (2026-10-28)
-- ============================================================================
-- Idempotent: IF NOT EXISTS everywhere; the backfills only touch rows that
-- have not been classified yet.
--
-- 1. OWNER ON NOTES. `brain_notes` was global: no user, no agent, no tenant.
--    Now a note has an owner (a user OR an agent) and, when an agent writes
--    it and has a human signer (0049), that signer. `visibility`:
--      private  only the owner, the agent's signer and admin (DEFAULT)
--      shared   also the team (admin, editor) and agents with brain:read
--    EXISTING notes become `shared`: they are the project knowledge the
--    scanner produced (schemas, routes, kons) and everyone with access used
--    to see them; making them private would hide them from every agent.
--    The trick: the column is added with DEFAULT 'shared' (so the existing
--    rows get it) and the default is switched to 'private' right after.
--    The policies live in rls-owned-tables.sql (applied after migrations).
--
--    `note_key`: a key the owner chooses (`project-x/decisions`). Writing the
--    same key again updates the same note: that is what makes
--    `brain_note_write` idempotent. Unique per owner, not globally.
--
--    `embedding_kind`: which provider produced `embedding` ("lexical-hash-384"
--    is the built-in term-frequency hash: lexical, NOT semantic). Search only
--    compares vectors of the same kind.
--
-- 2. PROVENANCE OF CONNECTIONS. `origen`: EXTRACTED (explicit in a source:
--    an import, a link, a graphify EXTRACTED edge), INFERRED (similarity,
--    a model's guess, a graphify INFERRED/AMBIGUOUS edge) or MANUAL (someone
--    asserted it through the API). `confianza` in [0, 1].
--    BACKFILL: existing rows cannot be told apart (the scanner's similarity
--    links and the ones made by hand look the same), so they become INFERRED
--    with confianza = their strength. Never claim "extracted" without proof.
--
-- 3. CLAIMS WITH EVIDENCE (`brain_claims`). A statement of a note, tied to a
--    Layer-1 source (`brain_sources`) and that source's SHA-256 at the time
--    of the claim, with an optional range. Sources are immutable: "a changed
--    source is a new source" with the same `uri`. A claim goes STALE when the
--    newest source with its uri has another hash, when its source is gone, or
--    when the recorded hash does not match the source row.
-- ============================================================================

-- ── 1. brain_notes ──────────────────────────────────────────────────────────
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS owner_agent_id text;
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS sponsor_user_id text;
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS visibility varchar(16) NOT NULL DEFAULT 'shared';
ALTER TABLE brain_notes ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS note_key text;
ALTER TABLE brain_notes ADD COLUMN IF NOT EXISTS embedding_kind varchar(100);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_notes_visibility_check') THEN
    ALTER TABLE brain_notes ADD CONSTRAINT brain_notes_visibility_check
      CHECK (visibility IN ('private', 'shared'));
  END IF;
END $$;

-- The embeddings that exist were all produced by the built-in hash.
UPDATE brain_notes
   SET embedding_kind = 'lexical-hash-384'
 WHERE embedding_kind IS NULL
   AND jsonb_typeof(embedding) = 'array'
   AND jsonb_array_length(embedding) = 384;

CREATE INDEX IF NOT EXISTS brain_notes_owner_user_idx ON brain_notes (owner_user_id);
CREATE INDEX IF NOT EXISTS brain_notes_owner_agent_idx ON brain_notes (owner_agent_id);
CREATE INDEX IF NOT EXISTS brain_notes_sponsor_idx ON brain_notes (sponsor_user_id);
CREATE INDEX IF NOT EXISTS brain_notes_visibility_idx ON brain_notes (visibility);
CREATE UNIQUE INDEX IF NOT EXISTS brain_notes_owner_key_idx ON brain_notes (
  (COALESCE('agent:' || owner_agent_id, 'user:' || owner_user_id, 'system')),
  note_key
) WHERE note_key IS NOT NULL;

-- ── 2. brain_connections ───────────────────────────────────────────────────
ALTER TABLE brain_connections ADD COLUMN IF NOT EXISTS origen varchar(16);
ALTER TABLE brain_connections ADD COLUMN IF NOT EXISTS confianza real;
ALTER TABLE brain_connections ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE brain_connections ADD COLUMN IF NOT EXISTS owner_agent_id text;

UPDATE brain_connections
   SET origen = 'INFERRED',
       confianza = LEAST(GREATEST(COALESCE(strength, 0), 0), 1)
 WHERE origen IS NULL OR confianza IS NULL;

ALTER TABLE brain_connections ALTER COLUMN origen SET DEFAULT 'INFERRED';
ALTER TABLE brain_connections ALTER COLUMN origen SET NOT NULL;
ALTER TABLE brain_connections ALTER COLUMN confianza SET DEFAULT 0;
ALTER TABLE brain_connections ALTER COLUMN confianza SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_connections_origen_check') THEN
    ALTER TABLE brain_connections ADD CONSTRAINT brain_connections_origen_check
      CHECK (origen IN ('EXTRACTED', 'INFERRED', 'MANUAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brain_connections_confianza_check') THEN
    ALTER TABLE brain_connections ADD CONSTRAINT brain_connections_confianza_check
      CHECK (confianza >= 0 AND confianza <= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS brain_connections_origen_idx ON brain_connections (origen);

-- ── 3. brain_claims ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brain_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES brain_notes(id) ON DELETE CASCADE,
  statement text NOT NULL,
  -- SHA-256 of the statement: with the note and the source hash, the
  -- idempotency key of "add this claim".
  statement_hash varchar(64) NOT NULL,
  source_id uuid REFERENCES brain_sources(id) ON DELETE SET NULL,
  source_sha256 varchar(64) NOT NULL,
  source_uri text,
  -- Optional range inside the source: {"unit":"line"|"char","start":n,"end":n}
  source_range jsonb,
  -- fresh | stale
  status varchar(16) NOT NULL DEFAULT 'fresh',
  stale_reason text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  verified_by text,
  owner_user_id text,
  owner_agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brain_claims_status_check CHECK (status IN ('fresh', 'stale'))
);

CREATE INDEX IF NOT EXISTS brain_claims_note_idx ON brain_claims (note_id);
CREATE INDEX IF NOT EXISTS brain_claims_source_idx ON brain_claims (source_id);
CREATE INDEX IF NOT EXISTS brain_claims_uri_idx ON brain_claims (source_uri);
CREATE INDEX IF NOT EXISTS brain_claims_status_idx ON brain_claims (status);
CREATE UNIQUE INDEX IF NOT EXISTS brain_claims_unique_idx
  ON brain_claims (note_id, statement_hash, source_sha256);

-- Staleness looks for the newest source with the same uri.
CREATE INDEX IF NOT EXISTS brain_sources_uri_idx ON brain_sources (uri, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON brain_claims TO kitsuden_app;
  END IF;
END $$;
