-- Migration: AI Memories Kon → Core Vector Search
-- Purpose: Migrate data from old ai_memories tables to new vector_index schema
-- Date: 2026-03-19
-- Note: Run this after the new vector_index tables have been created

-- ═══════════════════════════════════════════════════════════════════════════════
-- PRE-MIGRATION CHECKS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Check if old tables exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'ai_memories'
    ) THEN
        RAISE NOTICE 'Table ai_memories does not exist. Nothing to migrate.';
        RETURN;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATE: ai_memories → vector_index
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO vector_index (
    dataset_id,
    entry_id,
    content,
    embedding,
    field_name,
    model,
    is_chunked,
    total_chunks,
    metadata,
    created_at,
    updated_at,
    expires_at
)
SELECT 
    'legacy-ai-memories' as dataset_id,
    id::text as entry_id,
    content,
    embedding,
    COALESCE(memory_type, 'knowledge') as field_name,
    'text-embedding-3-small' as model,
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM ai_memory_chunks c 
            WHERE c.memory_id = m.id
        ) THEN 1 
        ELSE 0 
    END as is_chunked,
    COALESCE((
        SELECT COUNT(*) 
        FROM ai_memory_chunks c 
        WHERE c.memory_id = m.id
    ), 1) as total_chunks,
    jsonb_build_object(
        'legacy_source', 'ai-memories',
        'legacy_metadata', metadata,
        'legacy_created_by', created_by_id
    ) as metadata,
    created_at,
    updated_at,
    expires_at
FROM ai_memories m
ON CONFLICT DO NOTHING;

-- Log migration count
DO $$
DECLARE
    migrated_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO migrated_count FROM vector_index WHERE dataset_id = 'legacy-ai-memories';
    RAISE NOTICE 'Migrated % records from ai_memories to vector_index', migrated_count;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATE: ai_memory_chunks → vector_chunks
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO vector_chunks (
    index_id,
    content,
    embedding,
    chunk_index,
    total_chunks,
    char_offset,
    metadata,
    created_at
)
SELECT 
    vi.id as index_id,
    c.content,
    c.embedding,
    c.chunk_index,
    c.total_chunks,
    COALESCE(
        (c.metadata->>'startOffset')::int,
        c.chunk_index * 1800  -- Approximate: chunkSize(2000) - overlap(200)
    ) as char_offset,
    jsonb_build_object(
        'legacy_source', 'ai-memory-chunks',
        'legacy_chunk_metadata', c.metadata
    ) as metadata,
    c.created_at
FROM ai_memory_chunks c
JOIN ai_memories m ON m.id = c.memory_id
JOIN vector_index vi ON vi.entry_id = m.id::text AND vi.dataset_id = 'legacy-ai-memories'
ON CONFLICT DO NOTHING;

-- Log chunk migration
DO $$
DECLARE
    migrated_chunks INTEGER;
BEGIN
    SELECT COUNT(*) INTO migrated_chunks 
    FROM vector_chunks vc
    JOIN vector_index vi ON vi.id = vc.index_id
    WHERE vi.dataset_id = 'legacy-ai-memories';
    RAISE NOTICE 'Migrated % chunks from ai_memory_chunks to vector_chunks', migrated_chunks;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- POST-MIGRATION: Create views for backward compatibility (optional)
-- ═══════════════════════════════════════════════════════════════════════════════

-- View that mimics old ai_memories structure for backward compatibility
CREATE OR REPLACE VIEW ai_memories_compat AS
SELECT 
    vi.id,
    vi.content,
    vi.embedding,
    vi.field_name as memory_type,
    vi.metadata->'legacy_metadata' as metadata,
    vi.metadata->>'legacy_created_by' as created_by_id,
    vi.created_at,
    vi.updated_at,
    vi.expires_at
FROM vector_index vi
WHERE vi.dataset_id = 'legacy-ai-memories';

COMMENT ON VIEW ai_memories_compat IS 
'Backward compatibility view for migrated ai-memories data. Use vector_index directly for new code.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════

-- Summary statistics
SELECT 
    'Migration Summary' as report,
    (SELECT COUNT(*) FROM vector_index WHERE dataset_id = 'legacy-ai-memories') as migrated_memories,
    (SELECT COUNT(*) FROM vector_chunks vc 
     JOIN vector_index vi ON vi.id = vc.index_id 
     WHERE vi.dataset_id = 'legacy-ai-memories') as migrated_chunks,
    (SELECT COUNT(*) FROM ai_memories) as original_memories,
    (SELECT COUNT(*) FROM ai_memory_chunks) as original_chunks;

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLEANUP (Uncomment after verification)
-- ═══════════════════════════════════════════════════════════════════════════════

-- WARNING: Only run this after verifying the migration was successful!

-- DROP TABLE IF EXISTS ai_memory_chunks CASCADE;
-- DROP TABLE IF EXISTS ai_memories CASCADE;
-- DROP VIEW IF EXISTS ai_memories_compat;

-- ═══════════════════════════════════════════════════════════════════════════════
-- NEXT STEPS
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Update your datasets to use vectorSearch extension:
--    POST /api/datasets
--    {
--      "name": "my-dataset",
--      "extensions": {
--        "vectorSearch": { "enabled": true, "fields": ["content"] }
--      }
--    }

-- 2. Update API calls:
--    OLD: POST /api/ai-memories/search
--    NEW: POST /api/datasets/{datasetId}/vector-search

-- 3. After verification, drop old tables:
--    DROP TABLE ai_memory_chunks;
--    DROP TABLE ai_memories;

