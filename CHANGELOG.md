# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0-beta]

First public release. Kitsuden is a JS backend where a model is declared once and agents can use
it, with permissions, human approval and an audit trail. Everything below is new to the public
repository; [Upgrading from a pre-release build](#upgrading-from-a-pre-release-build-08) is only
for installs that ran an earlier, unpublished version.

The `v0.9.0-beta` tag and its GitHub release are pending: until they exist, the links at the end
of this file point at `main`, and nothing is published to npm, PyPI or a container registry.

### Added

**Core**

- `defineOperation` and `defineModel`: one declaration produces REST, OpenAPI, MCP and
  authorization, and `defineModel` also produces the table and migration.
- Row-level security on Postgres, checked by the API before it serves.
- Transactional job queue and outbox on Postgres; Valkey is optional.
- Code promotion pipeline with a sandbox, a scanner and automatic rollback.
- Agent memory, traces, signed webhooks and semantic search.
- `ctx.effect(key, fn)` in actions and `kitsuden.effect(key, fn)` in panel-defined code actions:
  an external effect (an email, a payment) runs at most once per key, even when the queue retries
  the job. Outgoing webhooks send an `Idempotency-Key` header.
- Migration folders can carry `history.json` (`renamed`, `previousChecksums`): a file renamed or
  reworded after being applied keeps its place in the history instead of running again or
  stopping the runner as drift.
- Point-in-time restore (`KITSUDEN_PITR=on`, `docker/pitr-restore.sh`), `docker-compose.replica.yml`
  and the high-availability guide.

**Agents**

- Agent identities with scoped keys, human approval and proposal mode, and audited actions. New
  agent keys expire after 90 days by default (`AGENT_KEY_DEFAULT_EXPIRY_DAYS`, `0` = never).
- MCP server at `/api/mcp`, OAuth 2.1 for MCP clients, and a standalone MCP server.
- Versioned agents: the version on every trace, and list, view and restore at
  `/api/v1/agents/:id/versions`. A version includes the agent's scopes and MCP settings.
- Agent data ledger: a proposal that writes a record can be approved field by field, with edited
  values (fields left out of a `fields` list are rejected); agents attach `_evidence` per field,
  kept in `field_evidence` and returned in `_provenance.fields`, whether the write was held or not.
- Agents record what they chose not to do (`kitsuden_record_decision`,
  `POST /api/agent/decisions`); admins and editors see it in Approvals → Discarded.
- Unattended runs (cron, events, HTTP triggers) can refuse a write that would be held, with
  `403 KITSUDEN_E_DENIED_UNATTENDED` and an `alternative`; `hold` stays the default.
- Queue jobs queued by an agent are charged to its daily budget (`QUEUE_AGENT_JOB_COST`); with
  the budget spent they are postponed or failed. Decisions can schedule a later review, which
  emails the person who scheduled it when mail is configured.
- External MCP servers: a human-only registry at `/api/admin/mcp-servers` fingerprints each tool
  and holds new or changed ones for review. Agents call approved tools as `ext_<server>_<tool>`
  with an explicit `mcp-external:<server>:<tool>` scope (`admin` does not grant it, a denial
  wins); every call is a write for approval and quota, re-checks the fingerprint, has capped
  output wrapped as untrusted, and is audited.
- The Anthropic provider sends assistant turns back unchanged, streams text, defaults to
  `claude-opus-5-5` and opts into the server-side refusal fallback where the model supports it
  (`ANTHROPIC_FALLBACKS=off` turns it off). The OpenAI provider streams too. A tool call whose
  arguments do not parse still gets a result, so the model learns what went wrong.

**Customer data**

- Fields marked `sensitivity: "customer" | "personal"` do not leave: they are refused in sandbox
  `fetch`, redacted in `webhook_out`, agent notifications and prompts to a model or embeddings
  provider that is not allowed for them, unless the host is allowed (`KITSUDEN_CUSTOMER_DATA_HOSTS`,
  `customerDataHosts`). The check recognises transformed copies (base64, base64url, hex, SHA-256,
  SHA-1 and MD5 digests, phone numbers reformatted to digits).
- In an engine run, the email tool refuses customer data for a recipient domain not allowed for
  it, except the customer whose address was read.

**Kons**

- Kons: optional modules installed with `kitsuden kon add`, with a signed registry. They live in
  [kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons); the core ships none of their code.
- `kitsuden make kon <name>` writes a kon that compiles, reads its version and tables from
  `kon.json`, and whose test runs behind the host's per-request row security. It works in a
  Kitsuden project, in a kons repository, and anywhere with `--standalone [dir]`. `make policy`,
  `make model`, `make request`, `make job` and `make test` work in a kons repository too (`--kon`).
- Row security in one line from a kon migration: `kitsuden_rls_team`, `kitsuden_rls_owned` and
  `kitsuden_rls_public_read` (`agent-functions.sql`). `actsAsUserIn(kon)` in `@kitsuden/engine`
  is the `actAsUser` rule of a kon policy.
- Kons can run the core's agents (`ctx.agents.run`, with the agent's model, scopes, approval and
  traces; `allowedTools` and `toolset` only narrow), use the configured embeddings provider
  (`ctx.ai.embed`), declare tool groups for agents (`mcpToolsets`, requested as `kon:<id>/<set>`),
  emit their own events for actions (`<kon>:<what>`) and announce a change only after its
  transaction commits (`afterCommit`).
