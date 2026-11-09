-- Migration: Agent Memory System
-- Purpose: Create AgentMemory table for cognitive state persistence
-- Phase: 4 of Agent Refactoring (Memory & Context)
-- Created: 2026-03-19

-- ============================================================================
-- EXTENSIONS
-- ============================================================================
-- The table below declares `embedding VECTOR(1536)`, but `CREATE EXTENSION
-- vector` lived in 0022 — that is, AFTER its first use. On a
-- database created from scratch the chain died here with `type "vector" does not
-- exist`, and it was never detected because nobody ran it in full.
--
-- It is created here, in the first migration that needs it: a migration
-- cannot depend on a later one.
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- AGENT MEMORY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Relationship with the owning agent
    agent_id TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    
    -- ============================================================================
    -- MEMORY CLASSIFICATION
    -- ============================================================================
    
    -- Memory type: short term (session) vs long term (persistent)
    memory_type TEXT NOT NULL DEFAULT 'short_term',
    -- Valid values: 'short_term', 'long_term', 'episodic', 'semantic'
    
    -- Category/context of the memory for organization
    category TEXT NOT NULL DEFAULT 'general',
    -- Examples: 'conversation', 'task', 'insight', 'preference', 'context'
    
    -- ============================================================================
    -- CONTENT
    -- ============================================================================
    
    -- Identifier key of the memory (for lookups)
    key TEXT,
    
    -- Main content (JSON payload)
    content JSONB NOT NULL DEFAULT '{}',
    -- Flexible structure: { text, metadata, embeddings, etc. }
    
    -- Summary/short version for quick listings
    summary TEXT,
    
    -- ============================================================================
    -- COGNITIVE METADATA
    -- ============================================================================
    
    -- Importance/priority (0-100, for memory garbage collection)
    importance INTEGER DEFAULT 50 CHECK (importance >= 0 AND importance <= 100),
    
    -- Confidence in the information (0-100)
    confidence INTEGER DEFAULT 80 CHECK (confidence >= 0 AND confidence <= 100),
    
    -- Source of the memory
    source TEXT DEFAULT 'agent',
    -- Values: 'agent', 'user', 'system', 'inference', 'external'
    
    -- IDs of related memories (for knowledge graphs)
    related_memory_ids JSONB DEFAULT '[]',
    
    -- Tags for flexible classification
    tags JSONB DEFAULT '[]',
    
    -- ============================================================================
    -- VECTORS (for semantic search - requires pgvector)
    -- ============================================================================
    
    -- Embedding vector for similarity search (optional)
    embedding VECTOR(1536),  -- Dimensions for OpenAI embeddings (text-embedding-3-small)
    
    -- ============================================================================
    -- TEMPORALITY
    -- ============================================================================
    
    -- Temporal context of the memory
    valid_from TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    valid_until TIMESTAMP WITH TIME ZONE,  -- NULL = does not expire
    
    -- Usage tracking (for LRU - Least Recently Used)
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP WITH TIME ZONE,
    
    -- Creation and update timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Lookup by agent + type (most common)
CREATE INDEX idx_agent_memory_agent_type 
ON agent_memory(agent_id, memory_type);

-- Lookup by category
CREATE INDEX idx_agent_memory_category 
ON agent_memory(category);

-- Lookup by key (for specific retrieval)
CREATE INDEX idx_agent_memory_key 
ON agent_memory(agent_id, key) 
WHERE key IS NOT NULL;

-- Temporal lookup (active/valid memories)
--
-- The predicate was `WHERE valid_until IS NULL OR valid_until > NOW()`, and
-- Postgres rejects it: `functions in index predicate must be marked IMMUTABLE`.
-- It is not a formality — a partial index is evaluated AT INSERT, so
-- `> NOW()` would freeze the instant of the write and the index would silently
-- leave out rows that are still valid.
--
-- The index covers both columns; the temporal filter is put by the query,
-- which is where `NOW()` means something.
CREATE INDEX IF NOT EXISTS idx_agent_memory_valid
ON agent_memory(valid_from, valid_until);

-- GIN index for searches in JSONB content
CREATE INDEX idx_agent_memory_content_gin 
ON agent_memory USING GIN (content jsonb_path_ops);

