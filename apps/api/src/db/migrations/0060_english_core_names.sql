-- The core's own SQL names in English, before the first public release.
--
-- Earlier migrations are checksummed and stay as they were written, so a fresh
-- database creates the old names and this file renames them; an existing one
-- only runs this. Everything here preserves data, except the idempotency
-- records: a replay cache with a short life whose JSON changes shape.

-- ── Idempotency ─────────────────────────────────────────────────────────────

ALTER TABLE kitsuden_idempotencia RENAME TO kitsuden_idempotency;
ALTER TABLE kitsuden_idempotency RENAME COLUMN clave TO idempotency_key;
ALTER TABLE kitsuden_idempotency RENAME COLUMN registro TO record;
ALTER TABLE kitsuden_idempotency RENAME COLUMN expira_en TO expires_at;
ALTER INDEX kitsuden_idempotencia_expira_idx RENAME TO kitsuden_idempotency_expires_idx;
DELETE FROM kitsuden_idempotency;

-- ── Outbox queue ────────────────────────────────────────────────────────────

ALTER INDEX kitsuden_outbox_pendientes_idx RENAME TO kitsuden_outbox_pending_idx;
ALTER INDEX kitsuden_outbox_en_curso_idx RENAME TO kitsuden_outbox_running_idx;
ALTER INDEX kitsuden_outbox_estado_idx RENAME TO kitsuden_outbox_status_idx;

DROP FUNCTION kitsuden_cola_reclamar(text[], integer, integer, text);
DROP FUNCTION kitsuden_cola_completar(uuid, text);
DROP FUNCTION kitsuden_cola_fallar(uuid, text, text, integer, boolean);
DROP FUNCTION kitsuden_cola_barrer(integer);
DROP FUNCTION kitsuden_cola_estado();
DROP FUNCTION kitsuden_cola_muertos(integer);
DROP FUNCTION kitsuden_cola_reintentar(uuid);
DROP FUNCTION kitsuden_cola_descartar(uuid);

