-- ═══════════════════════════════════════════════════════════════════════════
-- Change the media addresses from `http://localhost:3000/media/` to the real
-- domain, in ALL the columns where the database has them written.
--
-- WHY IT IS NEEDED. The loaders wrote the images with the absolute
-- address of the local API (`http://localhost:3000/media/...`). On the VPS that
-- address points to the visitor's own computer: all covers,
-- icons, cards and videos would come out broken, with no error on the server.
-- Count on a restore of that night's backup:
--
--   data_entries.data       120,802 rows (333,515 URLs)
--   wiki_revisions.content      471      blog_posts.source   144
--   blog_posts.blocks           131      tier_lists.items    103
--   games.specs                  50      games.blocks         13
--   blog_posts.content            3      site_settings.site_url  1 (http://localhost:4321)
--
-- All were `http://localhost:3000/media`; there was no other host or port.
--
-- USAGE (on the VPS, AFTER restoring the database and BEFORE opening the site):
--
--   docker exec -i kitsuden_db_prod sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v domain=https://example.com' \
--     < docker/sql/change-media-domain.sql
--
-- `domain` is the ORIGIN of the public site (scheme + host, no trailing slash):
-- Caddy serves `/media/*` of that domain from the API (see docker/Caddyfile).
--
-- It is a single transaction: either everything changes or nothing. It can be repeated (the second
-- time finds nothing to change). Tested on a copy
-- restored into a temporary Postgres: see docs/install/server.md.
--
-- Make a backup first (`pg_dump -Fc`, see docs/install/upgrade-and-backups.md).
-- ═══════════════════════════════════════════════════════════════════════════

\if :{?domain}
\else
  \echo 'Missing -v domain=https://your-domain (no trailing slash)'
  \quit
\endif

BEGIN;
SELECT set_config('kitsuden.domain', :'domain', true);

DO $$
DECLARE
  v_domain text := current_setting('kitsuden.domain');
  old_url   text := 'http://localhost:3000/media/';
  new_url   text;
  r       record;
  n       bigint;
BEGIN
  IF v_domain !~ '^https?://[^/]+$' THEN
    RAISE EXCEPTION 'domain must be an origin without a trailing slash (https://example.com), not «%»', v_domain;
  END IF;
  new_url := v_domain || '/media/';

  FOR r IN
    SELECT c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND (c.table_name, c.column_name) IN (
             ('data_entries','data'), ('wiki_revisions','content'), ('tier_lists','items'),
             ('blog_posts','content'), ('blog_posts','blocks'), ('blog_posts','source'),
             ('games','specs'), ('games','blocks'))
  LOOP
    IF r.data_type IN ('jsonb', 'json') THEN
      EXECUTE format(
        'UPDATE %I SET %I = replace(%I::text, $1, $2)::%s WHERE %I::text LIKE $3',
        r.table_name, r.column_name, r.column_name, r.data_type, r.column_name)
        USING old_url, new_url, '%' || old_url || '%';
    ELSE
      EXECUTE format(
        'UPDATE %I SET %I = replace(%I, $1, $2) WHERE %I LIKE $3',
        r.table_name, r.column_name, r.column_name, r.column_name)
        USING old_url, new_url, '%' || old_url || '%';
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '%.%: % rows', r.table_name, r.column_name, n;
  END LOOP;

  -- The panel's public URL TAKES PRECEDENCE over SITE_URL (lib/site.ts: «panel
  -- first»): if it stays at localhost, canonicals, sitemap and structured data
  -- come out with localhost even if everything else is fine.
  UPDATE site_settings SET site_url = v_domain
   WHERE site_url ~ '^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'site_settings.site_url: % rows', n;
END $$;
COMMIT;

-- Whatever remains with localhost in any text column (should be 0).
DO $$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public'
              AND data_type IN ('jsonb','json','text','character varying')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text ~ %L',
                   r.table_name, r.column_name, 'https?://(localhost|127\.0\.0\.1):')
       INTO n;
    IF n > 0 THEN
      RAISE WARNING 'still has localhost: %.% (% rows)', r.table_name, r.column_name, n;
      total := total + n;
    END IF;
  END LOOP;
  RAISE NOTICE 'rows with localhost after the change: %', total;
END $$;
