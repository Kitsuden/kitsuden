-- Request traces, a page at a time.
--
-- kitsuden_traces_list (0060) takes a limit capped at 1000 and no offset: the panel
-- and GET /api/admin/requests could never see past the newest 1000 traces of the
-- window, with no sign that more existed. This function adds the offset and lets the
-- caller ask for one row past the page (up to 1001) to know whether there is more.
-- The old function stays for anything that still calls it.

CREATE OR REPLACE FUNCTION kitsuden_traces_page(
  p_since timestamptz, p_limit integer, p_offset integer,
  p_only_denials boolean, p_actor text, p_only_errors boolean
) RETURNS SETOF kitsuden_request_traces
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM kitsuden_request_traces t
   WHERE t.created_at >= p_since
     AND (NOT p_only_denials OR t.denials > 0)
     AND (NOT p_only_errors OR t.status >= 400)
     AND (p_actor IS NULL OR t.actor_id = p_actor)
   -- No id column (the table is partitioned by day): the request id breaks ties.
   ORDER BY t.created_at DESC, t.request_id DESC NULLS LAST
   LIMIT LEAST(GREATEST(p_limit, 1), 1001)
  OFFSET GREATEST(p_offset, 0);
END;
$$;

REVOKE ALL ON FUNCTION kitsuden_traces_page(timestamptz, integer, integer, boolean, text, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT EXECUTE ON FUNCTION kitsuden_traces_page(timestamptz, integer, integer, boolean, text, boolean) TO kitsuden_app;
  END IF;
END
$$;
