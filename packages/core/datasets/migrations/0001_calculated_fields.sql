-- Migration: Add Calculated Fields support to DataSets
-- Created: 2026-03-19

-- Table for calculated fields per dataset
CREATE TABLE IF NOT EXISTS data_set_calculated_fields (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_set_id UUID NOT NULL REFERENCES data_sets(id) ON DELETE CASCADE,
    
    -- Identification
    name VARCHAR(100) NOT NULL,
    label VARCHAR(200) NOT NULL,
    
    -- Calculation type
    type VARCHAR(50) NOT NULL,
    
    -- Configuration (JSON)
    config JSONB DEFAULT '{}',
    
    -- Output format
    format JSONB,
    
    -- Dependencies
    depends_on JSONB DEFAULT '[]',
    
    -- Metadata KPI
    description TEXT,
    category VARCHAR(100),
    is_kpi BOOLEAN DEFAULT false,
    target INTEGER,
    warning_threshold INTEGER,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    
    -- Audit
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by_id TEXT,
    
    -- Constraints
    CONSTRAINT unique_field_name_per_dataset UNIQUE (data_set_id, name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_calc_fields_dataset ON data_set_calculated_fields(data_set_id);
CREATE INDEX IF NOT EXISTS idx_calc_fields_active ON data_set_calculated_fields(is_active);
CREATE INDEX IF NOT EXISTS idx_calc_fields_type ON data_set_calculated_fields(type);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_calc_fields_updated_at ON data_set_calculated_fields;
CREATE TRIGGER update_calc_fields_updated_at
    BEFORE UPDATE ON data_set_calculated_fields
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
