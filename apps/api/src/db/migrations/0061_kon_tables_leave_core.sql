-- Tables that were core tables before kons existed.
--
-- The base migration creates them and is checksummed, so it stays as written.
-- On a fresh core nobody uses them: they are dropped here, and kon-blog,
-- kon-games and kon-streamers create their own when installed.
--
-- Nothing is lost on a database that already uses them. Each group is left alone
-- if any of its tables has a row or its kon has applied a migration.

-- Nothing reads this view, and it counts blog posts and games.
DROP FUNCTION IF EXISTS refresh_dashboard_stats();
DROP MATERIALIZED VIEW IF EXISTS dashboard_stats;

DO $$
DECLARE
  v_group record;
  v_table text;
  v_rows boolean;
  v_in_use boolean;
BEGIN
  FOR v_group IN
    SELECT * FROM (VALUES
      ('kon-blog', ARRAY['blog_posts_to_games', 'blog_posts_to_tags', 'blog_posts']),
      ('kon-streamers', ARRAY['games_to_streamers', 'streamers']),
      ('kon-games', ARRAY['game_collection_entries', 'game_collections', 'games_to_platforms', 'games_to_tags', 'platforms', 'tags', 'games'])
    ) AS g(kon, tables)
  LOOP
    SELECT EXISTS (SELECT 1 FROM kitsuden_migrations WHERE name LIKE '%' || v_group.kon || '%') INTO v_in_use;
    FOREACH v_table IN ARRAY v_group.tables LOOP
      IF to_regclass('public.' || v_table) IS NOT NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', v_table) INTO v_rows;
        v_in_use := v_in_use OR v_rows;
      END IF;
    END LOOP;

    IF NOT v_in_use THEN
      IF v_group.kon = 'kon-games' THEN
        -- The column stays: it is a plain link that kon-games fills in when installed.
        ALTER TABLE data_sets DROP CONSTRAINT IF EXISTS data_sets_game_id_games_id_fk;
      END IF;
      FOREACH v_table IN ARRAY v_group.tables LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I', v_table);
      END LOOP;
    END IF;
  END LOOP;
END $$;
