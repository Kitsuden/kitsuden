-- 0056 — The job queue lives in Postgres (transactional outbox, 2026-10-28)
-- ============================================================================
-- Replaces BullMQ. Idempotent: IF NOT EXISTS and
-- CREATE OR REPLACE on everything.
--
-- 1. kitsuden_outbox: one job per row. `queue.dispatch()` INSERTS it
--    inside the request's transaction: if the request ends in
--    ROLLBACK the job does not exist; if it commits, it is ready for the worker.
-- 2. States: pending → running → done | dead.
--      · running carries `locked_until` (a lease). If the worker dies
--        midway, `kitsuden_cola_barrer()` returns it to pending (or to dead if
--        it already used up its attempts). `SKIP LOCKED` only protects for the duration of
--        the claim transaction; the lease covers the rest.
--      · dead is the "dead letter": it keeps its last error so that the
--        panel shows it and someone retries it (`kitsuden_cola_reintentar`).
--      · done is deleted after N days (sweep retention).
-- 3. Without RLS on purpose, and with its own permissions: the application role
--    only INSERTS. Reading, claiming and closing jobs goes through
--    SECURITY DEFINER functions with a narrow contract (there is no free SELECT on the
--    payloads, which carry email addresses). Nobody needs BYPASSRLS.
-- 4. The actor (user_id / agent_id) is stored, but the worker RE-READS its
--    permissions at execution time: a job queued yesterday does not run with
--    permissions revoked today.
-- 5. "At least once" delivery: handlers must be idempotent.

CREATE TABLE IF NOT EXISTS kitsuden_outbox (
  id uuid PRIMARY KEY,
  queue text NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  user_id text,
  user_role text,
  agent_id text,
  request_id text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- What the worker looks for on each pass: pending jobs of a queue, in order.
CREATE INDEX IF NOT EXISTS kitsuden_outbox_pendientes_idx
  ON kitsuden_outbox (queue, run_at) WHERE status = 'pending';
-- What the sweep looks at: expired leases.
CREATE INDEX IF NOT EXISTS kitsuden_outbox_en_curso_idx
  ON kitsuden_outbox (locked_until) WHERE status = 'running';
-- Retention and panel.
CREATE INDEX IF NOT EXISTS kitsuden_outbox_estado_idx
  ON kitsuden_outbox (status, finished_at);

-- ── Claim: up to `p_cuantos` ready jobs from those queues ──────────────────
CREATE OR REPLACE FUNCTION kitsuden_cola_reclamar(
  p_colas text[], p_cuantos integer, p_arriendo_s integer, p_worker text
) RETURNS SETOF kitsuden_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  WITH elegidos AS (
    SELECT o.id FROM kitsuden_outbox o
    WHERE o.status = 'pending' AND o.queue = ANY (p_colas) AND o.run_at <= now()
    ORDER BY o.run_at
    LIMIT GREATEST(p_cuantos, 0)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE kitsuden_outbox o
     SET status = 'running',
         attempts = o.attempts + 1,
         locked_until = now() + make_interval(secs => GREATEST(p_arriendo_s, 1)),
         locked_by = p_worker
    FROM elegidos
   WHERE o.id = elegidos.id
  RETURNING o.*;
END;
$$;

-- ── Complete: only whoever has it claimed ──────────────────────────────────
CREATE OR REPLACE FUNCTION kitsuden_cola_completar(p_id uuid, p_worker text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_outbox
     SET status = 'done', finished_at = now(), locked_until = NULL, last_error = NULL
   WHERE id = p_id AND status = 'running' AND locked_by = p_worker;
  RETURN FOUND;
END;
$$;

-- ── Fail: retry with backoff, or dead if attempts are used up ──────────────
CREATE OR REPLACE FUNCTION kitsuden_cola_fallar(
  p_id uuid, p_worker text, p_error text, p_reintentar_en_s integer, p_definitivo boolean
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_estado text;
BEGIN
  UPDATE kitsuden_outbox
     SET status = CASE WHEN p_definitivo OR attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         run_at = now() + make_interval(secs => GREATEST(p_reintentar_en_s, 0)),
         finished_at = CASE WHEN p_definitivo OR attempts >= max_attempts THEN now() ELSE NULL END,
         locked_until = NULL,
         last_error = left(p_error, 2000)
   WHERE id = p_id AND status = 'running' AND locked_by = p_worker
  RETURNING status INTO v_estado;
  RETURN v_estado;
END;
$$;

-- ── Sweep: expired leases and retention of finished jobs ───────────────────
-- Returns how many orphaned jobs it recovered (pending) or buried (dead).
CREATE OR REPLACE FUNCTION kitsuden_cola_barrer(p_retencion_dias integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_huerfanos integer;
BEGIN
  WITH vencidos AS (
    SELECT id FROM kitsuden_outbox
     WHERE status = 'running' AND locked_until < now()
     FOR UPDATE SKIP LOCKED
  )
  UPDATE kitsuden_outbox o
     SET status = CASE WHEN o.attempts >= o.max_attempts THEN 'dead' ELSE 'pending' END,
         finished_at = CASE WHEN o.attempts >= o.max_attempts THEN now() ELSE NULL END,
         run_at = now(),
         locked_until = NULL,
         last_error = 'lease_expired: el worker no cerró el trabajo a tiempo'
    FROM vencidos
   WHERE o.id = vencidos.id;
  GET DIAGNOSTICS v_huerfanos = ROW_COUNT;

  DELETE FROM kitsuden_outbox
   WHERE status = 'done' AND finished_at < now() - make_interval(days => GREATEST(p_retencion_dias, 0));

  RETURN v_huerfanos;
END;
$$;

-- ── Panel: count per queue and state ───────────────────────────────────────
CREATE OR REPLACE FUNCTION kitsuden_cola_estado()
RETURNS TABLE (queue text, status text, total bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT o.queue, o.status, count(*) FROM kitsuden_outbox o GROUP BY o.queue, o.status;
END;
$$;

-- ── Panel: the "dead letter", without payload (it may carry personal data) ─
CREATE OR REPLACE FUNCTION kitsuden_cola_muertos(p_limite integer)
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
   LIMIT LEAST(GREATEST(p_limite, 1), 500);
END;
$$;

-- ── Panel: retry a dead job (attempts back to zero) ────────────────────────
CREATE OR REPLACE FUNCTION kitsuden_cola_reintentar(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE kitsuden_outbox
     SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL, last_error = NULL
   WHERE id = p_id AND status = 'dead';
  RETURN FOUND;
END;
$$;

-- ── Panel: discard a dead job ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION kitsuden_cola_descartar(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM kitsuden_outbox WHERE id = p_id AND status = 'dead';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_cola_reclamar(text[], integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_completar(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_fallar(uuid, text, text, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_barrer(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_estado() FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_muertos(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_reintentar(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION kitsuden_cola_descartar(uuid) FROM PUBLIC;

-- Application role permissions: INSERT on the table and nothing more; the rest,
-- through the functions. (Same pattern as 0046/0047/0048.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    REVOKE ALL ON kitsuden_outbox FROM kitsuden_app;
    GRANT INSERT ON kitsuden_outbox TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_reclamar(text[], integer, integer, text) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_completar(uuid, text) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_fallar(uuid, text, text, integer, boolean) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_barrer(integer) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_estado() TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_muertos(integer) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_reintentar(uuid) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_cola_descartar(uuid) TO kitsuden_app;
  END IF;
END $$;
