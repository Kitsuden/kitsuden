-- AGENT functions for the kons' RLS (core)
-- ============================================================================
-- Idempotent (CREATE OR REPLACE). Applied BEFORE the migrations of
-- any kon: scripts/migrate.ts and lib/kon-migrations.ts (activating a kon
-- from the panel, or at startup). That way a kon migration can use them.
--
-- An agent reaches Postgres with app.current_user_role = 'agent' and its scopes
-- in app.agent_scopes (comma-separated, local to the transaction:
-- packages/engine/src/rls-request.ts). The kons' policies asked
-- for the HUMAN role, and an agent with `admin` saw empty lists (dms,
-- members, booking). These functions are the SAME rule as the engine's
-- (packages/engine/src/effective-actor.ts and @kitsuden/shared
-- agent-permission.ts); a test compares the two with the same table:
--
--   kitsuden_agent_opens_kon('crm')     agent with admin, crm:* or kon:crm:*
--                                       (literals; kon:* does NOT) and no denial
--                                       covering crm:* or kon:crm:*
--   kitsuden_effective_admin('crm')      human admin role, or the above
--   kitsuden_effective_staff('crm')      human admin/editor role, or the above
--   kitsuden_agent_can('accounting:view')  agent whose scopes grant that
--                                       (wildcards; a denial wins)
--   kitsuden_agent_can_in_kon('members', 'member:view')
--                                       the above WITHIN a kon: it is also
--                                       opened by the whole kon and closed by
--                                       `!members:*` (even if it doesn't start the same)
--
-- kitsuden_pattern_covers, kitsuden_agent_grants and kitsuden_agent_denied
-- are a LITERAL COPY of those in rls-policies.sql (which is applied AFTER the
-- migrations): a test requires that they say the same.

CREATE OR REPLACE FUNCTION kitsuden_pattern_covers(pattern text, required text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $FN$
DECLARE
  p text[];
  r text[];
  n int;
  i int;
BEGIN
  IF pattern IS NULL OR required IS NULL OR pattern = '' OR required = '' THEN RETURN false; END IF;
  IF pattern = required THEN RETURN true; END IF;
  p := string_to_array(pattern, ':');
  n := array_length(p, 1);
  IF n < 2 THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(p) AS x WHERE x <> '*') THEN RETURN false; END IF;
  IF p[1] = '*' THEN
    RETURN length(required) >= length(pattern) - 1
       AND right(required, length(pattern) - 1) = substr(pattern, 2);
  END IF;
  r := string_to_array(required, ':');
  IF p[n] = '*' THEN
    IF array_length(r, 1) <= n - 1 THEN RETURN false; END IF;
    n := n - 1;
  ELSIF array_length(r, 1) <> n THEN
    RETURN false;
  END IF;
  FOR i IN 1..n LOOP
    IF p[i] = '*' THEN
      IF coalesce(r[i], '') = '' THEN RETURN false; END IF;
    ELSIF p[i] IS DISTINCT FROM r[i] THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_agent_grants(p_required text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  scopes text[];
  s text;
BEGIN
  IF raw_scopes = '' OR p_required IS NULL THEN RETURN false; END IF;
  scopes := string_to_array(raw_scopes, ',');
  FOREACH s IN ARRAY scopes LOOP
    IF left(s, 1) = '!' AND kitsuden_pattern_covers(substr(s, 2), p_required) THEN RETURN false; END IF;
  END LOOP;
  FOREACH s IN ARRAY scopes LOOP
    IF left(s, 1) <> '!' AND (s = 'admin' OR s = 'admin:*' OR kitsuden_pattern_covers(s, p_required)) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_agent_denied(p_required text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  s text;
BEGIN
  IF raw_scopes = '' THEN RETURN false; END IF;
  FOREACH s IN ARRAY string_to_array(raw_scopes, ',') LOOP
    IF left(s, 1) = '!' AND kitsuden_pattern_covers(substr(s, 2), p_required) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_agent_opens_kon(p_kon text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $FN$
DECLARE
  raw_scopes text := coalesce(current_setting('app.agent_scopes', true), '');
  broad text[];
  s text;
BEGIN
  IF raw_scopes = '' OR coalesce(p_kon, '') = '' THEN RETURN false; END IF;
  IF coalesce(current_setting('app.current_user_role', true), '') <> 'agent' THEN RETURN false; END IF;
  broad := ARRAY[p_kon || ':*', 'kon:' || p_kon || ':*'];
  FOREACH s IN ARRAY string_to_array(raw_scopes, ',') LOOP
    IF left(s, 1) = '!' AND (kitsuden_pattern_covers(substr(s, 2), broad[1])
                             OR kitsuden_pattern_covers(substr(s, 2), broad[2])) THEN
      RETURN false;
    END IF;
  END LOOP;
  FOREACH s IN ARRAY string_to_array(raw_scopes, ',') LOOP
    IF s = 'admin' OR s = 'admin:*' OR s = ANY (broad) THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_effective_admin(p_kon text)
RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT coalesce(current_setting('app.current_user_role', true), '') = 'admin'
      OR kitsuden_agent_opens_kon(p_kon)
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_effective_staff(p_kon text)
RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT coalesce(current_setting('app.current_user_role', true), '') IN ('admin', 'editor')
      OR kitsuden_agent_opens_kon(p_kon)
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_agent_can(p_required text)
RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT coalesce(current_setting('app.current_user_role', true), '') = 'agent'
     AND kitsuden_agent_grants(p_required)
$FN$;

-- A single permission WITHIN a kon: the agent can `p_required`
-- (`member:view`, `booking:listAll`…) or opens the whole kon, and no
-- denial closes either the action or the whole kon (`!members:*` also closes
-- `member:view`, which does not start with `members:`).
CREATE OR REPLACE FUNCTION kitsuden_agent_can_in_kon(p_kon text, p_required text)
RETURNS boolean LANGUAGE sql STABLE AS $FN$
  SELECT coalesce(current_setting('app.current_user_role', true), '') = 'agent'
     AND NOT kitsuden_agent_denied(p_kon || ':*')
     AND NOT kitsuden_agent_denied('kon:' || p_kon || ':*')
     AND NOT kitsuden_agent_denied(p_required)
     AND (kitsuden_agent_opens_kon(p_kon) OR kitsuden_agent_grants(p_required))
$FN$;

-- ── A kon table's row security in one line ──────────────────────────────────
-- Kons used to write the same three policies by hand in every migration (and copy them wrong).
-- These declare them; each call is idempotent (DROP POLICY IF EXISTS first), so a later
-- migration can call it again with other scopes.
--
--   SELECT kitsuden_rls_team('shop_promotions', 'ecommerce', 'shop-promotion:view', 'shop-promotion:update');
--
--     The table belongs to the kon's TEAM. It is read and written by:
--       · the SYSTEM: no user AND no role in the context (a migration, a worker, a route that
--         runs `ctx.db.asSystem` after authorizing in the application). An anonymous request
--         carries the role `anonymous`, so it is not the system;
--       · the human roles admin and editor;
--       · an agent whose scopes grant `p_view` (read) or `p_change` (read and write) within the
--         kon, with the core's rule (a denial wins; `<kon>:*` and `kon:<kon>:*` open it all).
--     Pass NULL for a scope no agent should have.
--
--   SELECT kitsuden_rls_owned('notes', 'owner_id', 'notes', 'note:view', 'note:update');
--
--     The same, plus: a signed-in user reads and writes the rows whose `p_owner_column` is
--     their id. For personal data (a member's profile, a reader's list).
--
--   SELECT kitsuden_rls_public_read('recipes', $$status = 'published'$$);
--
--     Adds: ANYONE (anonymous too) reads the rows that meet the condition. Only reads; it goes on
--     top of one of the two above, which decide who writes.

CREATE OR REPLACE FUNCTION kitsuden_rls_team(
  p_table text, p_kon text, p_view text DEFAULT NULL, p_change text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $FN$
DECLARE
  team CONSTANT text :=
    '((COALESCE(current_setting(''app.current_user_id'', true), '''') = '''' '
    || 'AND COALESCE(current_setting(''app.current_user_role'', true), '''') = '''') '
    || 'OR current_setting(''app.current_user_role'', true) IN (''admin'', ''editor''))';
  reads text;
  changes text;
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  -- Without FORCE the table owner is exempt and the policy is decoration.
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_team', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
    p_table || '_team', p_table, team, team);

  changes := CASE WHEN p_change IS NULL THEN NULL
                  ELSE format('kitsuden_agent_can_in_kon(%L, %L)', p_kon, p_change) END;
  reads := concat_ws(' OR ',
    CASE WHEN p_view IS NULL THEN NULL ELSE format('kitsuden_agent_can_in_kon(%L, %L)', p_kon, p_view) END,
    changes);

  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_agent_reads', p_table);
  IF reads <> '' THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO PUBLIC USING (%s)',
      p_table || '_agent_reads', p_table, reads);
  END IF;

  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_agent_changes', p_table);
  IF changes IS NOT NULL THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      p_table || '_agent_changes', p_table, changes, changes);
  END IF;
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_rls_owned(
  p_table text, p_owner_column text, p_kon text, p_view text DEFAULT NULL, p_change text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $FN$
DECLARE
  own text;
BEGIN
  PERFORM kitsuden_rls_team(p_table, p_kon, p_view, p_change);
  own := format(
    '(COALESCE(current_setting(''app.current_user_id'', true), '''') <> '''' '
    || 'AND %I = current_setting(''app.current_user_id'', true))', p_owner_column);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_owner', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
    p_table || '_owner', p_table, own, own);
END
$FN$;

CREATE OR REPLACE FUNCTION kitsuden_rls_public_read(p_table text, p_condition text)
RETURNS void LANGUAGE plpgsql AS $FN$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p_table || '_public_read', p_table);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO PUBLIC USING (%s)',
    p_table || '_public_read', p_table, p_condition);
END
$FN$;
