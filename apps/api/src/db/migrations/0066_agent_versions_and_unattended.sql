-- 0066 — Versioned agents, and what an unattended run does with a held write (2026-11-04)
-- ============================================================================
--
-- 1. VERSIONS. An agent's definition (system prompt, allowed tools,
--    capabilities, type) had no history, and a run did not say which
--    definition acted. Now:
--
--      agent_versions        one row per distinct definition of an agent,
--                            numbered 1, 2, 3… A new row only when the
--                            definition CHANGES (its hash differs from the
--                            latest), so saving the same form twice adds nothing.
--      agent_traces.agent_version_id
--                            the version that ran. A BEFORE INSERT trigger sets
--                            it on every trace, whichever code path inserts it,
--                            and snapshots the definition first if it changed
--                            through a path that did not record it.
--
--    `kitsuden_agent_snapshot(agent, created_by, source, note)` is the one
--    place that decides whether there is a new version: the API calls it after
--    each update (with who made it), the trigger with no author. Restoring an
--    old version writes its fields back to the agent and snapshots again:
--    history only grows.
--
--    `model` is NULL today: an agent has no model of its own (the server's
--    provider decides). The column is there for when it does.
--
-- 2. UNATTENDED. Per agent, what a request that would be held for approval
--    does when nobody is attending the run: `hold` (202, as before), `deny`
--    (403 KITSUDEN_E_DENIED_UNATTENDED with an alternative) or NULL (the global
--    setting, `approval_settings`). And the alternative text to answer with.
--    See packages/shared/src/approvals.ts and docs/agents/approvals.md.
--
-- Plain grants for the application role, like the other agent tables: the
-- admin routes read and write these rows; nothing here holds a secret beyond
-- what `agent_identities.system_prompt` already holds.

ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS unattended_approval text;
ALTER TABLE agent_identities ADD COLUMN IF NOT EXISTS unattended_alternative text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_unattended_approval_check'
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_unattended_approval_check
      CHECK (unattended_approval IS NULL OR unattended_approval IN ('hold', 'deny'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_identities_unattended_alternative_length'
  ) THEN
    ALTER TABLE agent_identities
      ADD CONSTRAINT agent_identities_unattended_alternative_length
      CHECK (unattended_alternative IS NULL OR length(unattended_alternative) <= 1000);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
  version integer NOT NULL,
  system_prompt text,
  model text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  hash text NOT NULL,
  -- `create`, `update`, `restore`, `baseline` (first seen) or `detected`
  -- (changed through a path that did not record it; found when a run started).
  source text NOT NULL,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_versions_number UNIQUE (agent_id, version),
  CONSTRAINT agent_versions_source CHECK (
    source IN ('create', 'update', 'restore', 'baseline', 'detected')
  )
);

CREATE INDEX IF NOT EXISTS agent_versions_agent_idx ON agent_versions (agent_id, version DESC);

ALTER TABLE agent_traces
  ADD COLUMN IF NOT EXISTS agent_version_id uuid REFERENCES agent_versions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_traces_agent_version_idx ON agent_traces (agent_version_id);

-- The definition of an agent as one canonical text, and its hash. jsonb
-- normalizes key order and spacing, so the same definition gives the same hash.
CREATE OR REPLACE FUNCTION kitsuden_agent_definition(p_agent_id text)
RETURNS TABLE (system_prompt text, model text, config jsonb, hash text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT a.system_prompt,
         NULL::text,
         d.config,
         encode(sha256(convert_to(
           coalesce(a.system_prompt, '') || chr(10) || '' || chr(10) || d.config::text, 'UTF8'
         )), 'hex')
    FROM agent_identities a
   CROSS JOIN LATERAL (
     SELECT jsonb_build_object(
       'type', a.type,
       'allowedTools', coalesce(a.allowed_tools, '[]'::jsonb),
       'capabilities', coalesce(a.capabilities, '[]'::jsonb)
     ) AS config
   ) d
   WHERE a.id = p_agent_id;
$$;

-- The agent's current version: the latest, or a new one if the definition
-- changed since. NULL if the agent does not exist.
CREATE OR REPLACE FUNCTION kitsuden_agent_snapshot(
  p_agent_id text, p_created_by text, p_source text, p_note text
)
RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  d record;
  latest agent_versions%ROWTYPE;
  new_id uuid;
BEGIN
  SELECT * INTO d FROM kitsuden_agent_definition(p_agent_id);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Two snapshots of the same agent at once must not take the same number.
  PERFORM pg_advisory_xact_lock(hashtext('kitsuden_agent_versions:' || p_agent_id));
  SELECT * INTO latest FROM agent_versions v
   WHERE v.agent_id = p_agent_id ORDER BY v.version DESC LIMIT 1;
  IF FOUND AND latest.hash = d.hash AND p_source <> 'restore' THEN
    RETURN latest.id;
  END IF;
  INSERT INTO agent_versions (agent_id, version, system_prompt, model, config, hash, source, note, created_by)
  VALUES (
    p_agent_id,
    coalesce(latest.version, 0) + 1,
    d.system_prompt,
    d.model,
    d.config,
    d.hash,
    CASE WHEN latest.id IS NULL AND p_source IN ('update', 'detected') THEN 'baseline' ELSE p_source END,
    p_note,
    p_created_by
  )
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- Every trace says which version ran, whoever inserts it.
CREATE OR REPLACE FUNCTION kitsuden_agent_traces_version()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.agent_version_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    NEW.agent_version_id := kitsuden_agent_snapshot(NEW.agent_id, NULL, 'detected', NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_traces_version ON agent_traces;
CREATE TRIGGER agent_traces_version
  BEFORE INSERT ON agent_traces
  FOR EACH ROW EXECUTE FUNCTION kitsuden_agent_traces_version();

-- Version 1 of every agent that exists now.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM agent_identities LOOP
    PERFORM kitsuden_agent_snapshot(r.id, NULL, 'baseline', NULL);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_versions TO kitsuden_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_identities TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_agent_definition(text) TO kitsuden_app;
    GRANT EXECUTE ON FUNCTION kitsuden_agent_snapshot(text, text, text, text) TO kitsuden_app;
  END IF;
END $$;
