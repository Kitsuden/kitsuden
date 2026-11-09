-- 0032 — Polymorphic links between entities of any kon
-- ============================================================================
--
-- WHY
--
-- Until now all relationships were foreign keys WITHIN a kon. A
-- `crm_contacts.id`, a `players.id`, a `members.id` and a `dms` reader are
-- four rows with no way to say "they are the same person".
--
-- This table is the missing edge: any kon can relate its own things
-- to another's WITHOUT depending on it. A shop order is linked to a
-- CRM contact if the CRM is installed, and works the same if it is not.
--
-- WHAT IT IS NOT
--
-- It is not a graph model that replaces the tables. The tables remain
-- typed, with their foreign keys and their per-column RLS — which is exactly what
-- Kitsuden has and a generic model does not. The graph is added ON TOP.
--
-- ── THE TWO COSTS, AND HOW THEY ARE PAID ────────────────────────────────────
--
-- 1. NO FOREIGN KEYS. You cannot point with an FK at a polymorphic target:
--    Postgres does not know which table `to_type` points to. Deleting a contact leaves its
--    links dangling.
--
--    Chosen strategy: ORPHANS TOLERATED AND FILTERED ON READ. Resolving a
--    link goes through the target table; if the row is not there, the link
--    returns nothing and can be cleaned up later.
--
--    Putting delete triggers on every table was rejected: it would force the ~60
--    system tables to know that links exist, which is exactly the
--    coupling this table is meant to avoid. An orphan edge is garbage;
--    a trigger forgotten on a new table is a silent leak.
--
-- 2. RLS CANNOT FOLLOW THE EDGE. A policy here cannot know how to check whether
--    you can see `to_id` of an arbitrary `to_type` — it would have to query a
--    table whose name is only known at runtime.
--
--    Chosen strategy, in two layers:
--      · The table isolates by `owner_id`, like the rest (same policy,
--        same fail-open with an empty context for migrations and workers).
--      · And resolving the target ALWAYS goes through the normal RLS of its table. So
--        you see that an edge exists, but following it gives you nothing you could not
--        already see.
--
--    The conscious residue: whoever sees an edge learns that a related row of
--    that type EXISTS, even if they cannot read it. It is accepted because the
--    FROM side is already theirs — nothing is discovered about other people's entities.

CREATE TABLE IF NOT EXISTS kitsuden_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- TEXT and not UUID on purpose: not all entities in the system use UUID
  -- (agent identities are text). TEXT accepts both without casting.
  from_type   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_type     TEXT NOT NULL,
  to_id       TEXT NOT NULL,

  -- What the edge means. `related` serves for "this has to do with
  -- this"; proper names (`same_person`, `ordered_by`, `attends`) when the
  -- meaning matters for reading it later.
  relation    TEXT NOT NULL DEFAULT 'related',

  metadata    JSONB NOT NULL DEFAULT '{}',

  -- For the isolation policy. Nullable: links created by the
  -- system (imports, webhooks) have no owner.
  owner_id    TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A row linked to itself means nothing and pollutes every neighbor
  -- query.
  CONSTRAINT kitsuden_links_no_self CHECK (NOT (from_type = to_type AND from_id = to_id))
);

-- The same edge twice adds nothing and duplicates results when reading.
CREATE UNIQUE INDEX IF NOT EXISTS kitsuden_links_unique
  ON kitsuden_links (from_type, from_id, to_type, to_id, relation);

-- Both directions are indexed because reading queries BOTH: a relation
-- like `same_person` has no direction, and forcing kons to guess in which
-- direction it was stored would be an inexhaustible source of empty results.
CREATE INDEX IF NOT EXISTS kitsuden_links_from_idx ON kitsuden_links (from_type, from_id);
CREATE INDEX IF NOT EXISTS kitsuden_links_to_idx   ON kitsuden_links (to_type, to_id);

-- Looking up "all the orders of this contact" also filters by relation.
CREATE INDEX IF NOT EXISTS kitsuden_links_relation_idx ON kitsuden_links (relation);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Born protected: it is a new table, so there are no inherited databases to
-- break. FORCE is mandatory — without it the owner role (the app's) is
-- exempt and the policy is decorative.

ALTER TABLE kitsuden_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitsuden_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kitsuden_links_owner_isolation ON kitsuden_links;
CREATE POLICY kitsuden_links_owner_isolation ON kitsuden_links
  FOR ALL
  TO PUBLIC
  USING (
    -- Empty context = system process (migrations, seeds, workers).
    -- Same criterion as the rest of the project's policies.
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR owner_id IS NULL
    OR owner_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.current_user_id', true), '') = ''
    OR owner_id IS NULL
    OR owner_id = current_setting('app.current_user_id', true)
  );
