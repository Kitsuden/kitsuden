-- Migration: Agent Traces (Telemetry System - Step 2)
-- Purpose: Observability for AI Agents - tracks executions like LangSmith
-- Created: 2026-03-29

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE agent_trace_status AS ENUM (
    'pending',
    'running',
    'success',
    'error',
    'cancelled'
);

CREATE TYPE agent_trace_step_type AS ENUM (
    'llm_call',
    'tool_call',
    'tool_result',
    'thinking',
    'retrieval',
    'memory_read',
    'memory_write',
    'user_input',
    'system',
    'error'
);

-- ============================================================================
-- AGENT TRACES
-- ============================================================================

CREATE TABLE agent_traces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
    session_id TEXT, -- Groups multiple traces into a conversation/session
    
    -- Execution info
    name TEXT, -- Human-readable name: "Playground: Search data..."
    input JSONB, -- Input parameters
    output JSONB, -- Output result
    total_duration_ms INTEGER, -- Total execution time
    
    -- Token tracking (OpenAI/Claude integration)
    tokens_in INTEGER, -- Input tokens used
    tokens_out INTEGER, -- Output tokens used
    estimated_cost DOUBLE PRECISION, -- Estimated cost in USD
    
    -- Status
    status agent_trace_status NOT NULL DEFAULT 'pending',
    error_message TEXT,
    metadata JSONB DEFAULT '{}', -- Extra data: model, temperature, etc.
    
    -- Timestamps
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for agent_traces
CREATE INDEX idx_agent_traces_agent_id ON agent_traces(agent_id);
CREATE INDEX idx_agent_traces_session_id ON agent_traces(session_id);
CREATE INDEX idx_agent_traces_status ON agent_traces(status);
CREATE INDEX idx_agent_traces_created_at ON agent_traces(created_at);

-- ============================================================================
-- AGENT TRACE STEPS
-- ============================================================================

CREATE TABLE agent_trace_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id UUID NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
    
    -- Step ordering
    step_order INTEGER NOT NULL DEFAULT 0,
    
    -- Step type
    step_type agent_trace_step_type NOT NULL,
    
    -- Content
    content TEXT, -- Text content (for llm_call, thinking, etc.)
    reasoning TEXT, -- Chain of thought reasoning
    
    -- Tool execution details
    tool_name TEXT, -- Name of tool called
    tool_input JSONB, -- Input to tool
    tool_output JSONB, -- Output from tool
    
    -- Metrics
    duration_ms INTEGER, -- Time taken for this step
    tokens_in INTEGER, -- Tokens for this step
    tokens_out INTEGER, -- Tokens for this step
    error_message TEXT, -- If step failed
    
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for agent_trace_steps
CREATE INDEX idx_agent_trace_steps_trace_id ON agent_trace_steps(trace_id);
CREATE INDEX idx_agent_trace_steps_trace_order ON agent_trace_steps(trace_id, step_order);
CREATE INDEX idx_agent_trace_steps_type ON agent_trace_steps(step_type);

-- ============================================================================
-- AGENT FEEDBACK (Human feedback on traces)
-- ============================================================================

CREATE TABLE agent_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id UUID NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
    
    -- Who gave feedback
    user_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
    
    -- Feedback content
    rating INTEGER CHECK (rating >= 1 AND rating <= 5), -- 1-5 stars
    comment TEXT, -- Optional text feedback
    
    -- What was rated (optional granularity)
    step_id UUID REFERENCES agent_trace_steps(id) ON DELETE SET NULL,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for agent_feedback
CREATE INDEX idx_agent_feedback_trace_id ON agent_feedback(trace_id);
CREATE INDEX idx_agent_feedback_user_id ON agent_feedback(user_id);
CREATE INDEX idx_agent_feedback_rating ON agent_feedback(rating);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_agent_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_feedback_updated_at
    BEFORE UPDATE ON agent_feedback
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_feedback_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE agent_traces IS 'Execution traces for AI agents - like LangSmith runs';
COMMENT ON COLUMN agent_traces.session_id IS 'Groups traces into conversations (e.g., Playground session)';
COMMENT ON COLUMN agent_traces.tokens_in IS 'Input tokens (for OpenAI/Claude cost tracking)';
COMMENT ON COLUMN agent_traces.estimated_cost IS 'Estimated cost in USD for this execution';

COMMENT ON TABLE agent_trace_steps IS 'Individual steps within a trace - tool calls, LLM calls, etc.';
COMMENT ON COLUMN agent_trace_steps.tool_name IS 'Name of MCP tool called (e.g., "kitsuden_search_entries")';
COMMENT ON COLUMN agent_trace_steps.tool_input IS 'JSON input to the tool';
COMMENT ON COLUMN agent_trace_steps.tool_output IS 'JSON output from the tool';

COMMENT ON TABLE agent_feedback IS 'Human feedback on agent executions for RLHF';

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View: Recent traces with agent info
CREATE VIEW agent_traces_summary AS
SELECT 
    t.id,
    t.agent_id,
    i.name as agent_name,
    t.session_id,
    t.name,
    t.status,
    t.total_duration_ms,
    t.tokens_in,
    t.tokens_out,
    t.estimated_cost,
    t.created_at,
    COUNT(s.id) as step_count
FROM agent_traces t
JOIN agent_identities i ON t.agent_id = i.id
LEFT JOIN agent_trace_steps s ON s.trace_id = t.id
GROUP BY t.id, t.agent_id, i.name, t.session_id, t.name, t.status, 
         t.total_duration_ms, t.tokens_in, t.tokens_out, t.estimated_cost, t.created_at
ORDER BY t.created_at DESC;
