-- 0087 — Approvals bound to the exact operation; Pushed Authorization Requests
-- ============================================================================
-- 1. Binding (docs/agents/approvals.md, "Binding"; lib/operation-hash.ts).
--    Nothing tied what a human saw in the inbox to what ran when they approved:
--    a row changed in between (database access, a bug, a race) executed what it
--    held by then. Now:
--
--      agent_proposals.operation_hash           sha256 of the canonical
--                                               operation (channel, method, path,
--                                               type, body, tool, operation key,
--                                               held files), set when stored.
--      agent_proposals.approved_operation_hash  the hash the approver sent with
--                                               the approval (what they saw).
--      agent_proposals.approval_mac             HMAC-SHA256 over id, hash,
--                                               approver, time and per-field
--                                               decisions, with a subkey of
--                                               KITSUDEN_SECRETS_KEY.
--
--    Before executing, the hash is recomputed from the row and the MAC checked;
--    a mismatch fails the proposal without running it. Rows stored before this
--    migration keep `operation_hash` NULL ("legacy") and run as before.
--
-- 2. RFC 9126 for the MCP OAuth server (docs/agents/oauth.md, "PAR").
--    A pushed request is an `oauth_authorization_requests` row created by
--    POST /api/oauth/par with the hash of its `request_uri`; /authorize redeems
--    it once (`pushed_used_at`). `oauth_clients.require_pushed_authorization_requests`
--    is the per-client switch of RFC 9126 §6. No new table: the RLS of both
--    tables (rls-system-only.sql) already covers the new columns.

ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS operation_hash text;
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS approved_operation_hash text;
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS approval_mac text;

ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS require_pushed_authorization_requests boolean NOT NULL DEFAULT false;

ALTER TABLE oauth_authorization_requests ADD COLUMN IF NOT EXISTS request_uri_hash text;
ALTER TABLE oauth_authorization_requests ADD COLUMN IF NOT EXISTS pushed_used_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS oauth_authorization_requests_request_uri_idx
  ON oauth_authorization_requests (request_uri_hash);
