-- Migration: Actions Unification
-- This migration creates the new unified actions tables
-- 
-- Run with: bunx drizzle-kit push

-- ═══════════════════════════════════════════════════════════════════════════
-- Enums
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
    CREATE TYPE action_type AS ENUM ('code', 'webhook_out', 'webhook_in', 'agent');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE action_trigger AS ENUM ('manual', 'cron', 'event', 'http');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE action_status AS ENUM ('active', 'paused', 'error');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Actions Table
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "actions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" varchar(200) NOT NULL,
    "slug" varchar(200) NOT NULL,
    "description" text,
    
    -- Action classification
    "type" action_type NOT NULL,
    "trigger" action_trigger NOT NULL,
    
    -- Configuration
    "trigger_config" jsonb DEFAULT '{}'::jsonb,
    "config" jsonb DEFAULT '{}'::jsonb,
    
    -- Status
    "status" action_status DEFAULT 'active' NOT NULL,
    
    -- Stats
    "last_executed_at" timestamp with time zone,
    "last_error" text,
    "execution_count" integer DEFAULT 0 NOT NULL,
    "error_count" integer DEFAULT 0 NOT NULL,
    
    -- Foreign keys
    "created_by_id" text REFERENCES auth_users(id) ON DELETE SET NULL,
    
    -- Timestamps
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    
    -- Migration tracking
    "legacy_id" varchar(100),
    "legacy_type" varchar(50)
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "actions_slug_idx" ON "actions" ("slug");
CREATE INDEX IF NOT EXISTS "actions_type_idx" ON "actions" ("type");
CREATE INDEX IF NOT EXISTS "actions_trigger_idx" ON "actions" ("trigger");
CREATE INDEX IF NOT EXISTS "actions_status_idx" ON "actions" ("status");
CREATE INDEX IF NOT EXISTS "actions_legacy_idx" ON "actions" ("legacy_id", "legacy_type");

-- ═══════════════════════════════════════════════════════════════════════════
-- Action Executions Table
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "action_executions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "action_id" uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    
    -- Execution status
    "status" execution_status DEFAULT 'pending' NOT NULL,
    
    -- Trigger context
    "trigger_type" action_trigger,
    "trigger_event" varchar(100),
    "trigger_payload" jsonb,
    
    -- HTTP request (for incoming webhooks)
    "http_request" jsonb,
    
    -- Execution results
    "logs" text,
    "result" jsonb,
    "error_message" text,
    
    -- Performance metrics
    "duration_ms" integer,
    "memory_used_bytes" integer,
    
    -- HTTP response (for outgoing webhooks)
    "http_response" jsonb,
    
    -- Timestamps
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS "ae_action_idx" ON "action_executions" ("action_id");
CREATE INDEX IF NOT EXISTS "ae_status_idx" ON "action_executions" ("status");
CREATE INDEX IF NOT EXISTS "ae_created_idx" ON "action_executions" ("created_at");

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration Notes
-- ═══════════════════════════════════════════════════════════════════════════

-- After running this migration:
-- 1. Run the data migration script: 
--    bun run apps/api/src/db/migrations/migrate-to-actions.ts
--
-- 2. The old tables (kitsuden_functions, webhooks) are preserved for safety
--
-- 3. New code should use the actions table
--
-- 4. After full verification, old tables can be dropped:
--    DROP TABLE kitsuden_functions CASCADE;
--    DROP TABLE function_executions CASCADE;
--    DROP TABLE webhooks CASCADE;
