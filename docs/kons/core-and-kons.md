# What is core and what is a kon

Kitsuden is a backend for AI agents. Its **core** is everything an agent
backend needs to be complete, secure and efficient on its own: the API, the
engine, authentication, agent identities and keys, fine-grained scopes, quotas,
human approval, MCP, TOON, Row-Level Security, datasets, media, the page
builder, the admin panel, `@kitsuden/shared`, the CLI and the **kon SDK**.

**Kons** are optional modules that add a domain on top of the core. They live in
their own repository, `kitsuden-kons` (MIT, not public yet), each with a
declared maturity, and are installed with `kitsuden kon add <name>`
([installing kons](installing.md)). The core does not depend on any of them: a
fresh clone of Kitsuden installs, builds and passes its tests with no kon
installed.

## The split

Rule used for every module: **does an agent backend need it to be complete, or
does the starter need it to render a site?** If yes, it is core. If it is a
domain (content type, vertical, game tooling), it is a kon.

### Core (`packages/core/`, always installed)

| Module                                    | Why it is core                                                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kon-datasets` (`packages/core/datasets`) | The generic data layer agents work on: dynamic collections with REST, MCP tools (`datasets:<slug>:read` scopes), RLS and calculated fields. Without it the core has no data model of its own.                               |
| `kon-media` (`packages/core/media`)       | Files are part of any backend: uploads, local/S3 storage, image presets. The media table is authoritative over the legacy core schema, and kons (blog, games…) reference it.                                                |
| `kon-blocks` (`packages/core/blocks`)     | The page builder. The starter renders its pages and Inti (the visual editing layer) edits them through its contract (`page-builder` in `GET /api/version`). Removing it would break the starter and every Inti integration. |
| `vector-search`, `content-publishing`     | Libraries used by the core (pgvector embeddings, the publishing registry kons plug into), not kons.                                                                                                                         |

The agent features themselves (identities, keys, scopes, quotas, approvals,
MCP, the operation SDK, OpenAPI) are not modules at all: they are part of
`apps/api`, `packages/engine` and `packages/shared`.

### Kons (repository `kitsuden-kons`)

| Kon                                                                                                                                                           | Why it is a kon, not core                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kon-blog`                                                                                                                                                    | A content type (posts, categories, SEO/GEO). Very common, but a backend for agents is complete without it; the starter shows the blog only when it is installed. It is the SDK pilot, which makes it the reference kon. |
| `kon-members`                                                                                                                                                 | Reader/customer identity without a CMS account. Audience feature, not agent infrastructure (agents have their own identities in the core).                                                                              |
| `kon-newsletter`                                                                                                                                              | Email campaigns for an audience: a business vertical.                                                                                                                                                                   |
| `kon-comments`                                                                                                                                                | Comments on content: depends on having content types.                                                                                                                                                                   |
| `kon-analytics`                                                                                                                                               | Views per subject and day for sites; the core has its own audit and observability.                                                                                                                                      |
| `kon-collection`                                                                                                                                              | What each reader owns of an index: a site feature.                                                                                                                                                                      |
| `kon-crm`, `kon-payments`, `kon-ecommerce`, `kon-conta`, `kon-booking`, `kon-directory`, `kon-dms`, `kon-agile`, `kon-academy-lms`                            | Business verticals (sales, payments, shop, accounting, bookings, directory, documents, projects, courses).                                                                                                              |
| `kon-games`, `kon-esports`, `kon-streamers`, `kon-broadcast`                                                                                                  | Gaming/esports verticals.                                                                                                                                                                                               |
| `kon-wiki`, `kon-tierlist`, `kon-maps`, `kon-formulas`, `kon-character-builder`, `kon-cardsim` (with its deck showcase and hand generator), `kon-autobattler` | Game tooling (wikis, tier lists, maps, formula engine, builders, card simulators).                                                                                                                                      |
| OCR bridge kons                                                                                                                                               | Bridges to an external OCR engine: heavy, niche infrastructure.                                                                                                                                                         |

Each kon's maturity (stable / beta / experimental) is in the README of the kons
repository, generated from its `kon.json`.

## What still ties the core to some kons (known, documented)

- **Legacy base migration.** `apps/api/drizzle/0000_*.sql` (2025) creates
  `blog_posts`, `games`, `streamers`, `platforms`, `tags`… because those were
  core tables before kons existed. Migration files are checksummed, so it is not
  edited: migration `0061` drops them when nobody uses them, and the kons create
  their own. Migration `0073` drops `data_sets.game_id`, the last link from a
  core table to games: a kon that links a dataset to something keeps that link
  in its own tables.
- **Panel views.** The panel still bundles the views of some kons (academy, blog,
  crm, conta, dms, games, newsletter, OCR, streamers). They appear only when
  the kon is installed. New third-party views are Web Components, served
  without a session from `/api/kons/<kon>/admin-asset/<path>`. Only what a
  declared view needs is served: the `src` of each `admin.views[]` entry and its
  `.map`, anything under that `src`'s directory when it is not the package root,
  and anything under `dist/admin/`. Other files in the package answer 404, so put
  a view's chunks next to it (`admin/`) or build them into `dist/admin/`.
- **Block vocabulary.** Block types and their stored keys (`title`, `description`,
  `cardGame`…) are stored JSON and part of the Inti contract, as are
  `GET /api/version` (`product`, `contracts`) and the games editorial routes. They became
  English in 0.9 (see `packages/shared/src/block-keys.ts`).
- **Host gates by prefix.** `ADMIN_ONLY_ROUTES` in `auth-guard.ts` and the
  authorization matrix still name some kon prefixes (`/api/crm`, `/api/blog`…).
  They are inert when the kon is not installed (no route is mounted there), and
  they keep the same protection when it is.
- **Core tests that use a kon as their example** (idempotency with
  `kon-ecommerce`, human approval with `kon-blog`, the Inti contract with
  `kon-games`) are skipped when that kon is not installed, and say so.
