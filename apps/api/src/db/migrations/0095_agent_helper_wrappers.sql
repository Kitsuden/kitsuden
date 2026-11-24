-- 0095 — The agent helpers' earlier (Spanish) names call the English functions
-- ============================================================================
--
-- 0075 drops each Spanish-named agent helper unless pg_depend says something depends on it (a
-- policy written by a kon migration before the rename). pg_depend only sees direct references:
-- the body of a plpgsql or a string-bodied SQL function is not tracked. So on a database that
-- came from 0.8, 0075 could keep `kitsuden_agente_puede_en_kon` (a kon policy calls it) with its
-- 0.8 body, which calls `kitsuden_agente_denegado` by name, and drop `kitsuden_agente_denegado`
-- (nothing "depends" on it). The next agent request on that kon's table failed with
--
--     function kitsuden_agente_denegado(text) does not exist
--
-- The dataset wrappers a policy kept (`kitsuden_agente_abre_dataset`,
-- `kitsuden_agente_abre_por_politica`) had the same 0.8 bodies, so agents reading datasets failed too.
--
-- Here each Spanish name is made a thin wrapper of its English function:
--   · if it still exists, its body is replaced (same parameter names, same volatility), so it no
--     longer calls any other Spanish name and stays in step with the English function;
--   · if it was dropped but a function body or a policy in the database still names it, it is
--     created again as a wrapper.
-- On a database created from scratch none of them exists and nothing names them: nothing happens.
-- Idempotent.
--
-- The helpers' English functions come from agent-functions.sql, applied before the pending
-- migrations; the two dataset functions from rls-policies.sql, applied right after them. Bodies are
-- not checked while creating the wrappers, so a wrapper may name a function that is created a moment
-- later in the same run.

DO $$
DECLARE
  h record;
  sig text;
  old_oid oid;
  arg_names text[];
  vol text;
  named boolean;
  params text;
  call_args text;
  pass int;
BEGIN
  PERFORM set_config('check_function_bodies', 'off', true);

  -- Pass 1 rewrites the ones that exist; pass 2 then looks for callers of the ones that do not, so a
  -- 0.8 body rewritten in pass 1 no longer counts as one.
  FOR pass IN 1..2 LOOP
    FOR h IN
      SELECT * FROM (VALUES
        ('kitsuden_patron_cubre',             ARRAY['text', 'text'], 'kitsuden_pattern_covers',        ARRAY['patron', 'requerido']),
        ('kitsuden_agente_concede',           ARRAY['text'],         'kitsuden_agent_grants',          ARRAY['p_requerido']),
        ('kitsuden_agente_denegado',          ARRAY['text'],         'kitsuden_agent_denied',          ARRAY['p_requerido']),
        ('kitsuden_agente_abre_kon',          ARRAY['text'],         'kitsuden_agent_opens_kon',       ARRAY['p_kon']),
        ('kitsuden_admin_efectivo',           ARRAY['text'],         'kitsuden_effective_admin',       ARRAY['p_kon']),
        ('kitsuden_staff_efectivo',           ARRAY['text'],         'kitsuden_effective_staff',       ARRAY['p_kon']),
        ('kitsuden_agente_puede',             ARRAY['text'],         'kitsuden_agent_can',             ARRAY['p_requerido']),
        ('kitsuden_agente_puede_en_kon',      ARRAY['text', 'text'], 'kitsuden_agent_can_in_kon',      ARRAY['p_kon', 'p_requerido']),
        ('kitsuden_agente_abre_dataset',      ARRAY['uuid', 'text'], 'kitsuden_agent_opens_dataset',   ARRAY['p_data_set_id', 'p_accion']),
        ('kitsuden_agente_abre_por_politica', ARRAY['uuid', 'text'], 'kitsuden_agent_opens_by_policy', ARRAY['p_data_set_id', 'p_accion'])
      ) AS t(old_name, arg_types, english, default_names)
    LOOP
      sig := h.old_name || '(' || array_to_string(h.arg_types, ',') || ')';
      old_oid := to_regprocedure(sig);
      IF (pass = 1) <> (old_oid IS NOT NULL) THEN CONTINUE; END IF;

      IF old_oid IS NULL THEN
        -- Dropped: only recreate it when something in the database still calls it by name.
        SELECT EXISTS (
                 SELECT 1 FROM pg_proc p
                   JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public'
                    AND p.prosrc ~ ('\m' || h.old_name || '\M')
               ) OR EXISTS (
                 SELECT 1 FROM pg_policies
                  WHERE coalesce(qual, '') ~ ('\m' || h.old_name || '\M')
                     OR coalesce(with_check, '') ~ ('\m' || h.old_name || '\M')
               )
          INTO named;
        IF NOT named THEN CONTINUE; END IF;
        arg_names := h.default_names;
        vol := CASE WHEN h.old_name = 'kitsuden_patron_cubre' THEN 'IMMUTABLE' ELSE 'STABLE' END;
      ELSE
        -- CREATE OR REPLACE cannot rename a parameter: keep the ones the function has.
        SELECT coalesce(p.proargnames, h.default_names),
               CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 'v' THEN 'VOLATILE' ELSE 'STABLE' END
          INTO arg_names, vol
          FROM pg_proc p WHERE p.oid = old_oid;
      END IF;

      SELECT string_agg(quote_ident(arg_names[i]) || ' ' || h.arg_types[i], ', ' ORDER BY i),
             string_agg('$' || i, ', ' ORDER BY i)
        INTO params, call_args
        FROM generate_subscripts(h.arg_types, 1) AS i;

      EXECUTE format(
        'CREATE OR REPLACE FUNCTION %I(%s) RETURNS boolean LANGUAGE sql %s AS %L',
        h.old_name, params, vol,
        format('SELECT %I(%s)', h.english, call_args)
      );
    END LOOP;
  END LOOP;
END $$;
