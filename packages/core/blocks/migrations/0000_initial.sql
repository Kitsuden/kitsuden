-- Page Builder Initial Migration
-- Creates pages, blocks, and block_templates tables

-- Enums
DO $$ BEGIN CREATE TYPE page_status AS ENUM ('draft', 'published', 'archived'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE block_type AS ENUM ('hero', 'text', 'image', 'video', 'grid', 'cards', 'quote', 'cta', 'embed', 'divider', 'spacer', 'custom'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Pages table
CREATE TABLE IF NOT EXISTS pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(500) NOT NULL,
    slug VARCHAR(500) NOT NULL UNIQUE,
    description TEXT,
    status page_status DEFAULT 'draft' NOT NULL,
    
    -- SEO & Meta
    meta_title VARCHAR(500),
    meta_description TEXT,
    og_image_id UUID,
    
    -- Layout settings
    layout VARCHAR(50) DEFAULT 'default' NOT NULL,
    css_class VARCHAR(200),
    custom_css TEXT,
    
    -- Publishing
    published_at TIMESTAMP WITH TIME ZONE,
    author_id UUID,
    
    -- Settings
    is_homepage BOOLEAN DEFAULT false NOT NULL,
    require_auth BOOLEAN DEFAULT false NOT NULL,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Blocks table
CREATE TABLE IF NOT EXISTS blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    
    -- Block configuration
    type block_type NOT NULL,
    name VARCHAR(200),
    
    -- Positioning
    sort_order INTEGER DEFAULT 0 NOT NULL,
    column_span INTEGER DEFAULT 12 NOT NULL,
    
    -- Content
    content JSONB NOT NULL,
    
    -- Styling
    css_class VARCHAR(200),
    background_color VARCHAR(50),
    text_color VARCHAR(50),
    padding VARCHAR(50),
    
    -- Visibility
    is_visible BOOLEAN DEFAULT true NOT NULL,
    visible_from TIMESTAMP WITH TIME ZONE,
    visible_until TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Block templates table
CREATE TABLE IF NOT EXISTS block_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category VARCHAR(100) NOT NULL,
    
    type block_type NOT NULL,
    content JSONB NOT NULL,
    
    -- Default styling
    css_class VARCHAR(200),
    background_color VARCHAR(50),
    text_color VARCHAR(50),
    padding VARCHAR(50),
    
    is_active BOOLEAN DEFAULT true NOT NULL,
    usage_count INTEGER DEFAULT 0 NOT NULL,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_idx ON pages(slug);
CREATE INDEX IF NOT EXISTS pages_status_idx ON pages(status);
CREATE INDEX IF NOT EXISTS pages_homepage_idx ON pages(is_homepage);
CREATE INDEX IF NOT EXISTS pages_published_idx ON pages(published_at);

CREATE INDEX IF NOT EXISTS blocks_page_idx ON blocks(page_id);
CREATE INDEX IF NOT EXISTS blocks_type_idx ON blocks(type);
CREATE INDEX IF NOT EXISTS blocks_order_idx ON blocks(page_id, sort_order);

CREATE INDEX IF NOT EXISTS templates_category_idx ON block_templates(category);
CREATE INDEX IF NOT EXISTS templates_type_idx ON block_templates(type);
CREATE INDEX IF NOT EXISTS templates_active_idx ON block_templates(is_active);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_pages_updated_at ON pages;
CREATE TRIGGER update_pages_updated_at
    BEFORE UPDATE ON pages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_blocks_updated_at ON blocks;
CREATE TRIGGER update_blocks_updated_at
    BEFORE UPDATE ON blocks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_block_templates_updated_at ON block_templates;
CREATE TRIGGER update_block_templates_updated_at
    BEFORE UPDATE ON block_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
