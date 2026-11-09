-- Migration: Agent Identities (NHI - Non-Human Identities)
-- Purpose: Authentication system for AI Agents (MCP, Workers, Automation)
-- Created: 2026-03-17

-- ============================================================================
-- AGENT IDENTITIES
-- ============================================================================

CREATE TABLE agent_identities (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL, -- ej: "DevBot Frontend", "Customer Support AI"
    description TEXT,
    
    -- Security and FinOps
    scopes JSONB DEFAULT '[]', -- ej: ["read:issues", "write:comments"] - Permission boundaries
    rate_limit INTEGER DEFAULT 60, -- Requests per minute limit (prevents runaway AI loops)
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for agent_identities
CREATE INDEX idx_agent_identities_name ON agent_identities(name);
CREATE INDEX idx_agent_identities_created_at ON agent_identities(created_at);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_agent_identities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_identities_updated_at
    BEFORE UPDATE ON agent_identities
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_identities_updated_at();

-- ============================================================================
-- AGENT API KEYS
-- ============================================================================

CREATE TABLE agent_api_keys (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    
    -- Cryptography (GOLDEN RULE: NEVER store plain text key)
    key_hash TEXT NOT NULL UNIQUE, -- argon2 or bcrypt hash of the real key
    key_prefix TEXT NOT NULL, -- ej: "grm_agent_****1234" (For UI display)
    
    -- Tracking
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

-- Indexes for agent_api_keys
CREATE INDEX idx_agent_api_keys_agent_id ON agent_api_keys(agent_id);
CREATE INDEX idx_agent_api_keys_key_hash ON agent_api_keys(key_hash);
CREATE INDEX idx_agent_api_keys_expires_at ON agent_api_keys(expires_at);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE agent_identities IS 'Non-Human Identities (NHI) for AI Agents, MCP servers, and automation workers';
COMMENT ON COLUMN agent_identities.scopes IS 'Zero Trust permission scopes. RLS middleware reads this to enforce boundaries';
COMMENT ON COLUMN agent_identities.rate_limit IS 'FinOps protection. Prevents runaway AI loops from burning API tokens';
COMMENT ON TABLE agent_api_keys IS 'API keys for AI agents. Key is shown only once, hash is stored';
COMMENT ON COLUMN agent_api_keys.key_hash IS 'Argon2/bcrypt hash. Never store plain text API keys!';
COMMENT ON COLUMN agent_api_keys.key_prefix IS 'Last 4 chars of key for UI recognition (like GitHub tokens)';

-- ============================================================================
-- INITIAL DATA (Optional - System Agents)
-- ============================================================================

-- Uncomment to create default system agents
-- INSERT INTO agent_identities (id, name, description, scopes, rate_limit) VALUES
--     ('system_mcp_server', 'MCP Server', 'Main MCP server for AI assistants', '["read:datasets", "write:datasets"]', 120),
--     ('system_worker_default', 'Default Worker', 'Background job processor', '["read:queues", "write:queues"]', 1000);
