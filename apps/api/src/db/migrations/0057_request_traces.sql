-- 0057 — Request traces: the "glass box"
-- ============================================================================
-- One row per logged request (all writes, errors and blocks;
-- reads, sampled): who (person, agent, anonymous), which kon and which
-- operation, how long it took, how much of that was the database, how many rows it wrote
-- and whether a write hit the owner filter or RLS.
--
-- No body, no headers, no parameters: the route is NORMALIZED (ids
-- as :id). It is an operation trace, not a record of personal data.
--
-- 1. Partitioned by DAY (`creado`): rotating means dropping whole partitions, with no
--    DELETE or VACUUM. `kitsuden_trazas_rotar(dias)` creates today and the next two
--    days and drops whatever exceeds the retention. The API calls it on
--    startup and every hour; this migration, once.
-- 2. No DEFAULT partition on purpose: with one, creating the partition of a day
--    that already had rows in DEFAULT would fail. An insert without a partition
--    fails, the writer calls `rotar` and retries.
-- 3. Without RLS and with its own permissions (like kitsuden_outbox): the app INSERTS;
--    reading and rotating, through SECURITY DEFINER functions. Only the panel (admin) reads.

CREATE TABLE IF NOT EXISTS kitsuden_trazas (
  creado timestamptz NOT NULL DEFAULT now(),
  request_id text,
  trace_id text,
  metodo text NOT NULL,
  ruta text NOT NULL,
  estado integer NOT NULL,
  actor_tipo text NOT NULL,
  actor_id text,
  kon text,
  operacion text,
  duracion_ms integer NOT NULL,
  tiempo_db_ms integer,
  consultas integer,
  filas_afectadas integer,
  bloqueos integer NOT NULL DEFAULT 0,
  detalle_bloqueos jsonb
) PARTITION BY RANGE (creado);

CREATE INDEX IF NOT EXISTS kitsuden_trazas_creado_idx ON kitsuden_trazas (creado DESC);
CREATE INDEX IF NOT EXISTS kitsuden_trazas_actor_idx ON kitsuden_trazas (actor_id, creado DESC);
CREATE INDEX IF NOT EXISTS kitsuden_trazas_bloqueos_idx ON kitsuden_trazas (creado DESC) WHERE bloqueos > 0;

-- ── Rotate: creates today, tomorrow and the day after; drops what is older than retention ─
CREATE OR REPLACE FUNCTION kitsuden_trazas_rotar(p_dias integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_dia date;
  v_nombre text;
  v_borradas integer := 0;
  v_part record;
BEGIN
  FOR i IN 0..2 LOOP
    v_dia := (now() AT TIME ZONE 'UTC')::date + i;
    v_nombre := 'kitsuden_trazas_' || to_char(v_dia, 'YYYYMMDD');
    IF to_regclass('public.' || v_nombre) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.kitsuden_trazas FOR VALUES FROM (%L) TO (%L)',
        v_nombre,
        (v_dia::timestamp AT TIME ZONE 'UTC'),
        ((v_dia + 1)::timestamp AT TIME ZONE 'UTC')
      );
    END IF;
  END LOOP;

  FOR v_part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'kitsuden_trazas'
       AND c.relname ~ '^kitsuden_trazas_[0-9]{8}$'
       AND to_date(substring(c.relname from '[0-9]{8}$'), 'YYYYMMDD')
           < (now() AT TIME ZONE 'UTC')::date - GREATEST(p_dias, 1)
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I', v_part.relname);
    v_borradas := v_borradas + 1;
  END LOOP;
  RETURN v_borradas;
END;
$$;

-- ── Panel: traces, from most recent to oldest ──────────────────────────────
CREATE OR REPLACE FUNCTION kitsuden_trazas_listar(
  p_desde timestamptz, p_limite integer, p_solo_bloqueos boolean, p_actor text, p_solo_errores boolean
) RETURNS SETOF kitsuden_trazas
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM kitsuden_trazas t
   WHERE t.creado >= p_desde
     AND (NOT p_solo_bloqueos OR t.bloqueos > 0)
     AND (NOT p_solo_errores OR t.estado >= 400)
     AND (p_actor IS NULL OR t.actor_id = p_actor)
   ORDER BY t.creado DESC
   LIMIT LEAST(GREATEST(p_limite, 1), 1000);
END;
$$;

-- ── Panel: summary per kon and operation ───────────────────────────────────
CREATE OR REPLACE FUNCTION kitsuden_trazas_resumen(p_desde timestamptz)
RETURNS TABLE (
  kon text, operacion text, metodo text, ruta text, peticiones bigint, errores bigint,
  bloqueos bigint, p95_ms double precision, media_db_ms double precision, filas bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT t.kon, t.operacion, t.metodo, t.ruta,
         count(*),
         count(*) FILTER (WHERE t.estado >= 500),
         COALESCE(sum(t.bloqueos), 0)::bigint,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY t.duracion_ms),
         avg(t.tiempo_db_ms)::double precision,
         COALESCE(sum(t.filas_afectadas), 0)::bigint
    FROM kitsuden_trazas t
   WHERE t.creado >= p_desde
   GROUP BY t.kon, t.operacion, t.metodo, t.ruta
   ORDER BY count(*) DESC
   LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_trazas_rotar(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_trazas_listar(timestamptz, integer, boolean, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_trazas_resumen(timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    REVOKE ALL ON kitsuden_trazas FROM kitsuden_app;
    GRANT INSERT ON kitsuden_trazas TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_trazas_rotar(integer) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_trazas_listar(timestamptz, integer, boolean, text, boolean) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_trazas_resumen(timestamptz) TO kitsuden_app;
  END IF;
END $$;

SELECT kitsuden_trazas_rotar(7);
