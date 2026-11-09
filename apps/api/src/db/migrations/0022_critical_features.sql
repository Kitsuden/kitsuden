-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Critical Features (Rate Limiting, Search, Observability)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SEARCH EXTENSIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Enable pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy search (trigrams)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FULL-TEXT SEARCH SETUP
-- ═══════════════════════════════════════════════════════════════════════════════

-- Table data_entries: tsvector column + index
ALTER TABLE data_entries 
ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Trigger function to auto-update search_vector
CREATE OR REPLACE FUNCTION data_entries_search_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.content, '') || ' ' ||
    COALESCE(NEW.data::text, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger
DROP TRIGGER IF EXISTS data_entries_search_trigger ON data_entries;
CREATE TRIGGER data_entries_search_trigger
  BEFORE INSERT OR UPDATE ON data_entries
  FOR EACH ROW
  EXECUTE FUNCTION data_entries_search_update();

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS data_entries_search_idx 
ON data_entries USING GIN (search_vector);

-- Trigram indexes for fuzzy search
CREATE INDEX IF NOT EXISTS data_entries_title_trgm_idx 
ON data_entries USING GIN (title gin_trgm_ops);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. VECTOR DOCUMENTS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vector_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding VECTOR(384),
  metadata JSONB DEFAULT '{}',
  dataset_id UUID REFERENCES data_sets(id) ON DELETE CASCADE,
  source_type VARCHAR(50),
  source_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- HNSW index for efficient vector search (very fast for similarity)
--
-- It sits behind a guard because HNSW arrived in pgvector 0.5: with an earlier version
-- the extension EXISTS but the access method does not, and `USING hnsw`
-- aborts the entire migration with "access method hnsw does not exist".
-- Checking `pg_extension` is not enough — you have to look at `pg_am`.
--
-- If it is not there, the table is just as usable: it is only searched without an index, more
-- slowly. Losing speed is better than being unable to deploy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_am WHERE amname = 'hnsw') THEN
    EXECUTE $IDX$
      CREATE INDEX IF NOT EXISTS vector_documents_embedding_idx
      ON vector_documents
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    $IDX$;
  ELSE
    RAISE NOTICE 'hnsw no disponible (pgvector < 0.5): vector_documents queda sin índice vectorial';
  END IF;
END $$;

-- Additional indexes
CREATE INDEX IF NOT EXISTS vector_documents_dataset_idx ON vector_documents(dataset_id);
CREATE INDEX IF NOT EXISTS vector_documents_source_idx ON vector_documents(source_type, source_id);
CREATE INDEX IF NOT EXISTS vector_documents_created_idx ON vector_documents(created_at);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_vector_documents_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vector_documents_timestamp_trigger ON vector_documents;
CREATE TRIGGER vector_documents_timestamp_trigger
  BEFORE UPDATE ON vector_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_vector_documents_timestamp();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. OBSERVABILITY TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Audit logs table (if it does not exist)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at);

-- Metrics table (simple time-series)
CREATE TABLE IF NOT EXISTS system_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name VARCHAR(100) NOT NULL,
  metric_value NUMERIC NOT NULL,
  labels JSONB DEFAULT '{}',
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS system_metrics_name_idx ON system_metrics(metric_name);
CREATE INDEX IF NOT EXISTS system_metrics_recorded_idx ON system_metrics(recorded_at);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. RATE LIMITING TABLE (as a backup if Valkey is not available)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rate_limit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier VARCHAR(255) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  requests_count INTEGER DEFAULT 1,
  window_start TIMESTAMP DEFAULT NOW(),
  window_end TIMESTAMP DEFAULT NOW() + INTERVAL '1 minute',
  blocked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rate_limit_logs_identifier_idx ON rate_limit_logs(identifier);
CREATE INDEX IF NOT EXISTS rate_limit_logs_endpoint_idx ON rate_limit_logs(endpoint);
CREATE INDEX IF NOT EXISTS rate_limit_logs_window_idx ON rate_limit_logs(window_end);

-- Cleanup of old logs (run periodically)
CREATE OR REPLACE FUNCTION cleanup_rate_limit_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM rate_limit_logs WHERE window_end < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. FULL-TEXT SEARCH FOR OTHER TABLES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Blog posts
ALTER TABLE blog_posts 
ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION blog_posts_search_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.excerpt, '') || ' ' ||
    COALESCE(NEW.content::text, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS blog_posts_search_trigger ON blog_posts;
CREATE TRIGGER blog_posts_search_trigger
  BEFORE INSERT OR UPDATE ON blog_posts
  FOR EACH ROW
  EXECUTE FUNCTION blog_posts_search_update();

CREATE INDEX IF NOT EXISTS blog_posts_search_idx ON blog_posts USING GIN (search_vector);

-- Games
ALTER TABLE games 
ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION games_search_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.description::text, '') || ' ' ||
    COALESCE(NEW.developer, '') || ' ' ||
    COALESCE(NEW.publisher, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS games_search_trigger ON games;
CREATE TRIGGER games_search_trigger
  BEFORE INSERT OR UPDATE ON games
  FOR EACH ROW
  EXECUTE FUNCTION games_search_update();

CREATE INDEX IF NOT EXISTS games_search_idx ON games USING GIN (search_vector);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. MATERIALIZED VIEW FOR DASHBOARD STATS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS dashboard_stats AS
SELECT
  (SELECT COUNT(*) FROM data_sets) as total_datasets,
  (SELECT COUNT(*) FROM data_entries) as total_entries,
  (SELECT COUNT(*) FROM data_entries WHERE created_at >= CURRENT_DATE) as entries_today,
  (SELECT COUNT(*) FROM auth_users) as total_users,
  (SELECT COUNT(*) FROM auth_users WHERE created_at >= CURRENT_DATE) as users_today,
  (SELECT COUNT(*) FROM blog_posts) as total_posts,
  (SELECT COUNT(*) FROM games) as total_games,
  (SELECT COUNT(*) FROM media) as total_media,
  (SELECT COUNT(*) FROM agent_identities) as total_agents,
  NOW() as refreshed_at;

-- Index for fast refresh
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_stats_single_row ON dashboard_stats((true));

-- Function to refresh stats
CREATE OR REPLACE FUNCTION refresh_dashboard_stats()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY dashboard_stats;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  RAISE NOTICE '✅ Critical Features Migration Applied';
  RAISE NOTICE '   - pgvector extension: %', 
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') 
    THEN 'installed' ELSE 'MISSING' END;
  RAISE NOTICE '   - pg_trgm extension: %', 
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') 
    THEN 'installed' ELSE 'MISSING' END;
  RAISE NOTICE '   - vector_documents table: %',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vector_documents')
    THEN 'created' ELSE 'MISSING' END;
END $$;
