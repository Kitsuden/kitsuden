-- Rename tables
ALTER TABLE IF EXISTS pages RENAME TO block_pages;
ALTER TABLE IF EXISTS blocks RENAME TO block_contents;
-- block_templates already has block_ prefix

-- Rename enums
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'page_status') THEN
    ALTER TYPE page_status RENAME TO block_page_status;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'block_type') THEN
    ALTER TYPE block_type RENAME TO block_content_type;
  END IF;
END $$;
