-- Migration: Add installed_kons table for plugin management
-- Created: 2026-03-17

-- Create enum for kon source
DO $$ BEGIN CREATE TYPE kon_source AS ENUM ('local', 'npm', 'github', 'marketplace', 'legacy'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Create installed_kons table
CREATE TABLE installed_kons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kon_id VARCHAR(200) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    version VARCHAR(50) NOT NULL,
    source kon_source NOT NULL DEFAULT 'local',
    source_url TEXT, -- npm package name, git url, etc.
    path TEXT NOT NULL, -- Filesystem path
    manifest JSONB, -- Full kon.json content
    config JSONB DEFAULT '{}', -- Plugin-specific config
    enabled BOOLEAN NOT NULL DEFAULT true,
    installed_by_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- Create indexes
CREATE UNIQUE INDEX installed_kon_id_idx ON installed_kons(kon_id);
CREATE INDEX installed_kon_source_idx ON installed_kons(source);
CREATE INDEX installed_kon_enabled_idx ON installed_kons(enabled);

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_installed_kons_updated_at
    BEFORE UPDATE ON installed_kons
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comment
COMMENT ON TABLE installed_kons IS 'Registry of installed kon plugins from npm/marketplace';
