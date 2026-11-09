# Agent memory (the brain)

The brain is where agents (and the team) keep what they learn across
sessions: **notes**, **connections** between notes, and **claims** — statements
tied to the evidence they came from. It is reachable over
**MCP** and REST from one declaration (kon SDK operations, `kon-brain`), every
note has an **owner**, and Postgres Row-Level Security decides who sees what.

## Contents

- [Tools and routes](#tools-and-routes)
- [Scopes](#scopes)
- [Owner and visibility](#owner-and-visibility)
- [Idempotent writes](#idempotent-writes)
- [Embeddings: lexical by default](#embeddings-lexical-by-default)
- [Connections and provenance](#connections-and-provenance)
- [Claims with evidence](#claims-with-evidence)
- [Export to Open Knowledge Format v0.2](#export-to-open-knowledge-format-v02)
- [Importing a graphify graph](#importing-a-graphify-graph)
- [Migration 0051](#migration-0051)
- [Legacy routes](#legacy-routes)

## Tools and routes

All under `/api/brain/memory`, published in `GET /api/docs/openapi.json`
(tag `kon-brain`) and as MCP tools with the same schemas:

| MCP tool                | REST                         | What it does                                                     |
| ----------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `brain_search`          | `GET /search?q=`             | Nearest notes you can see (score + embedding kind)               |
| `brain_list`            | `GET /notes`                 | Notes you can see; `mine=true`, `visibility`, `tag`, `keyPrefix` |
| `brain_read`            | `GET /notes/:id`             | One note with its connections and claims                         |
| `brain_connections`     | `GET /notes/:id/connections` | Its connections, with `origin` and `confidence`                  |
| `brain_claims`          | `GET /claims`                | Claims of the notes you can see; `status=stale`                  |
| `brain_export_okf`      | `GET /export/okf`            | OKF v0.2 bundle (`files[]`)                                      |
| `brain_note_write`      | `PUT /notes`                 | Create/update **your** note by `key`                             |
| `brain_note_delete`     | `DELETE /notes/:id`          | Delete your note (sensitive: may become a proposal)              |
| `brain_connect`         | `POST /connections`          | Connect two notes you can see                                    |
| `brain_claim_add`       | `POST /claims`               | Tie a statement of your note to a source                         |
| `brain_claim_verify`    | `POST /claims/:id/verify`    | Re-check a claim; `rebind` to a newer source                     |
| `brain_lint`            | `POST /lint`                 | Re-check every claim you can see; store fresh/stale              |
| `brain_import_graphify` | `POST /import/graphify`      | Load a graphify `graph.json`                                     |

## Scopes

- `brain:read` — the read tools.
- `brain:write` — everything (reads included).
- Also, as for any SDK operation: `brain:*`, `kon:brain:<operation>`
  (`kon:brain:search`, `kon:brain:write-note`…), `kon:*`, `admin`, and
  denies (`!kon:brain:delete-note`).
- People: admin and editor (the staff route gate). The rest of `/api/brain`
  (scan, sync, capture, graph…) stays admin only.

Without a brain scope the tools are not listed, and calling one answers
`KITSUDEN_E_FORBIDDEN`.

## Owner and visibility

Every note written through these operations has an owner:

| Written by                  | `owner.agentId` | `owner.userId`                          | `owner.sponsorUserId`              |
| --------------------------- | --------------- | --------------------------------------- | ---------------------------------- |
| an agent                    | the agent       | —                                       | the agent's human signer, if valid |
| a person                    | —               | the person                              | —                                  |
| the scanner / legacy routes | —               | (the admin, on `POST /api/brain/notes`) | —                                  |

`visibility` is `private` (default) or `shared`.

| Who                             | Reads                                                 | Writes / deletes |
| ------------------------------- | ----------------------------------------------------- | ---------------- |
| the owner                       | its notes                                             | its notes        |
| the agent's signer              | the agent's notes                                     | —                |
| team (editor) and other agents  | `shared` notes                                        | — (403)          |
| admin (a person)                | everything                                            | everything       |
| an agent with the `admin` scope | its own + `shared` (it is still role `agent` for RLS) | its own          |
| anonymous / plain accounts      | nothing                                               | nothing          |

The rule lives in Postgres (`apps/api/src/db/rls-owned-tables.sql`, section
«Agent memory», tables `brain_notes`, `brain_connections`, `brain_claims`, all
with `FORCE ROW LEVEL SECURITY`) and the same rule is applied in the queries
(`visibleTo` in `packages/engine/src/brain/memory.ts`), so the isolation also
holds on a connection that bypasses RLS. Something you cannot see is a `404`,
never "exists but forbidden"; a visible note you do not own is a `403`.

A connection is visible only when **both** notes are; a claim only when its
note is.

## Idempotent writes

- `brain_note_write` is a `PUT` addressed by **your** `key`
  (`project-x/decisions/db`): the same key updates the same note, and the same
  content again changes nothing (`outcome: "unchanged"`, no write). Keys are
  per owner: another agent's `project-x/...` is another note.
- `brain_connect` is idempotent by (source, target, relationType).
- `brain_claim_add` is idempotent by (note, statement, source SHA-256).
- `brain_import_graphify` is idempotent by node key (`graphify:<namespace>:<node id>`).
- `brain_claim_verify` and `brain_lint` store a verdict; repeating them is safe.

Only `brain_note_delete` is sensitive by default (DELETE). An agent in
"propose" mode gets `202` with a proposal id instead of the deletion.

## Embeddings: lexical by default

The built-in provider is a **term-frequency hash** (384 buckets of words and
3-letter fragments). It is **lexical, not semantic**: two notes are close when
they share words; "car" and "automobile" are unrelated to it. It is free,
offline and deterministic. Every search response says so:

```json
"embedding": { "kind": "lexical-hash-384", "mode": "lexical", "dimensions": 384 }
```

A semantic provider is opt-in. Nothing paid is ever the default:

```bash
KITSUDEN_BRAIN_EMBEDDINGS=http                      # default: lexical
KITSUDEN_BRAIN_EMBEDDINGS_URL=http://localhost:11434/v1   # any OpenAI-compatible /embeddings
KITSUDEN_BRAIN_EMBEDDINGS_MODEL=nomic-embed-text
KITSUDEN_BRAIN_EMBEDDINGS_API_KEY=                  # optional, sent as Bearer
KITSUDEN_BRAIN_EMBEDDINGS_DIMENSIONS=               # optional
```

Each note stores the `embedding_kind` that produced its vector, and search only
compares vectors of the **same** kind. After switching providers, notes are
found again once they are rewritten (or re-imported); old ones are simply not
compared. If the configured provider fails, the call fails: there is no silent
fallback that would change what the score means.

## Connections and provenance

A connection's `origin` says where it comes from, and its `confidence` how sure
it is (0–1):

| `origin`    | Meaning                                  | Who writes it                                                        |
| ----------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `EXTRACTED` | explicit in a source (an import, a link) | graphify `EXTRACTED` edges                                           |
| `INFERRED`  | similarity, or a model's guess           | the scanner, similarity suggestions, graphify `INFERRED`/`AMBIGUOUS` |
| `MANUAL`    | asserted by someone through the API      | `brain_connect` (default), `POST /api/brain/connections`             |

## Claims with evidence

A claim is a statement of a note plus its evidence: a Layer-1 source
(`brain_sources`, immutable and content-addressed), that source's **SHA-256**
when the claim was made, and an optional range (`{"unit":"line","start":2,"end":2}`
1-based inclusive, or `char` 0-based end-exclusive).

Sources never change ("a changed document is a new source"), so a claim
becomes **stale** when:

- a **newer** source with the same `uri` has another hash (capture each new
  version of a document with the same `uri`);
- its source was deleted;
- the recorded hash does not match the source row;
- its range no longer fits the source.

`brain_lint` (and the admin `GET /api/brain/lint`, which now includes
`staleClaims`) re-checks deterministically, without AI, and stores the verdict.
`brain_claim_verify` re-checks one claim; with `rebind: true` it moves the
claim to the newer source (you assert the statement still holds there) and
records `verifiedBy`/`verifiedAt`. Claim responses never include the source's
content.

Sources stay a shared, admin-curated corpus (no owner): a source captured by an
agent through `brain_claim_add` is readable by admins in `/api/brain/sources`,
not by other agents.

## Export to Open Knowledge Format v0.2

`brain_export_okf` returns `{ okfVersion: "0.2", files: [{ path, content }] }`
for the notes you can see. It follows the spec at
<https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>
(as read on 2026-10-28):

- `index.md` at the root with `okf_version: "0.2"`;
- one `notes/<key>.md` per note, YAML frontmatter with `type: "Brain Note"`,
  `title`, `tags`, `status` (`draft` if any claim is stale, else `stable`),
  `generated: { by, at }` (`agent:<id>` / `human:<id>`), `verified: [{ by, at }]`
  from verified claims, and `sources: [{ id, resource, title, last_modified }]`;
- claims listed in the body with footnotes `[^src-…]` whose label is the
  source's `id`, as the spec prescribes;
- our own keys are prefixed `kitsuden_` (the spec allows extra keys).

## Importing a graphify graph

[graphify](https://github.com/safishamsi/graphify) (Apache-2.0) writes
`graphify-out/graph.json`. Kitsuden has its **own** parser of that output
format (`packages/engine/src/brain/graphify.ts`); no graphify code is used.

```json
{ "namespace": "my-repo", "visibility": "private", "graph": { ...graph.json... } }
```

- Format: NetworkX node-link — `nodes[]` (`id`, `label`, `file_type`,
  `source_file`, `source_location`, `community_name`…) and `links[]`
  (`source`, `target`, `relation`, `confidence`, `confidence_score`…). The old
  `edges` key is accepted too.
- `graph.schema_version`: graphify's README says it is there "so integrations
  can detect incompatible format changes", but its **value is not documented**
  anywhere we could read, and the real graph.json files we had (July–October 2026) do not carry it. So: absent → read as the legacy format, with a
  warning; `1` (or `1.x`) → accepted; anything else → `422`, unless
  `allowUnknownSchemaVersion: true`. When graphify documents the value, update
  `SUPPORTED_GRAPHIFY_SCHEMA_VERSIONS`.
- Each node → a note of yours with key `graphify:<namespace>:<node id>`; each
  link → a connection with `origin` `EXTRACTED` or `INFERRED` and
  `confidence = confidence_score`. `AMBIGUOUS` → `INFERRED` with
  `metadata.ambiguous = true`; a legacy numeric `confidence` → `INFERRED` with
  that number. Links without `relation` or to unknown nodes are skipped (and
  counted in `warnings`); hyperedges are not imported.
- At most 5000 nodes and 20000 links, 25 MB per call.

## Migration 0051

`apps/api/src/db/migrations/0051_agent_memory.sql` (idempotent):

- `brain_notes`: `owner_user_id`, `owner_agent_id`, `sponsor_user_id`,
  `visibility` (`private|shared`, default `private`), `note_key` (unique per
  owner), `embedding_kind`. **Existing notes become `shared`** (they are the
  project knowledge the scanner wrote, and every caller used to see them) and
  their 384-dim vectors are labelled `lexical-hash-384`.
- `brain_connections`: `origin` and `confidence` (created with Spanish names;
  migration 0060 renamed them), plus owner columns. **Backfill:
  existing rows → `INFERRED` with `confidence = strength`**: scanner links and
  hand-made ones cannot be told apart, and claiming "extracted" without proof
  would be a lie.
- New table `brain_claims`, and an index on `brain_sources (uri, created_at)`.

The policies are applied after the migrations (`rls-owned-tables.sql`).

## Legacy routes

`routes/brain.ts` (scan, sync, capture, sources, graph, tree, lint, digest,
the old `/notes`) is unchanged and admin only. Those routes run as the system
(no RLS context), so they see every note. Notes they create have no owner and
are `shared`; the scanner never overwrites a note that has an owner agent or a
key.
