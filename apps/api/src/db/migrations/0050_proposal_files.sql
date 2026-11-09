-- 0050 — Images held in a proposal
-- ============================================================================
-- Idempotent: IF NOT EXISTS on everything.
--
-- An agent that needs approval can now UPLOAD IMAGES (multipart): the
-- upload is saved as a proposal and its files wait here, NOT in the public
-- `/media` store, until a human decides.
--
-- Why a table and not a private prefix in the store? Because the core's store is
-- PUBLIC by design: on local disk `/media/*` serves everything under the
-- root, and on S3 the bucket usually sits behind `S3_PUBLIC_URL`. A "private"
-- prefix would depend on nobody configuring the bucket as public.
-- Here the bytes only leave through `GET /api/approvals/proposals/:id/files/:fileId`
-- (human staff), are stored in the same transaction as the proposal and are
-- deleted as soon as it is rejected, expires or is executed (and cascaded if it is deleted).
--
-- Only images verified by their signature (JPEG, PNG, GIF, WebP, AVIF; see
-- packages/core/media/real-type.ts) and with the media library's maximum size
-- (`APPROVALS_MAX_UPLOAD_MB`, 10 by default): the API checks it before
-- inserting. Without RLS, like agent_proposals (0048): only the API touches it.

CREATE TABLE IF NOT EXISTS agent_proposal_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES agent_proposals(id) ON DELETE CASCADE,
  -- Order within the form (to rebuild it identically on execution).
  position integer NOT NULL,
  field text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_proposal_files_proposal_idx ON agent_proposal_files (proposal_id, position);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kitsuden_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_proposal_files TO kitsuden_app;
  END IF;
END $$;
