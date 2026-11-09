-- ============================================================================
-- 0026_brain_sources.sql — Layer 1 of the Second Brain (Karpathy method)
-- ============================================================================
-- Raw and IMMUTABLE corpus. The AI reads from here but never edits it; the wiki
-- (brain_notes) is derived interpretation. Dedupe by content hash.
-- ============================================================================

CREATE TABLE IF NOT EXISTS brain_sources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         VARCHAR(500) NOT NULL,
    content       TEXT NOT NULL,
    content_hash  VARCHAR(64) NOT NULL,
    source_type   VARCHAR(50) NOT NULL DEFAULT 'text',
    uri           TEXT,
    tags          JSONB DEFAULT '[]'::jsonb,
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedupe: the same content is not ingested twice.
CREATE UNIQUE INDEX IF NOT EXISTS brain_sources_hash_idx ON brain_sources (content_hash);
CREATE INDEX IF NOT EXISTS brain_sources_type_idx ON brain_sources (source_type);
CREATE INDEX IF NOT EXISTS brain_sources_created_at_idx ON brain_sources (created_at);

COMMENT ON TABLE brain_sources IS 'Layer 1 (Karpathy): fuentes crudas inmutables. Solo INSERT/DELETE, jamás UPDATE.';
