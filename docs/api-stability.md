# API stability (draft)

> **Draft, not yet a promise.** This is a proposal for the owner to accept,
> change or reject before 1.0. Nothing here is guaranteed today: until it is
> accepted, Kitsuden is `0.x` and any surface can change in any release.

It says what 1.0 would promise to keep working, what it would not, and how a
change would be announced. It describes what the code exposes today, so the
promise covers only things that can be checked.

## What would be covered

| Surface                   | What it is today                                                                                                                                                                                                                                                                                                                        | Where it is defined                                                                        | How it is checked                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **SDK operations (REST)** | Every route declared with `defineOperation`: method, path, path and query parameters, body schema, response schema, `operationId` (`<kon>.<op-id>`), the `x-kitsuden-operation` extension (scope, sensitive, idempotent, pagination). Mounted at the kon's mount path (`/api/datasets`, `/api/approvals`…), not under a version prefix. | `packages/engine/src/operations.ts`, `apps/api/src/lib/operations-openapi.ts`              | `packages/sdk/openapi/kitsuden.openapi.json` snapshot, `pnpm sdk:check` in CI |
| **Typed clients**         | `@kitsuden/sdk` (TypeScript) and `kitsuden` (Python): one property per kon, one method per operation, generated from the snapshot.                                                                                                                                                                                                      | `scripts/sdk/generate.mjs`                                                                 | `sdk:check`, `test:sdk`                                                       |
| **MCP tools**             | One tool per SDK operation that is not excluded: name `<kon>__<op-id>` (`datasets__create-entry`), the arguments (path and query flat, `body`, `idempotency_key`), the guide resources.                                                                                                                                                 | `mcpTool()` in `operations-openapi.ts`                                                     | MCP tests in `apps/api/src/tests`                                             |
| **Error codes**           | `application/problem+json` with a stable `code` (`KITSUDEN_E_*`, 25 today), `retryable`, `retry_after`. The codes are the contract; `title` and `detail` texts are not.                                                                                                                                                                 | `KITSUDEN_ERRORS` in `packages/shared/src/errors.ts`, `docs/install/errors-and-retries.md` | the `Problem` schema enum in the snapshot                                     |
| **Approval flow**         | `202 KITSUDEN_E_APPROVAL_REQUIRED` with a proposal, and the proposal status operations (`kon-proposals`, `kon-approvals`).                                                                                                                                                                                                              | core operations                                                                            | API suite                                                                     |
| **Agent auth**            | `Authorization: Bearer kitsuden_agent_*`, scopes as declared by operations.                                                                                                                                                                                                                                                             | `apps/api/src/index.ts`, agent permissions                                                 | API suite                                                                     |
| **`GET /api/version`**    | `product`, `version`, `contracts` (major version per contract), `sdk.kons`. Until 0.10 readers also accept the 0.8 names `producto` and `contratos`.                                                                                                                                                                                    | `apps/api/src/routes/version.ts`, `packages/shared/src/contracts.ts`                       | `docs/install/versions.md`                                                    |
| **Environment variables** | The variables in `.env.production.example` and `docs/install/variables.md`: names, meaning, defaults.                                                                                                                                                                                                                                   | those two files                                                                            | install scripts and `create-kitsuden` tests read the example                  |
| **Kon manifest**          | The `kon.json` fields the core reads: `id`, `name`, `version`, `sdk` (kon SDK major, `1` today), `mount.path`, `tables`, `dependencies`, `maturity`, `kitsuden` / `minKitsudenVersion`. And the kon SDK itself (`defineKonSdk`, `defineOperation`, `defineModel`, the `KonContext` a kon receives).                                     | `KonManifestFile` in `apps/api/src/lib/installed-kons.ts`, `packages/engine`               | `kon-manifest` and `kon-loadable` guard tests                                 |
| **Database migrations**   | An upgrade applies the pending migrations by itself; a released migration file is never edited (they are checksummed).                                                                                                                                                                                                                  | `apps/api/scripts/migrate.ts`                                                              | migration runner                                                              |

## What would not be covered