- `kitsuden kon add --docker` writes `docker-compose.kons.yml` from `kitsuden.kons.json`.

**Install and clients**

- `install.sh` and `install.ps1`: one command to a running install, with generated secrets, free
  ports and the setup token on screen. `KITSUDEN_INSTANCE` prefixes containers, volumes and
  network, so two installs can share a machine.
- `npm create kitsuden` (the `create-kitsuden` package, not yet published).
- Admin panel, CLI, and TypeScript, React and Python clients. A kon's typed client comes from
  `node scripts/sdk/generate.mjs --from-url=<API>` or `--from-kon=<dir>`.
- Swift, Kotlin and Dart SDKs (datasets and entries, problem+json errors, idempotent writes).
  Their tests have not run yet.
- `docs/api-stability.md` (a draft) and `apps/api/scripts/rekey-secrets.ts`.

### Security defaults

- First-run setup requires a one-time token in production. Outside production the API listens on
  127.0.0.1; listening beyond loopback requires the setup token and closes sign-up unless
  `KITSUDEN_SIGNUP=open`.
- Registration is closed by default in production (`KITSUDEN_SIGNUP`).
- The API refuses to start in production with a placeholder secret, without
  `KITSUDEN_SECRETS_KEY`, or with a database role that bypasses row-level security.
- Two-factor sign-in (authenticator app, backup codes) and magic links, with
  `KITSUDEN_ADMIN_MFA=required` for admins.
- A demoted, deleted or revoked admin or editor session stops working at once on every route.
- Agents cannot create agents, change their scopes or issue their keys; they cannot change a code
  action's trigger or status, an action's customer-data hosts, or a field's customer-data mark. An
  editor cannot approve proposals of an agent they sponsor.
- Outbound calls (sandbox `fetch`, `webhook_out`, CIMD, agent notifications) connect only to the
  address they checked; `webhook_out` reaches only public addresses, does not follow redirects and
  caps its answer and retries (`KITSUDEN_WEBHOOK_ALLOW_INTERNAL` is the opt-in).
- GraphQL and `POST /api/datasets/query/:table` do not expose credential tables or columns holding
  a live secret.
- Panel CSP uses SvelteKit hashes, without `'unsafe-eval'` and with `connect-src 'self'`
  (`KITSUDEN_PANEL_CONNECT_SRC` adds hosts). Per-route body limits: media upload 201 MB, dataset
  import 100 MB (`DATASET_IMPORT_MAX_MB`).
- Error logs mask tokens in paths, MCP hides 5xx detail in production, backups are owner-only,
  passwords stay off command lines, and CI actions are pinned to SHAs.
- Security scanning on every push and pull request, and before every release: gitleaks,
  OSV-Scanner (fails on HIGH and CRITICAL), Checkov, CodeQL and Trivy on the four images.
  OWASP ZAP and OWASP Dependency-Check run weekly; GitGuardian and Snyk run when their key is
  set. Released images will carry an SBOM, SLSA provenance and a signed attestation (no image is
  published yet). The final image stages run `apk upgrade`. See `docs/security-scanning.md`.