CREATE OR REPLACE FUNCTION kitsuden_queue_claim(
  p_queues text[], p_how_many integer, p_lease_s integer, p_worker text
) RETURNS SETOF kitsuden_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  WITH chosen AS (
    SELECT o.id FROM kitsuden_outbox o
    WHERE o.status = 'pending' AND o.queue = ANY (p_queues) AND o.run_at <= now()
    ORDER BY o.run_at
    LIMIT GREATEST(p_how_many, 0)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE kitsuden_outbox o
     SET status = 'running',
         attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => GREATEST(p_lease_s, 1)),
         locked_by = p_worker
    FROM chosen
   WHERE o.id = chosen.id
  RETURNING o.*;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_complete(p_id uuid, p_worker text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_outbox
     SET status = 'done', finished_at = now(), locked_until = NULL, last_error = NULL
   WHERE id = p_id AND status = 'running' AND locked_by = p_worker;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_fail(
  p_id uuid, p_worker text, p_error text, p_retry_in_s integer, p_final boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE kitsuden_outbox
     SET status = CASE WHEN p_final OR attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         run_at = now() + make_interval(secs => GREATEST(p_retry_in_s, 0)),
         finished_at = CASE WHEN p_final OR attempts >= max_attempts THEN now() ELSE NULL END,
         locked_until = NULL,
         last_error = left(p_error, 2000)
   WHERE id = p_id AND status = 'running' AND locked_by = p_worker
  RETURNING status INTO v_status;
  RETURN v_status;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_sweep(p_retention_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_orphans integer;
BEGIN
  WITH expired AS (
    SELECT id FROM kitsuden_outbox
     WHERE status = 'running' AND locked_until < now()
     FOR UPDATE SKIP LOCKED
  )
  UPDATE kitsuden_outbox o
     SET status = CASE WHEN o.attempts >= o.max_attempts THEN 'dead' ELSE 'pending' END,
         finished_at = CASE WHEN o.attempts >= o.max_attempts THEN now() ELSE NULL END,
         run_at = now(),
         locked_until = NULL,
         last_error = 'lease_expired: the worker did not close the job in time'
    FROM expired
   WHERE o.id = expired.id;
  GET DIAGNOSTICS v_orphans = ROW_COUNT;

  DELETE FROM kitsuden_outbox
   WHERE status = 'done' AND finished_at < now() - make_interval(days => GREATEST(p_retention_days, 0));

  RETURN v_orphans;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_status()
RETURNS TABLE (queue text, status text, total bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT o.queue, o.status, count(*) FROM kitsuden_outbox o GROUP BY o.queue, o.status;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_dead(p_limit integer)
RETURNS TABLE (
  id uuid, queue text, name text, attempts integer, max_attempts integer,
  last_error text, user_id text, agent_id text, created_at timestamptz, finished_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT o.id, o.queue, o.name, o.attempts, o.max_attempts, o.last_error,
         o.user_id, o.agent_id, o.created_at, o.finished_at
    FROM kitsuden_outbox o
   WHERE o.status = 'dead'
   ORDER BY o.finished_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(p_limit, 1), 500);
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_retry(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_outbox
     SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL, last_error = NULL
   WHERE id = p_id AND status = 'dead';
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_queue_discard(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM kitsuden_outbox WHERE id = p_id AND status = 'dead';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_queue_claim(text[], integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_complete(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_fail(uuid, text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_sweep(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_dead(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_retry(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_queue_discard(uuid) FROM PUBLIC;

-- ── Request traces ──────────────────────────────────────────────────────────

DROP FUNCTION kitsuden_trazas_rotar(integer);
DROP FUNCTION kitsuden_trazas_listar(timestamptz, integer, boolean, text, boolean);
DROP FUNCTION kitsuden_trazas_resumen(timestamptz);

ALTER TABLE kitsuden_trazas RENAME TO kitsuden_request_traces;
ALTER TABLE kitsuden_request_traces RENAME COLUMN creado TO created_at;
ALTER TABLE kitsuden_request_traces RENAME COLUMN metodo TO method;
ALTER TABLE kitsuden_request_traces RENAME COLUMN ruta TO route;
ALTER TABLE kitsuden_request_traces RENAME COLUMN estado TO status;
ALTER TABLE kitsuden_request_traces RENAME COLUMN actor_tipo TO actor_type;
ALTER TABLE kitsuden_request_traces RENAME COLUMN operacion TO operation;
ALTER TABLE kitsuden_request_traces RENAME COLUMN duracion_ms TO duration_ms;
ALTER TABLE kitsuden_request_traces RENAME COLUMN tiempo_db_ms TO db_time_ms;
ALTER TABLE kitsuden_request_traces RENAME COLUMN consultas TO queries;
ALTER TABLE kitsuden_request_traces RENAME COLUMN filas_afectadas TO rows_affected;
ALTER TABLE kitsuden_request_traces RENAME COLUMN bloqueos TO denials;
ALTER TABLE kitsuden_request_traces RENAME COLUMN detalle_bloqueos TO denial_details;
ALTER INDEX kitsuden_trazas_creado_idx RENAME TO kitsuden_request_traces_created_idx;
ALTER INDEX kitsuden_trazas_actor_idx RENAME TO kitsuden_request_traces_actor_idx;
ALTER INDEX kitsuden_trazas_bloqueos_idx RENAME TO kitsuden_request_traces_denials_idx;

DO $$
DECLARE
  v_part record;
BEGIN
  FOR v_part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'kitsuden_request_traces'
       AND c.relname ~ '^kitsuden_trazas_[0-9]{8}$'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I RENAME TO %I',
      v_part.relname,
      'kitsuden_request_traces_' || substring(v_part.relname from '[0-9]{8}$')
    );
  END LOOP;
END $$;

UPDATE kitsuden_request_traces SET actor_type = 'human' WHERE actor_type = 'humano';
UPDATE kitsuden_request_traces SET actor_type = 'agent' WHERE actor_type = 'agente';
UPDATE kitsuden_request_traces SET actor_type = 'anonymous' WHERE actor_type = 'anonimo';
UPDATE kitsuden_request_traces
   SET denial_details = replace(replace(denial_details::text, '"motivo"', '"reason"'), '"tabla"', '"table"')::jsonb
 WHERE denial_details IS NOT NULL;
UPDATE kitsuden_request_traces
   SET denial_details = replace(replace(replace(denial_details::text, '"operacion"', '"operation"'), '"no_es_tuyo"', '"not_yours"'), '"no_existe"', '"not_found"')::jsonb
 WHERE denial_details IS NOT NULL;

CREATE OR REPLACE FUNCTION kitsuden_traces_rotate(p_days integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_day date;
  v_name text;
  v_dropped integer := 0;
  v_part record;
BEGIN
  FOR i IN 0..2 LOOP
    v_day := (now() AT TIME ZONE 'UTC')::date + i;
    v_name := 'kitsuden_request_traces_' || to_char(v_day, 'YYYYMMDD');
    IF to_regclass('public.' || v_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.kitsuden_request_traces FOR VALUES FROM (%L) TO (%L)',
        v_name,
        (v_day::timestamp AT TIME ZONE 'UTC'),
        ((v_day + 1)::timestamp AT TIME ZONE 'UTC')
      );
    END IF;
  END LOOP;

  FOR v_part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'kitsuden_request_traces'
       AND c.relname ~ '^kitsuden_request_traces_[0-9]{8}$'
       AND to_date(substring(c.relname from '[0-9]{8}$'), 'YYYYMMDD')
           < (now() AT TIME ZONE 'UTC')::date - GREATEST(p_days, 1)
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', v_part.relname);
    v_dropped := v_dropped + 1;
  END LOOP;
  RETURN v_dropped;
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_traces_list(
  p_since timestamptz, p_limit integer, p_only_denials boolean, p_actor text, p_only_errors boolean
) RETURNS SETOF kitsuden_request_traces
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM kitsuden_request_traces t
   WHERE t.created_at >= p_since
     AND (NOT p_only_denials OR t.denials > 0)
     AND (NOT p_only_errors OR t.status >= 400)
     AND (p_actor IS NULL OR t.actor_id = p_actor)
   ORDER BY t.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;

CREATE OR REPLACE FUNCTION kitsuden_traces_summary(p_since timestamptz)
RETURNS TABLE (
  kon text, operation text, method text, route text, requests bigint, errors bigint,
  denials bigint, p95_ms double precision, avg_db_ms double precision, "rows" bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT t.kon, t.operation, t.method, t.route,
         count(*),
         count(*) FILTER (WHERE t.status >= 500),
         COALESCE(sum(t.denials), 0)::bigint,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY t.duration_ms),
         avg(t.db_time_ms)::double precision,
         COALESCE(sum(t.rows_affected), 0)::bigint
    FROM kitsuden_request_traces t
   WHERE t.created_at >= p_since
   GROUP BY t.kon, t.operation, t.method, t.route
   ORDER BY count(*) DESC
   LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_traces_rotate(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_traces_list(timestamptz, integer, boolean, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_traces_summary(timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_queue_claim(text[], integer, integer, text) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_complete(uuid, text) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_fail(uuid, text, text, integer, boolean) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_sweep(integer) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_status() TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_dead(integer) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_retry(uuid) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_queue_discard(uuid) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_traces_rotate(integer) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_traces_list(timestamptz, integer, boolean, text, boolean) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_traces_summary(timestamptz) TO kitsuden_app;
  END IF;
END $$;

-- ── Brain memory ────────────────────────────────────────────────────────────

ALTER TABLE brain_connections RENAME COLUMN origen TO origin;
ALTER TABLE brain_connections RENAME COLUMN confianza TO confidence;

-- ── Policies on data_entries ────────────────────────────────────────────────
-- rls-policies.sql recreates them, under English names, right after the migrations.

DROP POLICY IF EXISTS data_entries_agente_lectura ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_alta ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_edicion ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_borrado ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_politica_lectura ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_politica_alta ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_politica_edicion ON data_entries;
DROP POLICY IF EXISTS data_entries_agente_politica_borrado ON data_entries;

DROP FUNCTION IF EXISTS kitsuden_agente_abre_dataset(uuid, text);
DROP FUNCTION IF EXISTS kitsuden_agente_abre_por_politica(uuid, text);

-- ── Stored scopes and JSON keys ─────────────────────────────────────────────
-- Scopes live in JSON arrays, where they can carry a `!` denial in front.

UPDATE agent_identities
   SET scopes = replace(replace(scopes::text, 'contenido:editar', 'content:edit'), 'usuario:actuar', 'user:act')::jsonb
 WHERE scopes::text ~ 'contenido:editar|usuario:actuar';
UPDATE agent_proposals
   SET scopes = replace(replace(scopes::text, 'contenido:editar', 'content:edit'), 'usuario:actuar', 'user:act')::jsonb
 WHERE scopes::text ~ 'contenido:editar|usuario:actuar';

DO $$
DECLARE
  v_table text;
  v_column text;
BEGIN
  FOR v_table, v_column IN
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('oauth_authorization_requests', 'oauth_codes', 'oauth_grants', 'oauth_tokens')
       AND column_name IN ('scopes', 'requested_scopes')
  LOOP
    EXECUTE format(
      $f$UPDATE %1$I SET %2$I = replace(replace(%2$I::text, 'contenido:editar', 'content:edit'), 'usuario:actuar', 'user:act')::jsonb
          WHERE %2$I::text ~ 'contenido:editar|usuario:actuar'$f$,
      v_table, v_column
    );
  END LOOP;
END $$;

-- Who decided a code version, and by which path.
UPDATE code_versions
   SET decision = replace(replace(replace(decision::text, '"ruta":', '"route":'), '"motivos":', '"reasons":'), '"tipo":', '"type":')::jsonb
 WHERE decision IS NOT NULL;

UPDATE site_settings s
   SET social = jsonb_set(
         s.social,
         '{youtubeChannels}',
         (SELECT jsonb_agg((e - 'nombre') || jsonb_build_object('name', e -> 'nombre'))
            FROM jsonb_array_elements(s.social -> 'youtubeChannels') e)
       )
 WHERE jsonb_typeof(s.social -> 'youtubeChannels') = 'array'
   AND jsonb_array_length(s.social -> 'youtubeChannels') > 0;