- **Routes that are not SDK operations.** `LEGACY_ROUTES` in
  `apps/api/src/lib/legacy-routes.ts` lists the hand-written routes (they appear in
  the OpenAPI by discovery, with no output schema). They may change until each one
  becomes an operation; that list only shrinks.
- **`/api/admin/*`** and every route the panel uses for itself (`/api/explorer`,
  `/api/modules`, `/api/system/*`…): they serve the panel, which ships with the API
  and changes with it.
- **The panel** (`packages/admin`): its views, URLs, Web Component internals.
- **`/api/v1`**: today it holds only the agent-permission routes for the panel
  (admin only) and legacy routes. The name suggests a versioned API; it is not one.
  Proposal: do not promise it, and do not use `v1` as the version of the stable API
  (the snapshot and `GET /api/version` already version it).
- **Experimental kons** (`maturity: "experimental"` in `kon.json`) and beta kons'
  operations until they reach stable. A kon's own operations are promised by the kon's
  version, not the core's.
- **Human-readable texts**: error `title`/`detail`, MCP tool descriptions and guides,
  log lines, CLI output.
- **Internal modules**: anything imported from `apps/api/src/**` or
  `@kitsuden/engine/src/**` paths instead of a package's entry point.
- **Response fields not in the declared output schema**, and the order of keys.
- **The Inti contract** is versioned on its own (`contracts` in `GET /api/version`).

## Versioning

Proposal:

1. **Semver on the core version** (`KITSUDEN_VERSION`, the images, the npm packages
   released together).
   - _Patch_: fixes; no covered surface changes.
   - _Minor_: additions only: new operations, new optional input fields, new response
     fields, new error codes, new env vars with a default. Clients must ignore unknown
     response fields and unknown error codes (falling back on the HTTP status).
   - _Major_: removals or incompatible changes of a covered surface.
2. **A covered surface is deprecated for at least one minor release before it is
   removed**, and the removal ships in the next major.
3. **After 1.0, a deprecated surface keeps working for at least 6 months** from the
   release that deprecates it, even if a major comes sooner. Security fixes may
   shorten this; the release notes say why.
4. **The kon SDK has its own major** (`sdk` in `kon.json`, `sdk.kons` in
   `GET /api/version`). The core refuses kons written for a newer SDK than it
   provides (already true). Proposal: a core supports the current kon SDK major and the
   previous one for the same 6 months.
5. **Kons version themselves** (`version` in `kon.json`) and follow the same rules for
   their own operations once stable.

## How deprecations are announced

- **HTTP headers on every response of a deprecated operation**:
  `Deprecation: @<unix time>` (RFC 9745) and `Sunset: <HTTP date>` (RFC 8594), plus
  `Link: <docs url>; rel="deprecation"`. Today the only deprecation (`kitsuden_sk_*`
  keys) sends `Deprecation: kitsuden_sk_*; kitsuden_agent_*` and `Sunset: 2026-08-01`,
  which are not in the RFC formats; they would be aligned first.
- **In the OpenAPI**: `deprecated: true` on the operation, and the `x-kitsuden-operation`
  extension carries the sunset date, so the generated clients mark the method
  `@deprecated` (TypeScript) or warn (Python).
- **In MCP**: the tool description starts with "Deprecated: use …", so an agent reads
  it before calling.
- **In the log**: one warning per deprecated call, with the operation and the caller
  (as the legacy keys already do).
- **In `CHANGELOG.md`**: a `Deprecated` section in the release that deprecates, and a
  `Removed` section in the release that removes.
- **Env vars and manifest fields**: the API logs a warning at startup when a deprecated
  one is set, and keeps reading it until it is removed.

## Open questions for the owner

- Is a version prefix wanted at all (`/api/v2/...` for a future major), or does the
  stable API stay unprefixed and versioned by `GET /api/version` and the snapshot?
- Which core operations are stable at 1.0? Proposal: datasets, media, blocks,
  approvals, proposals, agents, brain, queue, traces; the rest stay beta.
- Is 6 months the right window for a project with one maintainer?
- Should `snapshot diff` in CI fail on any incompatible change to a stable operation
  (a removed field, a narrowed type) without a deprecation entry?
