-- Migration: KITSUDEN Brain - Self-Aware Knowledge Layer
-- Purpose: Store notes, insights and connections discovered by the Brain Engine
-- Phase: 1 of KITSUDEN Brain implementation
-- Created: 2026-07-08

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE brain_note_source AS ENUM ('code', 'user', 'agent', 'system', 'insight');
CREATE TYPE brain_note_category AS ENUM (
    'schema',
    'route',
    'kon',
    'agent',
    'function',
    'dataset',
    'insight',
    'connection',
    'general'
);

-- ============================================================================
-- BRAIN NOTES
-- ============================================================================

CREATE TABLE IF NOT EXISTS brain_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source brain_note_source NOT NULL DEFAULT 'system',
    source_path TEXT,
    category brain_note_category NOT NULL DEFAULT 'general',
    tags JSONB DEFAULT '[]',
    -- JSONB array of floats (384 dims). Kept as JSONB for pg-mem compatibility;
    -- production deployments with pgvector can add an optional VECTOR column later.
    embedding JSONB DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 50 CHECK (importance >= 0 AND importance <= 100),
    confidence INTEGER NOT NULL DEFAULT 80 CHECK (confidence >= 0 AND confidence <= 100),
    metadata JSONB DEFAULT '{}',
    related_note_ids JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- BRAIN CONNECTIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS brain_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_note_id UUID NOT NULL REFERENCES brain_notes(id) ON DELETE CASCADE,
    target_note_id UUID NOT NULL REFERENCES brain_notes(id) ON DELETE CASCADE,
    relation_type VARCHAR(100) NOT NULL DEFAULT 'related',
    strength REAL NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX idx_brain_notes_category ON brain_notes(category);
CREATE INDEX idx_brain_notes_source ON brain_notes(source);
CREATE INDEX idx_brain_notes_created_at ON brain_notes(created_at);
CREATE INDEX idx_brain_notes_importance ON brain_notes(importance DESC);

-- GIN indexes for tags and metadata
CREATE INDEX idx_brain_notes_tags_gin ON brain_notes USING GIN (tags);
CREATE INDEX idx_brain_notes_metadata_gin ON brain_notes USING GIN (metadata);

-- Connection indexes
CREATE INDEX idx_brain_connections_source ON brain_connections(source_note_id);
CREATE INDEX idx_brain_connections_target ON brain_connections(target_note_id);
CREATE INDEX idx_brain_connections_type ON brain_connections(relation_type);
CREATE UNIQUE INDEX idx_brain_connections_pair
ON brain_connections(source_note_id, target_note_id, relation_type);

-- ============================================================================
-- OPTIONAL PGVECTOR SUPPORT
-- ============================================================================

-- If pgvector is available, add a real vector column and HNSW index for fast
-- similarity search. The JSONB embedding column remains the source of truth.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'brain_notes' AND column_name = 'embedding_vector'
        ) THEN
            ALTER TABLE brain_notes ADD COLUMN embedding_vector VECTOR(384);
        END IF;

        CREATE INDEX IF NOT EXISTS idx_brain_notes_embedding_hnsw
        ON brain_notes USING hnsw (embedding_vector vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Could not create vector column/index - pgvector may not be available';
END $$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_brain_notes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_brain_notes_updated_at
    BEFORE UPDATE ON brain_notes
    FOR EACH ROW
    EXECUTE FUNCTION update_brain_notes_updated_at();

-- ============================================================================
-- OPTIONAL VECTOR SYNC TRIGGER
-- ============================================================================

-- Keep embedding_vector in sync with the JSONB embedding array when pgvector is present.
CREATE OR REPLACE FUNCTION sync_brain_notes_embedding_vector()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
       AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'brain_notes' AND column_name = 'embedding_vector'
       ) THEN
        NEW.embedding_vector := NEW.embedding::VECTOR(384);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_brain_notes_embedding_vector
    BEFORE INSERT OR UPDATE ON brain_notes
    FOR EACH ROW
    EXECUTE FUNCTION sync_brain_notes_embedding_vector();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE brain_notes IS 'KITSUDEN Brain knowledge notes - organized ideas and system observations';
COMMENT ON COLUMN brain_notes.embedding IS 'Local embedding as JSONB array of floats (384 dimensions)';
COMMENT ON COLUMN brain_notes.related_note_ids IS 'IDs of related notes discovered by the connection engine';
COMMENT ON TABLE brain_connections IS 'Explicit relationships discovered between brain notes';

-- ============================================================================
-- VALIDATION
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'brain_notes') THEN
        RAISE EXCEPTION 'Table brain_notes was not created';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'brain_connections') THEN
        RAISE EXCEPTION 'Table brain_connections was not created';
    END IF;
END $$;