-- GIN index for tags
CREATE INDEX idx_agent_memory_tags_gin 
ON agent_memory USING GIN (tags);

-- Index for ordering by importance (priority)
CREATE INDEX idx_agent_memory_importance 
ON agent_memory(agent_id, memory_type, importance DESC);

-- Index for LRU (last access)
CREATE INDEX idx_agent_memory_last_accessed 
ON agent_memory(agent_id, last_accessed_at);

-- HNSW index for vector search (if pgvector is available)
-- Note: Requires the pgvector extension
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'vector'
    ) THEN
        -- Create HNSW index for efficient similarity search
        CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding_hnsw 
        ON agent_memory USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Could not create vector index - pgvector may not be available';
END $$;

-- ============================================================================
-- UTILITY FUNCTIONS
-- ============================================================================

-- Function to update updated_at automatically
CREATE OR REPLACE FUNCTION update_agent_memory_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
CREATE TRIGGER trigger_agent_memory_updated
    BEFORE UPDATE ON agent_memory
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_memory_timestamp();

-- Function to update last_accessed_at and access_count
CREATE OR REPLACE FUNCTION touch_agent_memory(memory_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE agent_memory
    SET 
        access_count = access_count + 1,
        last_accessed_at = NOW()
    WHERE id = memory_id;
END;
$$ LANGUAGE plpgsql;

-- Function for garbage collection of short-term memory
CREATE OR REPLACE FUNCTION cleanup_short_term_memory(
    p_agent_id TEXT,
    max_age_hours INTEGER DEFAULT 24,
    min_importance INTEGER DEFAULT 10
)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM agent_memory
    WHERE 
        agent_id = p_agent_id
        AND memory_type = 'short_term'
        AND importance <= min_importance
        AND created_at < NOW() - INTERVAL '1 hour' * max_age_hours
        AND (valid_until IS NULL OR valid_until < NOW());
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- DOCUMENTATION COMMENTS
-- ============================================================================

COMMENT ON TABLE agent_memory IS 
'Sistema de memoria cognitiva para agentes de IA. Almacena contexto a corto y largo plazo.';

COMMENT ON COLUMN agent_memory.memory_type IS 
'Tipo de memoria: short_term (sesión/contexto temporal), long_term (persistente), episodic (eventos), semantic (conocimiento)';

COMMENT ON COLUMN agent_memory.category IS 
'Categoría de la memoria: conversation, task, insight, preference, context, etc.';

COMMENT ON COLUMN agent_memory.content IS 
'Contenido principal en formato JSON. Estructura flexible según el tipo de memoria.';

COMMENT ON COLUMN agent_memory.importance IS 
'Puntuación de importancia (0-100). Usada para garbage collection y priorización.';

COMMENT ON COLUMN agent_memory.confidence IS 
'Confianza en la veracidad de la información (0-100). Para filtrado de información incierta.';

COMMENT ON COLUMN agent_memory.embedding IS 
'Vector de embedding para búsqueda semántica. Requiere extensión pgvector.';

COMMENT ON COLUMN agent_memory.valid_until IS 
'Fecha de expiración de la memoria. NULL significa que no expira.';

-- ============================================================================
-- VALIDATION
-- ============================================================================

DO $$
BEGIN
    -- Verify that the table was created
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'agent_memory'
    ) THEN
        RAISE EXCEPTION 'Table agent_memory was not created';
    END IF;

    -- Verify critical columns
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'agent_memory' AND column_name = 'agent_id'
    ) THEN
        RAISE EXCEPTION 'Column agent_id was not added to agent_memory';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'agent_memory' AND column_name = 'memory_type'
    ) THEN
        RAISE EXCEPTION 'Column memory_type was not added to agent_memory';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'agent_memory' AND column_name = 'content'
    ) THEN
        RAISE EXCEPTION 'Column content was not added to agent_memory';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'agent_memory' AND column_name = 'embedding'
    ) THEN
        RAISE EXCEPTION 'Column embedding was not added to agent_memory';
    END IF;

    RAISE NOTICE 'AgentMemory table created successfully';
END $$;
