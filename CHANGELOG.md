# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A separate bucket for private files** (`S3_PRIVATE_BUCKET`, [docs/kons/storage.md](docs/kons/storage.md)):
  with it set, every `private/…` key is written, read, listed, signed and deleted in a bucket with no public
  access, chosen by the same normalized `isPrivateKey` check that decides when an address is signed, and
  `S3_BUCKET` holds only public files (a Cloudflare R2 bucket with a custom domain, say). No per-prefix
  policy left to get wrong. `GET /health` checks both buckets. Empty, nothing changes.
- `S3_PUBLIC_URL_STYLE=domain` builds public file addresses as `S3_PUBLIC_URL/<key>`, for a host that is the
  bucket (a Cloudflare R2 custom domain or `r2.dev` address, a CDN). The default `path`
  (`S3_PUBLIC_URL/<bucket>/<key>`) is unchanged. The address an upload returns and `ctx.storage.publicUrl`
  are now built by one function, so they cannot disagree.
- **Deprecating an operation** ([docs/api-contract.md](docs/api-contract.md#deprecation-policy)):
  `deprecated: { since, sunset, use? }` in `defineOperation` publishes `deprecated` + `x-sunset`
  (what oasdiff reads), sends `Deprecation`/`Sunset` headers (RFC 9745, RFC 8594) on every response,
  starts the MCP tool's description with the note, logs each call with its caller, and marks the
  generated clients (`@deprecated`, `DeprecationWarning`). A query parameter is deprecated with
  `.meta({ deprecated: true, "x-sunset": … })`.
- `unpaginated: "<why>"` in `defineOperation`: a list that returns its whole collection on purpose
  says so (`x-kitsuden-operation.unpaginated`). The contract rules for pagination and camelCase are
  now errors; the contract has none.
- The OpenAPI document carries `x-codeSamples` (the call with the TypeScript and Python clients,
  checked against them by a test) and `x-badges` (Public, Sensitive, Stream, Not an MCP tool), which
  Scalar and RapiDoc show. `GET /api/docs/operations?filter=` takes RapiDoc-style terms
  (`kon:media !deprecated /api/media/**`).
- `node scripts/docs-viewers.mjs --outdated` and a monthly workflow say when a pinned documentation
  viewer has a newer release.
- CORS exposes `Deprecation`, `Sunset`, `Retry-After` and `X-Has-More`: a browser on another origin could not
  read a deprecated operation's headers, when to retry after a 429, or whether a list that answers a bare
  array has more.
- **API console in the panel**: each enabled kon's card under Kons has an **API** button that opens
  RapiDoc's `<rapi-doc-mini>` in a side panel, to read and try one operation (or a tag) of that kon
  with the panel session. RapiDoc 12.0.0 is pinned like the other viewers and loaded only when the
  console opens. The panel fetches the kon's document itself and neutralises every description
  first: RapiDoc's own sanitizer lets `iframe srcdoc`, remote images and more through
  ([docs/api-contract.md](docs/api-contract.md#the-api-console-in-the-panel)).
- **Checks on the API contract** ([docs/api-contract.md](docs/api-contract.md)): `pnpm api:diff`
  (oasdiff) says what changed in `packages/sdk/openapi/kitsuden.openapi.json` against another revision
  and whether it breaks a client; `pnpm api:lint` (Spectral) applies Kitsuden's rules (operation ids,
  fine scopes, problem+json errors, Idempotency-Key, pagination). New CI job `api-contract`: the
  diff reports without failing, the rules fail the build. Neither tool is a dependency: oasdiff is a
  pinned binary checked by SHA-256, Spectral runs with npx at a pinned version.
- The typed-client generator builds a client for part of the API (`--include-kon`, `--exclude-kon`,
  `--include-path`, `--exclude-path`) and writes `kitsuden-lock.json` next to each client: the filters
  (kept between runs), the hash of the contract and of the generator. `pnpm sdk:check` now says why a
  client is stale.
- `/api/docs/modern` (Scalar) lists each kon as its own document, next to the whole API.
- **Sandbox egress policy**: code actions get `config.egress.rules` (allow/deny by host,
  `*.domain`, IP or CIDR, and TCP ports) on top of `fetchAllow`, under a platform layer the
  operator controls (`KITSUDEN_EGRESS_DENY_ALWAYS`, `_ALLOW_ALWAYS`, `_PORTS`, `_DEFAULT`, or a
  JSON file in `KITSUDEN_EGRESS_POLICY_FILE` that is re-read on change and fails closed). IP and
  CIDR rules are matched on the addresses the connection is pinned to. A draft that adds an allow
  or drops a deny waits for a human. See
  [docs/agents/sandbox.md](docs/agents/sandbox.md#egress-policy).
- **Credential vault for code actions**: `config.credentials` binds a stored secret to a host;
  the API adds it as a header to matching HTTPS requests after the egress and customer-data
  checks, so the code never sees the value, and an echoed value comes back redacted. Only a
  person sets it; a new version of such an action always waits for a human
  (`target_has_credentials`). See
  [docs/agents/sandbox.md](docs/agents/sandbox.md#credentials-the-code-never-sees-vault).
- **Optional OpenSandbox runtime** for Python and shell code actions
  (`config.runtime: "opensandbox:python" | "opensandbox:shell"`, `KITSUDEN_OPENSANDBOX_*`): one
  sandbox per run, no environment, deny-by-default network limited to hosts allowed for
  customer data, deleted afterwards. Changing the runtime needs a human (`runtime_changed`). See
  [docs/agents/sandbox.md](docs/agents/sandbox.md#opensandbox-runtime).
- **DPoP (RFC 9449) for agent credentials**: a person binds an agent key to a public key
  (`PUT /api/v1/agents/:id/keys/:keyId/dpop`) or requires proofs for an agent
  (`PUT /api/v1/agents/:id/dpop`); MCP OAuth tokens are bound when the token request carries a
  proof. Without the private key a leaked key or token is useless. Migration `0086`.
- **Short-lived agent tokens**: `POST /api/agent/token/exchange` trades a key for a
  `kitsuden_ast_*` token of minutes with a subset of its scopes and an optional path prefix; it
  cannot be exchanged again and dies with its parent key. Every in-process agent run gets its own
  credential, checked before each tool call and revoked at the end. See
  [docs/agents/dpop-and-short-tokens.md](docs/agents/dpop-and-short-tokens.md).
- **Approvals bound to the exact operation**: each proposal stores an `operationHash`; approving
  must send the hash the reviewer was shown (`409 KITSUDEN_E_APPROVAL_STALE` otherwise), the
  approval is signed, and the row is re-hashed right before it runs: a proposal changed after it
  was shown fails without running (`proposal_integrity_failed`). Migration `0087`. See
  [docs/agents/approvals.md](docs/agents/approvals.md#binding-what-you-approve-is-what-runs).
- **Pushed authorization requests (RFC 9126)** on the MCP OAuth server: `POST /api/oauth/par`,
  `request_uri` at `/authorize`, `OAUTH_REQUIRE_PAR` and the per-client
  `require_pushed_authorization_requests`. See
  [docs/agents/oauth.md](docs/agents/oauth.md#pushed-authorization-requests).
- **Tamper-evident agent audit log**: `agent_audit_logs` is a hash chain (gapless `seq`,
  `prev_hash`, `row_hash`, an HMAC per row) and append-only; retention prunes a prefix and leaves
  a checkpoint. Admins verify it with `GET /api/admin/audit/verify` or
  `bun run scripts/verify-audit.ts`, and the API logs the chain head daily to anchor elsewhere.
  Migration `0088`. See [docs/agents/audit-chain.md](docs/agents/audit-chain.md).
- **Container images pinned by digest**: every third-party image in the compose files and
  Dockerfiles is `name:tag@sha256:…` (guarded by `tests/unit/images-pinned-by-digest.test.ts`),
  and released images get a keyless cosign signature. See
  [docs/install/verify-images.md](docs/install/verify-images.md).

- **Job queue**: `queue.dispatch(…, { dedupeKey })` does not queue the same work twice. While a
  job with that key is pending or running on the queue, the dispatch answers that job's id with
  `deduplicated: true` (migration `0085`). A queue can open itself to automation rules
  (`queue.handle(name, fn, { rules: { label, description, payload } })`), and the new rule step
  `core:enqueue` queues a job there from an event, as the rule's author, with the payload and the
  key filled from the event. `GET /api/automation/catalog` lists those queues. See
  [docs/install/queue.md](docs/install/queue.md) and
  [docs/automation.md](docs/automation.md#queue-a-job).
- External MCP servers can be connected with **OAuth** as an alternative to the static auth
  header: `POST /api/admin/mcp-servers/:id/oauth/start` discovers the server's authorization
  server, registers a client (or takes a `clientId`) and answers the URL to open; the tokens are
  stored encrypted and refreshed when they are about to end. PKCE (S256) is required and every
  announced endpoint must be a public https address. No new service or setting. Migration `0084`.
  See [docs/agents/external-mcp.md](docs/agents/external-mcp.md#oauth).
- External MCP servers are read again on a schedule (`KITSUDEN_EXTERNAL_MCP_REFRESH_MINUTES`,
  default 360; `0` = off). A tool rewritten or removed after its review goes back to "needs
  review" and is written to the audit log (`external_mcp_tool_changed`, origin `sweep`) before an
  agent's call finds it. Before, a change was noticed only on a manual refresh or when a call
  failed. See [docs/agents/external-mcp.md](docs/agents/external-mcp.md).
- **Analytics in the core** ([docs/analytics.md](docs/analytics.md)): views per subject and day with no
  personal data, at `/api/analytics` as before. It was the kon `kon-analytics`; ids, routes, scopes and MCP
  tools are the same, and migration 0083 keeps the data of an installation that had the kon. An installed
  `kon-analytics` is no longer mounted (the loader says how to remove it). `hit` gets its per-IP limit
  (30 a minute) from the core limiter.
- **Realtime channels for kons** ([docs/kons/realtime.md](docs/kons/realtime.md)): a kon
  authorizes its own channels, `kon:<id>:<rest>`, with `ctx.realtime.channels(authorize)`. The
  authorizer runs on subscribe and on every session sweep, so revoked access stops within a
  minute; a kon channel without an authorizer is denied, admins included.
- **Connections** ([docs/connections.md](docs/connections.md)): accounts at other services, connected
  once and used by every kon through `ctx.connections`. Google and Microsoft 365 by OAuth (PKCE), and
  API key providers a kon registers; per person or for the organization. Credentials are sealed with
  the installation's secrets key, refreshed before they expire, revocable, and every opening is in
  `secret_access_log` with the kon that asked. A kon gets a client that sends the credential only to
  the provider's hosts and never shows it. Row security (migration 0082) and the routes keep each
  person's connections theirs, admins included. Events `connections:connection.created|expired|revoked`.

- **Automation rules** ([docs/automation.md](docs/automation.md)): a stored action of type `rule`
  runs a list of steps (`core:webhook`, `core:send-mail`, `core:run-agent`, or a step a kon
  contributes with `defineKon({ actionHandlers })`) when the trigger's conditions over the event
  payload are met. `POST /api/automation/actions/:id/dry-run` says what would happen without doing it, and
  `GET /api/automation/catalog` lists the events and steps available. Conditions work on every type
  of action. Kons keep their own rules with `ctx.automation`.
- **Kon events contract** ([docs/kons/events.md](docs/kons/events.md)): the name format, what
  delivery guarantees, and `defineKon({ events })` to declare what a kon emits and listens to.
- **Link relations** ([docs/kons/links.md](docs/kons/links.md)): `related`, `same_person`,
  `ordered_by`, `paid_by` and `about` in `LINK_RELATIONS`, each with its direction.
- **Reports** ([docs/reports.md](docs/reports.md)): `POST /api/reports/aggregate` computes count,
  sum, avg, min and max, grouped and filtered, over tables kons declare and over datasets, as
  whoever asks; saved reports, reports shipped by kons (`defineKon({ reports })`) and dashboards.
  MCP tools `reports_aggregate`, `reports_list` and `reports_run`; scopes `reports:read` and
  `reports:write`.
- **Sealed secrets for kons** ([docs/kons/secrets.md](docs/kons/secrets.md)): `ctx.secrets` encrypts
  a credential with the installation's secrets key, bound to the kon, and records every opening
  in `secret_access_log` (`GET /api/admin/secret-access`).
- **Kon entities** ([docs/kons/entities.md](docs/kons/entities.md)): `defineKon({ entities })`
  creates datasets the kon owns at load, with no migration; `ctx.entities` reads and writes their
  records, validated against the declared fields.
- Core migrations `0077_action_rules`, `0078_kon_secrets`, `0079_reports`,
  `0080_kon_entities` and `0081_try_timestamptz`.
- Hot activation of a kon now registers what it declares (events, steps, reports, entities, secret
  columns), like startup does. It used to skip it.
- Page builder: `POST /api/page-builder/pages/:id/publish-draft` publishes a draft (a page made
  with `clone`) onto its page in one transaction. It replaces the shown blocks, keeps hidden and
  scheduled ones, copies title, description and SEO fields, and deletes the draft. Contract
  `page-builder-publish: 1`.
- Page builder: `PATCH /blocks/:id` accepts `contentPatch: [{ path, value }]` to change single
  content fields, and `If-Match` (or `expectedUpdatedAt`) to refuse a write over a newer version
  with 409 and the current block. Contract `page-builder-patch: 1`.
- Page builder: `GET /pages/:id` sends `ETag` and `Last-Modified` and answers `If-None-Match` with 304.
- Page builder: events `page:updated` and `page:deleted` (`{ id, slug }`), after commit, so an
  action or a webhook can purge a site cache.
- MCP discovery mode: an agent that chose no toolset and whose `tools/list` would exceed
  `MCP_TOOLS_LIST_MAX_BYTES` (64000, `0` = off) gets `kitsuden_find_tools` and
  `kitsuden_call_tool` instead of every definition (4 tools, 2.9 KB, where the same install
  listed 90 tools, 87 KB). The inner tool goes through the same scope, quota and approval checks.
  `?toolset=` or a panel preset keeps the direct list. `tools/list` is sorted by name.
- MCP: `MCP_RESULT_MAX_CHARS` (100000, `0` = off) cuts a longer tool result and says so in the text
  and in `_meta["kitsuden/truncated"]`.
- MCP: `kitsuden_query_collection` and `kitsuden_query_dataset` accept `fields`.
- `GET /llms.txt` is an index; `?kon=<id>` returns one kon's routes and `?full=1` the whole
  guide. It sends an `ETag` and answers 304, and has a "Building something new" section and
  generic recipes. `kitsuden_guide` takes an optional `kon`.
- CLI: `kitsuden make kon <name> --fields "title:string!,price:number"` generates the schema,
  migration, routes, docs and tests with those fields.
- `apps/api/scripts/bench-agent-tokens.ts` and
  [benchmarks.md §4](docs/agents/benchmarks.md#4-agent-context-tokens-per-call): the tokens an
  agent reads per call, before and after.

### Deprecated

- `include_blocks` on `GET /api/page-builder/pages/:id`: use `includeBlocks`. It keeps working until
  2027-05-18 (`x-sunset`). In Python, `get_page(include_blocks=…)` already sends the new name.

### Fixed

- `GET /api/docs/operations` listed only hand-written `openApi.paths`, which no kon declares, so it
  was empty for every operation declared with `defineOperation` (the Postman export too). It now lists
  the routes each kon serves, with `sdk` and `deprecated` on each row.
- A recursive zod schema (kon-dc's blueprints) was published with `$ref`s to a `#/$defs` that does
  not exist at the root of the OpenAPI document: Scalar and client generators saw broken references.
  They now point to where the schema lives.
- Three lists stopped at a cap with no sign: `GET /api/connections/connections` (200), the saved
  reports (500) and the dashboards (200). They take `limit` and `offset` (the default is the old
  cap, so a client that sent nothing gets the same) and answer `hasMore`.
- Five lists took a `limit` and nothing to reach the next page, so rows past it were unreachable:
  `GET /api/datasets`, `GET /api/datasets/:id/entries` (500 entries by default), the request traces
  (`GET /api/admin/requests`), the secret-access log and the brain's claims. They take `offset` and
  answer `hasMore`. `GET /api/datasets` also cut 50 rows before filtering by permission, so a reader
  who could not see some datasets got fewer than `limit` while more existed: it now filters, then pages.
  The traces database function capped at 1000 rows with no offset; migration `0089` adds
  `kitsuden_traces_page`. The contract rule for lists now asks for a way to the next page, not only a
  page size.
- The signer an admin picks for an agent (`/api/v1/agents/:id/sponsor`) came from a list cut at 500
  admins and editors by name, with no sign: past that, the agent's current signer could be missing from
  its own choices. The current signer is always listed now, and `candidatesTruncated` says the list was cut.
- The contract declared `403 KITSUDEN_E_FORBIDDEN` only on operations with a `permission`, but a
  denial in an agent key's scopes answers 403 on any operation, public ones included. 34 operations
  (analytics, connections, datasets, media, page builder, proposals) now declare it; the typed
  clients were regenerated.
- Contract testing: the Schemathesis runner ends every `$` of the spec it tests in `$(?!\n)`.
  The generator read `$` the Python way (also before a final newline), threw away about a third
  of the values of each `^…$` pattern, and an operation with several patterned fields failed
  the `filter_too_much` health check (seen on Python 3.14). The published OpenAPI is unchanged.
- `ctx.realtime.broadcast` delivered every message twice to the sockets of the replica that sent
  it once the bus was listening (once locally, once looping back through Valkey). It now goes
  through the bus only. `ctx.realtime.sendToUser` reached only the sockets of the same process;
  it now travels on the bus and reaches every replica.
- The realtime WebSocket refused pages the API serves itself (an `Origin` equal to the request's host)
  unless that origin was listed in `ALLOWED_ORIGINS`. Same-origin is now allowed; other sites still
  need the list.
- A kon's public embed scripts (`/api/<kon>/public/…/*.js`, the kon-chat and kon-koe widgets) were
  served with `Cross-Origin-Resource-Policy: same-origin`, so a plain `<script src>` on another site
  was blocked. They are now `cross-origin`, like `/media`.
- The admin icon map gains `MessagesSquare` (kon-koe). `/api/koe/media` sets its own body limit for
  WhatsApp video and documents.
- Lite mode now logs a statement that has waited 10 s for PGlite's only connection, with the stack that
  started it, instead of the API hanging in silence (`watchLiteConnection`).
- Lite mode (PGlite, one connection) wedged the whole database when a kon route or queue job opened a
  sealed secret, or when a site admin or editor called a kon route: the secret access log and the
  fresh session read used another connection while the request transaction held the only one. In lite
  mode both now go through the request (Postgres is unchanged).
- `createTestKonContext` silently dropped `secrets`, `automation` and `entities` overrides, so a kon
  under test took the "host without it" branch.
- A stored action listening to `entry.created`, `entry.updated`, `entry.deleted` or
  `post.published` ran twice for each event: the legacy function dispatcher subscribed to the
  same events as the actions engine.
- `rekey-secrets.ts` did not re-encrypt `external_mcp_servers.auth_header_value`; after a key
  rotation those headers no longer decrypted.
- Page builder: `clone` and `duplicate` keep `visibleFrom` and `visibleUntil`. A scheduled block
  was public at once in the copy, and publishing the copy duplicated it.
- Page builder: creating, editing, moving, duplicating or deleting a block moves the page's
  `updatedAt`, so the sitemap `lastmod` follows block edits.
- Page builder: `GET /block-types` lists every type the API saves (36), not only the 12 it
  describes. The others carry `described: false` and an empty `schema`.
- Rate limiter: a site that signs its requests with the 0.8 names (`x-kitsuden-sitio`,
  `x-kitsuden-cliente`, variable `SITIO_API_CLAVE`) is counted per visitor again. The rename had
  left the fallback reading the new header twice, so those sites shared one bucket.
- Admin panel: «New game» opens the create form (`?create=1`); its link pointed at a parameter
  nothing read. The «New …» button uses the kon's `singularName`, or a safe singular, instead of
  trimming an «s» off the table label.
- `sdk:check` and `sdk:openapi` leave out kons installed locally from kitsuden-kons whose
  operations are not in the core snapshot (`--with-local-kons` brings them in). With kons
  installed, `--check` failed and a plain write pulled them into the core SDK.
- Core guards that read installed kons follow their current code (English names, Svelte
  `admin-src` sources, the rebuilt panel) and accept a partial install; they failed whenever
  kons were installed locally.

### Security

- The API documentation viewers (`/api/docs`, `/api/docs/modern`) loaded their code from jsDelivr
  with no pinned version, on pages where people paste tokens. The API now serves pinned copies
  itself, downloaded and verified by `scripts/docs-viewers.mjs` (npm tarball integrity, then SRI per
  file), with a nonce-based CSP that allows connections only to the API. Scalar's telemetry, font
  CDN, AI agent and MCP generator are off. `@hono/swagger-ui` is no longer a dependency, and
  `/api/docs-legacy/modern` (another unpinned Scalar page) is gone; `/api/docs-legacy` redirects to
  `/api/docs`.
- Files a kon stores were readable by anyone holding their address: `ctx.storage.getSignedDownloadUrl`
  returned the public URL for every key, on local disk and on S3. Keys under `private/` are now served only
  through a short-lived signed address (an HMAC on local disk, a presigned GET on S3); `/media/private/…`
  without a valid signature answers 404. See [docs/kons/storage.md](docs/kons/storage.md).

- Rate limiter: the site key is compared in constant time over buffers padded to one length,
  with no hash in between. A bare SHA-256 and then an HMAC of it were both flagged by CodeQL
  as a password hashed insecurely (`js/insufficient-password-hash`).
- Dependencies: every open osv-scanner alert is closed.
  - `@hono/node-server` 2.1.8 everywhere, including the copy used by the MCP SDK.
  - `astro` 7.4.12 and `@astrojs/node` 11.1.13 in the starter.
  - `esbuild` 0.28.2 and `minimatch` 11 through overrides.
- Dependencies: `deepmerge` has no release that fixes GHSA-gcqx-w48m-w2h4 (prototype poisoning).
  The repository keeps a fixed copy in `packages/deepmerge`, and a pnpm override points every
  `deepmerge` at it.

### Changed

- `agent_audit_logs` is append-only (migration `0088`): `UPDATE`, `DELETE` and `TRUNCATE` are
  refused except by the retention function, and deleting an agent no longer deletes its audit
  rows (the foreign key is gone). Scripts or tests that deleted audit rows must stop doing so.
- The promotion contract has two new fallback reasons, `target_has_credentials` and
  `runtime_changed`, and `new_outbound_hosts` also covers `egress` rules.

- `link()` refuses a relation that is not lower case letters, digits and `_`, and stores a
  relation with no direction (`related`, `same_person`) with its ends in a fixed order, so
  writing it from both sides gives one row. Links written before this are not rewritten.
- Admin panel: SvelteKit 3, Vite 8 and `@sveltejs/vite-plugin-svelte` 7, which closes the two
  SvelteKit 2 advisories (an open redirect in `use:enhance`, and XSS through `cache-control` in
  prerendered pages).
  - The configuration moved from `svelte.config.js`, which SvelteKit 3 refuses, to `kit.config.js`,
    passed to `sveltekit()`.
  - `page` comes from `$app/state`.
  - Tailwind runs as a Vite plugin.
  - Two stale compiled `vite.config.js` and `vitest.config.js` files are gone. The first one had
    shadowed `vite.config.ts`, so production builds never dropped `console` calls.
- MCP: `kitsuden_query_collection` and `kitsuden_query_dataset` return 20 rows by default (was 50).
  Pass `limit` for more.
- MCP: kon tool schemas leave out the default integer bounds and the `pattern` next to a `format`
  (about 5 % smaller). The OpenAPI and the server's validation are unchanged.
- Security: a rule's `core:run-agent` step no longer fills `{{event.*}}` in its prompt with raw
  text. The agent handler fills it, marks the event text as untrusted data and holds the agent's
  writes for a person, as for a plain `agent` action.
- Security: `POST /api/code-graph/edit/:op` with `apply: true` answers 403 to an agent, even one
  with the `admin` scope. Only a person applies source edits; agents can still ask for a dry run.
- Security: the page-builder sanitizer now cleans blocks nested in a `grid` (`items[].content`) at
  save and at serve time, the same way as top-level blocks. Before, only their URLs were checked.
- Security: `format: "plain"` no longer skips the page-builder sanitizer for blocks other than
  `text` and `richtext`. A `callout` marked plain is rendered as Markdown, so it is now sanitized.
- Security: the promotion scanner reads a `/` after `++` or `--` as a division and reports it as
  `ambiguous_slash`, so code after it can no longer hide from the scan and the turbo route.
- Security: `GET /api/proposals`, `/api/proposals/:id` and `/api/proposals/:id/events` show a team
  member the result body of a proposal they could not approve as `REDACTED_CONTENT`, as the inbox
  does. Before, an editor could read there the responses of admin-only requests.
- Security: an agent request held for approval whose decoded path has a backslash, a control
  character or a `.`/`..` segment is refused with `ambiguous_path`, and an approved replay never runs
  such a path. Replayed, it could have reached a different route than the one approved.
- Security: a GraphQL document with a `delete…` mutation (`POST /api/graphql`) counts as a `DELETE`
  for the approval rules, so the default "hold every DELETE" rule now holds it.
- Security: an unattended agent run (cron, action, rule, queue) whose brain search puts in a shared
  note written by someone other than the agent or its signer holds every write for a person, even
  with approvals off. Interactive chat is unchanged.
- Security: the bundled SeaweedFS no longer lets anonymous read the whole media bucket. It reads only
  the public prefixes (`S3_PUBLIC_PREFIXES`, default `uploads transforms cartas juegos media dms`), and
  `private` can never be one of them, so a `private/` key needs its presigned URL.
- Security: the local `/media` route decides whether a key is private after normalizing it the way the
  disk does, so `uploads/../private/...`, a backslash or `Private/` no longer skip the signature check.
- Security: the connections OAuth callback only completes for the browser that started the round trip
  (an HttpOnly binding cookie) or a session of the same person. A consent link sent to someone else
  answers 403 instead of storing that person's account in the sender's connection.
- Security: kons get `ctx.realtime.capability(material)`, a channel name keyed by the server secret, for
  channels authorized to whoever names them (a web-chat visitor). A value read from the kon's tables no
  longer gives the channel.
- Security: MCP `kitsuden_update_record` keeps an entry's stored `data.ownerId`. Only an agent with
  `admin` may change it (and then `owner_id` moves with it); any other agent gets 403, so it can no
  longer slip rows into another user's per-owner view.
- Security: on a dataset whose workflow requires approval, MCP `kitsuden_create_record` and
  `kitsuden_insert_record` always store `draft`, and `kitsuden_update_record` refuses to publish an
  entry, as REST already did for agents.
- Security: `POST /api/datasets/export` (MCP `datasets__export-datasets`) answers 403 when the key
  carries a deny for any requested dataset (`!datasets:<slug>:*` or `:read`), even with `admin`.
- Security: an engine action's `meta.requiredScopes` follows the core scope rule: a `!` denial wins,
  `admin` included (`['admin', '!kon:crm:*']` no longer runs a `kon:crm:export` action).
- Security: the REST routes an engine auto-kon (`defineKon`) generates now require a human admin or an
  agent that opens the whole kon. Sorting and MCP filters accept only the model's column names
  (no raw SQL), and create and update write only model columns (update never changes `id`).
- Security: disabling or uninstalling a kon loaded at startup takes effect at once: its routes and MCP
  tools answer 404 "Kon not activated" instead of serving until the next restart.
- Security: `actsAsUserIn(kon, { wholeKon: true })` lets a kon policy that guards many operations accept
  an agent only with `user:act`, `admin` or a whole-kon scope, so a key scoped to one operation no longer
  opens the others.
- Security: the engine's email check excuses only the recipient's own record. Mail to an address the run
  read is still refused when it carries another customer's tracked value.
- Security: an agent no longer writes `data_sets` through the explorer, items, GraphQL or inline
  relations, so it cannot strip a field's customer-data mark there; `/api/data-sets` still checks it.
- Security: only a person writes secrets (agents get 403, even with `admin`), and `QUEUE_*`,
  `RATE_LIMIT_*` and `AGENT_KEY_*` are reserved keys, so an agent can no longer turn off job budgets.
- Security: `reports_aggregate` and running reports need, for an agent, a scope of the kon that owns
  the table, and refuse the columns a kon lists in `kon.json` `reportAccess.restricted`.
- Security: the secrets manager also reserves `APPROVALS_*`, `IDEMPOTENCY_*`, `OAUTH_*`, `METRICS_TOKEN`,
  `INJECTION_CLASSIFIER_URL` and the AI providers' base URLs; set them in `.env`.
- Security: data source responses show header names with a masked value instead of the stored token;
  a `PUT` that sends the mask back keeps the stored value.
- Security: the mailer quotes display names that hold special characters and refuses a recipient that
  is not one well-formed address, so a name or value with a comma cannot add recipients.
- Security: a `core:send-mail` rule step fills `{{…}}` in `to`, `cc`, `bcc` and `replyTo` as text, so
  an event value that is a list no longer sends the mail to every address in it.
- Security: `requireAdmin` and `requireScope` honour an agent key's `!pattern` denials, `admin`
  included, and `POST /api/mail/test` refuses a key that denies `mail:send`.
- Security: `!user:act` now stops an agent key with `admin` or `user:act` from counting as a
  signed-in account.
- Security: `/api/mail` and `/api/runs` sit behind the admin prefix gate, which re-reads the role from
  the database and applies the agent's denials.
- Security: first-run setup without a token (development API on loopback) needs a JSON body and a
  loopback `Host` and `Origin`, so a web page or DNS rebinding cannot claim the first administrator.
- Security: while no administrator exists, better-auth creates no account at all, so a first social
  sign-in is refused like a sign-up.
- Security: an incoming webhook with `authType: "bearer"` and no secret refuses every request, and an
  HMAC signature is checked only against the raw string body.
- Security: regenerating an agent's token (`POST /api/v1/agents/:id/token`) revokes its earlier static
  keys, and editing or deleting an agent over REST writes an audit entry.
- Security: `/llms.txt` sends `Vary: Origin, Host`, since its links come from the request's Host, and
  `GET /api/system/active-theme-config` no longer returns the error message on a 500.
- Security: a proposal's `before` values were read as the agent; an approver now sees only those their
  own access shows (the row is read again with their session), others are marked `beforeHidden`.
- Security: the agent's evidence on a proposal is hidden, like its body and diff, from someone who
  cannot approve it, and only such a person can schedule or close the proposal's later reviews.
- Security: an approved MCP record update no longer resends fields that were unchanged when proposed,
  so it cannot overwrite a newer value with a stale one.
- Security: approvals settings no longer fall back to "off" when the database does not answer at
  start-up or one stored value is invalid; only a database without the table keeps the old default.
- Security: a proposal made without a key replays with the scopes stored on it, never the agent's
  full set.
- Security: an MCP tool whose path parameters land on a sibling operation's route (an `id` equal to a
  static segment) is refused, so it cannot run that operation past the agent's `allowedTools`.
- Security: the SMTP driver never downloads an attachment `path` that is a URL; a path is a file on
  disk set by code.
- Security: a page's `customCss` cannot select on the `value` attribute (a way to read form fields
  through `url()`), and CSS escapes or comments no longer hide `@import` from the check.
- Security: a kon tool action (`agent.tool:…`) needs `mcp:write`, not `mcp:read`, unless it
  declares `meta.readOnly: true`.
- Security: tool calls made by agent runs in the engine spend the agent's daily write and budget
  quotas, and use the agent's untrusted-content wrapper (a kon tool action's result included).
- Security: an engine run with event data or earlier session turns skips the response caches; a
  session's history and a `traceId` are only reused for the agent they belong to.
- Security: external MCP servers and their OAuth endpoints are called through `pinnedFetch`, so the
  connection uses the addresses that were checked (no DNS rebinding).
- Security: changing an external MCP server's URL to another origin forgets its auth header, unless
  the same change sets a new one; a server name whose slug another server has is refused.
- Security: external MCP OAuth refuses metadata whose `resource` or `issuer` names another server,
  and the panel shows the token endpoint's `error` and `token_type` only when they are plain codes.
- Security: a kon hears another kon's events only when that kon shares them, in `events.public` or
  `events.subscribers` (in `defineKon` or `kon.json`); built-in lists keep the current cross-kon
  subscriptions working. kon-dc no longer receives `koe:message.received`. See docs/kons/events.md.
- Security: a kon emits only in its own namespace; an event under the core's or another kon's name is
  dropped and logged.
- Security: activating a switched-off kon without a restart checks the SDK its code declares, and
  refuses code whose kon id is not the installed one.
- Security: a kon is mounted only at `/api/<segment>…`; a kon declaring `/`, `/api` or a wildcard is
  not loaded.
- Fix: table changes reach realtime subscribers again; they were encoded twice and the row filter
  dropped them.
- Security: a kon switched off from the panel stops authorizing its realtime channels at once, and a
  second loaded kon with the same short id cannot take over its channels.
- Security: `ctx.realtime.broadcast` sends only on the kon's own channels (`kon:<short>:` or
  `<short>:`), not on `table:`, `entry:`, `content:`, `user:` or another kon's.
- Security: a kon id with `--` or a trailing `-` cannot keep automation rules, so its rule slugs cannot
  collide with another kon's.
- Security: a kon's rule step is validated again with the config filled from the event; a refused
  step fails without running.
- Security: `ctx.agents.run` passes the engine only the documented `KonAgentRun` fields.
- Security: kon assets no longer fall back to `packages/core/<id>`, so a folder there that is not a
  kon (or `packages/core` itself, for the id `kon-`) is never served.
- Security: signed `/media` addresses of private files percent-encode the key, so a `?`, `#` or `%`
  in a key no longer cuts the path short.
- Security: an rlsRule with an operator the builder does not know matches no row instead of being
  dropped, which opened the whole dataset.
- Security: the database policy that opens public datasets honours an agent's
  `!datasets:<slug>:read` denial (migration 0092), as the application already did.
- Security: the data explorer refuses to sort by, or write, a secret column, and a write to a table
  read by introspection refuses a field name that is not a plain identifier instead of rewriting it.
- Security: `GET /api/data-sets/:id/indexes/suggest` answers 404 for a dataset the caller cannot see.
- Security: `kitsuden_links` treats only an empty id and role as the system, and a row without owner
  is written only by the system and `admin` (migration 0093); the RLS helper functions run as their
  caller with a fixed `search_path`.
- Fix: `kitsuden_rls_owned` works with a uuid owner column.
- Security: the client IP counts `TRUSTED_PROXY_HOPS` proxies from the right of `X-Forwarded-For`
  (0 = the socket only) instead of skipping private entries, which let a client plant the IP the
  rate limiter saw. Unset means one proxy; the TLS overlay sets 2. Upgrade: with one proxy of your
  own in front of the API nothing changes; with two, set `TRUSTED_PROXY_HOPS=2`
  (docs/install/variables.md). better-auth's own sign-in limiter now reads the same resolved IP.
- Startup: in production outside public mode, an unset or localhost `BETTER_AUTH_URL`, `ADMIN_URL`,
  `WEB_URL` or `ALLOWED_ORIGINS` prints a warning naming each variable. It does not stop the start
  (a LAN or laptop install may mean it); public mode still refuses.
- Security: the external MCP OAuth callback only completes for the admin who started it (same
  session) or the browser holding the HttpOnly binding cookie the start sets; anyone else burns the
  state before any token exchange. Upgrade: open the authorization URL in the browser that started
  it, or one signed in as the same admin.
- Security: static agent keys record who minted them (`created_by`, migration 0094); when that
  person loses `admin` or their account is deleted, their live static keys are revoked
  (`revoked_by = system:demotion`) with an audit entry. Upgrade: keys minted before 0094 have no
  creator and keep working; rotate them to tie them to an admin (docs/agents/permissions.md).
- Security: an agent's `!` deny can now close a legacy core route by its `core:<area>:<access>`
  name (`!core:secrets:*`, `!core:*:write`), `admin` included. Upgrade: a deny with a leading
  wildcard such as `!*:write` now also covers legacy core routes (docs/agents/permissions.md).
- Security: kon queue names are scoped per kon (`<short id>:`), so a kon cannot handle another
  kon's queue or a core one (`kitsuden-*`), and it queues jobs elsewhere only when the owner opens
  the queue (`senders`) or the core allows it; kons also get `ctx.queue`. Upgrade: koe, chat and
  ingest keep their names; another kon's plain name (`sync`) becomes `<short>:sync`, and jobs
  already queued under `sync` still drain (docs/kons/queues.md).

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