### Changed

Since the repository opened, before the tag:

- The admin panel runs on Tailwind CSS 4: the theme lives in `@theme` in `src/style.css` (no
  `tailwind.config.js`), PostCSS uses `@tailwindcss/postcss`, and components that `@apply` in their
  `<style>` declare `@reference`. The runtime theme engine still repaints the panel through the
  `--kitsuden-*` variables.
- Bun 1.4.4 in the images and CI; Valkey 9.1.3 in the compose files and CI; pgvector 0.8.7,
  SeaweedFS 4.52, Caddy 2.11, nginx-unprivileged 1.31; hono 4.13.16, drizzle-orm 0.45.4,
  typescript-eslint 8.72.1; the GitHub Actions to their current majors.

### Fixed

- Code actions failed on Linux and in Docker: the sandbox launched `node` without a `PATH`.
- Runtime images no longer carry esbuild's Go binaries or the base image's npm.
- Operations with a path parameter declare their 404 in the OpenAPI and the generated clients.
- `docker-compose.yml` passes to the API every variable `.env.production.example` documents:
  `KITSUDEN_ADMIN_MFA`, `ENABLE_CODE_ACTIONS`, `KITSUDEN_SANDBOX_FETCH_ALLOW`,
  `KITSUDEN_WEBHOOK_ALLOW_INTERNAL`, `KITSUDEN_CUSTOMER_DATA_HOSTS`,
  `KITSUDEN_EXTERNAL_MCP_ALLOW_INTERNAL` and `PAYMENTS_ALLOWED_PLANS` never reached the container,
  so setting them in `.env` did nothing. It also passes the social sign-in variables
  (`GITHUB_*`, `GOOGLE_*`, `DISCORD_*`, `AZURE_AD_*`) and, to the database,
  `PG_MAX_SLOT_WAL_KEEP_SIZE`.
- `install.sh` stops at once, with the reason, on a machine without `curl`.
- `GET /api/brain/memory/export/okf` accepts at most 200 `noteIds` per call. The old cap
  (20,000 characters) was more than a URL can carry: the HTTP server answered an empty `431`
  before the API saw the request.

### Upgrading from a pre-release build (0.8)

Only for installs that ran an unpublished 0.8 build. A fresh install can skip this section.

**The block contract is English (breaking).** Block data keys, the editorial layer kon-games keeps
over a game's blocks, its routes and `GET /api/version` were Spanish. The `games` and
`games-editorial` contracts go from 1 to 2 (`page-builder` stays at 1). The full table lives in
`packages/shared/src/block-keys.ts`.

| Where                                          | 0.8                                                                                           | 0.9                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| any block's data                               | `titulo`, `subtitulo`, `descripcion`, `nota`                                                  | `title`, `subtitle`, `description`, `note`                                             |
| `comments`                                     | `orden` (`mejores`, `nuevos`, `antiguos`)                                                     | `order` (`best`, `newest`, `oldest`)                                                   |
| `dex`                                          | `segmento`, `campos`, `facetas`, `habilidades`, `rasgo`, `evolucion`, `noticias`              | `segment`, `fields`, `facets`, `skills`, `trait`, `evolution`, `news`                  |
| `affinity`                                     | `campos`, `etiquetas` (`progenitor`)                                                          | `fields`, `labels` (`parent`)                                                          |
| `event-search`, `race-planner`                 | `campos`                                                                                      | `fields`                                                                               |
| `card-browser`                                 | `juegoDeCartas`, `facetas`                                                                    | `cardGame`, `facets`                                                                   |
| `deck-builder`, `deck-showcase`                | `juegoDeCartas`                                                                               | `cardGame`                                                                             |
| `deck`                                         | `juego`, `arquetipo`, `mazo`, `vista` (`resumen`, `lista`)                                    | `game`, `archetype`, `deck`, `view` (`summary`, `list`)                                |
| inside `fields`                                | `clave`, `nombre`, `imagen`, `icono`, `numero`, `grupos`, `opciones`, `descripcion`, `fuente` | `key`, `name`, `image`, `icon`, `number`, `groups`, `options`, `description`, `source` |
| each `facets` / `chips` / `skills.groups` item | `campo`, `etiqueta`, `herramienta`                                                            | `field`, `label`, `tool`                                                               |
| `skills`, `trait`, `evolution`, `news`         | `campo`, `clave`, `nombre`, `imagen`, `icono`, `grupos`                                       | `field`, `key`, `name`, `image`, `icon`, `groups`                                      |
| game block `editorial`                         | `titulo`, `descripcion`, `oculto`, `orden`                                                    | `title`, `description`, `hidden`, `order`                                              |
| `GET /api/version`                             | `producto`, `contratos`                                                                       | `product`, `contracts`                                                                 |

