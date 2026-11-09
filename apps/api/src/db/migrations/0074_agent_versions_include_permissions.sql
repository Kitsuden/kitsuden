-- 0074 — An agent's version includes its permissions and MCP settings (2026-11-04)
-- ============================================================================
-- 0066 versioned the system prompt, allowed tools, capabilities and type. What
-- an agent may do (`scopes`) and how its MCP session behaves (`mcp_settings`:
-- toolset, untrusted-content wrapping) shape a run as much as the prompt, so a
-- version that left them out could not answer "what was this agent when it did
-- that", and restoring it brought back an old prompt with today's permissions.
--
-- Now both are part of the definition, so:
--   · changing them makes a new version (the hash changes), whichever path
--     changes them, and the version records them;
--   · restoring a version writes them back (lib/agent-versions.ts), except for
--     versions made before this migration, which did not record them: those
--     leave the current permissions as they are.
--
-- Every existing agent gets one new version now (`baseline`, with a note), so the
-- format change does not show up later as an unexplained `detected` version on
-- the next run.

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
       'capabilities', coalesce(a.capabilities, '[]'::jsonb),
       'scopes', coalesce(a.scopes, '[]'::jsonb),
       'mcpSettings', coalesce(a.mcp_settings, '{}'::jsonb)
     ) AS config
   ) d
   WHERE a.id = p_agent_id;
$$;

SELECT kitsuden_agent_snapshot(
         a.id, NULL, 'baseline', 'versions now include permissions and MCP settings'
       )
  FROM agent_identities a
 WHERE EXISTS (SELECT 1 FROM agent_versions v WHERE v.agent_id = a.id);
