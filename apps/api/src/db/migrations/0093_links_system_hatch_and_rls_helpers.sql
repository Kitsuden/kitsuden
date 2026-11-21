-- kitsuden_links: the SYSTEM hatch needs an empty id AND an empty role, and the
-- RLS helper functions run as their caller.
--
-- 1. kitsuden_links_owner_isolation (0032) treated any context with an empty
--    user id as the system. An anonymous request carries id '' and role
--    `anonymous`, so it went through as if it were a migration or a worker, as
--    data_entries did until 2026-10-23. A row with no owner (`owner_id IS NULL`)
--    was also read AND written by anyone, the anonymous included. No core route
--    reaches the table today (engine/src/links.ts has no callers; /api/graph
--    needs a session), so this closes a latent gap. Same rule as
--    data_entries_owner_isolation:
--      · system = id AND role empty (or unset);
--      · `admin` reads and changes everything;
--      · the owner, their own rows;
--      · a row with no owner is READ by anyone signed in (non-empty id), and
--        written only by the system and `admin`.
--
-- 2. is_rls_active, current_rls_user_id, set_rls_context and clear_rls_context
--    were SECURITY DEFINER without a search_path. Reading or setting an `app.*`
--    setting needs no privilege, so running as the owner granted nothing, and a
--    definer function with an open search_path is the shape a caller-controlled
--    schema can hijack. Now SECURITY INVOKER with search_path pg_catalog, pg_temp.
--    rls-policies.sql holds the same text.
--
-- Idempotent: DROP POLICY + CREATE POLICY (CREATE POLICY does not replace), and
-- CREATE OR REPLACE FUNCTION.

DROP POLICY IF EXISTS kitsuden_links_owner_isolation ON kitsuden_links;
CREATE POLICY kitsuden_links_owner_isolation ON kitsuden_links
  FOR ALL
  TO PUBLIC
  USING (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR owner_id = current_setting('app.current_user_id', true)
    OR (owner_id IS NULL AND COALESCE(current_setting('app.current_user_id', true), '') <> '')
  )
  WITH CHECK (
    (COALESCE(current_setting('app.current_user_id', true), '') = ''
     AND COALESCE(current_setting('app.current_user_role', true), '') = '')
    OR current_setting('app.current_user_role', true) = 'admin'
    OR owner_id = current_setting('app.current_user_id', true)
  );

CREATE OR REPLACE FUNCTION is_rls_active()
RETURNS boolean AS $$
BEGIN
    RETURN COALESCE(current_setting('app.current_user_id', true), '') != '';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION current_rls_user_id()
RETURNS text AS $$
BEGIN
    RETURN current_setting('app.current_user_id', true);
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION set_rls_context(user_id text, user_role text DEFAULT 'user')
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_user_id', user_id, false);
    PERFORM set_config('app.current_user_role', user_role, false);
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION clear_rls_context()
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_user_id', '', false);
    PERFORM set_config('app.current_user_role', '', false);
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp;