Routes: `PATCH /api/games/:id/bloques/:bloqueId/editorial` → `PATCH /api/games/:id/blocks/:blockId/editorial`
and `PUT /api/games/:id/bloques/orden` → `PUT /api/games/:id/blocks/order`. Stored data is
migrated (`kon-blocks/0010_english_block_keys.sql`, kon-games and kon-blog
`*_english_block_keys.sql`); an object that has both names keeps the English value. Until 0.10 the
readers still accept a 0.8 key when the English one is absent; writes accept English only, and a
0.8 key is a 422 whose `hint` names the English key. Needs `@intijs/adapter-kitsuden` with
`games` v2.

**The rest of the core is English too.**

- Scopes (`content:edit`, `user:act`), JSON fields, enum values, the `x-kitsuden-site` and
  `x-kitsuden-client` headers, the `maturity` key in `kon.json`, and SQL tables, columns and
  functions (migration `0060` converts stored data; `0075` renames what it missed and drops the
  Spanish-named agent helper wrappers, so kon migrations must call the English names).
- `POST /api/datasets/:id/compare` answers `differences` (was `diferencias`).
- The injection classifier's queue is `kitsuden-injection-classifier` (was
  `kitsuden-clasificador`): drain the old queue before upgrading. Agent quota counters in Valkey
  use the `kitsuden:quota:` prefix and start from zero.
- Reason codes: `not-replayable` (was `no-repetible`), `not-deferred` (was `no-diferido`); the
  RBAC action label is `administer`.
- Core migrations 0036–0059 and the blocks module's 0002–0009 have English file names; their
  `history.json` maps them to the old ones, so they do not run again.
- `docker/sql/change-media-domain.sql` takes `-v domain=` (was `-v dominio=`).

**Removed.**

- Kon code from the core: the generated kon SDK, tournament and tier list MCP tools, React hooks
  and the Viggo grimoire moved to the kons repository, and so did kon routes in the authorization
  matrix. A fresh install no longer creates blog and games tables (migration `0061`).
- The `create-kon` and `kon:create` aliases (use `kitsuden make kon`) and the `create-kitsuden`
  command inside `@kitsuden/cli` (it is the `create-kitsuden` package now, `npm create kitsuden`
  once that is published; `kitsuden init` stays).
- `data_sets.game_id` (migration 0073) and `gameId` from the dataset API, schema and SDKs; a
  `gameId` sent by old clients is ignored.
- `rlsContextMiddleware`, `withRLSQuery`, `withRLSContextOnly`, `withAdminRLS` and
  `lib/agent-rls.ts` (unused, unsafe semantics).
- The `/api/sistema` routes (use `/api/system`), the Spanish environment variable names and the
  old model vocabulary (`modelos.snapshot.json`, `*.modelo.ts`).

**Behaviour an existing install notices.**

- The database container starts through `docker/postgres-entrypoint.sh` (the next
  `docker compose up -d` recreates it); nothing changes unless `KITSUDEN_PITR=on`.
- `DDL_DB_PASSWORD`: compose builds `DATABASE_DDL_URL` from it, so kons can be enabled from the
  panel.
- `docker-compose.dev.yml` names its containers, volumes and network after `KITSUDEN_INSTANCE`
  (default `kitsuden`, so existing setups keep their names and data).
- The app role is created before migrating. It used to be created after, so migrations 0056 and
  0057 skipped their grants and background jobs never ran.

<!-- Tag pending. When v0.9.0-beta exists, these become
     .../compare/v0.9.0-beta...HEAD and .../releases/tag/v0.9.0-beta. -->

[Unreleased]: https://github.com/Kitsuden/kitsuden/commits/main
[0.9.0-beta]: https://github.com/Kitsuden/kitsuden/tree/main
