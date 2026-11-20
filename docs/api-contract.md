# The API contract: checks and viewers

The contract is `packages/sdk/openapi/kitsuden.openapi.json`: every operation declared with
`defineOperation`, written by `pnpm sdk:openapi` (see [agents/clients.md](agents/clients.md#generation)).
Three tools work on it, none of them a dependency of the project.

| Command          | What it does                                                           | In CI                        |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------- |
| `pnpm api:diff`  | What changed against another revision, and whether it breaks a client. | `api-contract`, not blocking |
| `pnpm api:lint`  | Kitsuden's rules for operations, scopes and errors (Spectral).         | `api-contract`, blocking     |
| `pnpm sdk:check` | The typed clients match the contract (with the reasons when not).      | `sdk-clients`, blocking      |

## Breaking changes: `pnpm api:diff`

[oasdiff](https://github.com/oasdiff/oasdiff) (Apache-2.0) compares the snapshot in the working tree
with the one at another git revision and sorts every difference into `ERR` (an existing client stops
working: an operation removed, a parameter made required, a response field removed), `WARN` or `INFO`.

```
pnpm api:diff                              # against origin/main
pnpm api:diff --base=v0.9.0                # against a tag or commit
pnpm api:diff --base-file=old.json --spec=new.json   # two files (a kon's old and new document)
pnpm api:diff --changelog                  # every change, not only breaking ones
```

It exits 1 when there is an `ERR`. The script downloads the pinned release once into
`node_modules/.cache/kitsuden-api-contract/`, checks its SHA-256 against the table in
`scripts/api-contract/oasdiff.mjs`, and runs nothing else. `OASDIFF_BINARY=<path>` uses your own build.

In CI the job compares a pull request with its base branch, a push to `main` with the previous commit,
and any other push with `main`. The job summary carries the changelog of the contract. It does not fail
the build yet: make it blocking once the deprecation policy below is in use.

### Deprecation policy

Removing an operation or a parameter that was never marked deprecated is an `ERR`. To remove one:

1. Deprecate it with a sunset date.
   - An operation: `deprecated: { since: "2026-11-18", sunset: "2027-05-18", use: "new-op" }` in
     its `defineOperation` (`use` is optional: the operation that replaces it). That one field gives
     `deprecated: true` + `x-sunset` in the OpenAPI, `Deprecation`/`Sunset` headers on every response
     (RFC 9745, RFC 8594), a first line in the MCP tool description, `@deprecated` in the TypeScript
     client, a `DeprecationWarning` in the Python one, and one log warning per call with the caller.
   - A query parameter: `.meta({ deprecated: true, "x-sunset": "2027-05-18" })` on its zod field,
     next to the new name (`include_blocks` → `includeBlocks` in page-builder is the first). The
     TypeScript client marks it `@deprecated`; in Python the old argument name sends the new one.
2. Keep it until that date. `kitsuden-deprecation-sunset` refuses a deprecation without one, and
   oasdiff refuses to let it go earlier (with no `x-sunset`, it asks for 90 days of notice:
   `DEPRECATION_DAYS` in the script).
3. Remove it in a release whose `CHANGELOG.md` has a `Removed` entry.

[api-stability.md](api-stability.md) is the longer proposal for 1.0 (headers, MCP, windows).

## Contract rules: `pnpm api:lint`

[Spectral](https://github.com/stoplightio/spectral) (Apache-2.0) with
`scripts/api-contract/spectral.yaml`: the generic OpenAPI rules plus Kitsuden's own, written as one
function (`scripts/api-contract/functions/kitsudenOperation.js`).

```
pnpm api:lint                                                    # the committed snapshot
pnpm api:lint --spec=http://localhost:3001/api/docs/blog/openapi.json   # a kon on a running API
```

| Rule                           | Level | What it asks of an operation                                                                                         |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `kitsuden-operation-extension` | error | `x-kitsuden-operation` with `kon`, `id`, `access`, `sensitive`, `errors`                                             |
| `kitsuden-operation-id`        | error | `operationId` is `<kon>.<operation>` (clients and MCP tools are named from it)                                       |
| `kitsuden-kon-tag`             | error | the first tag is the kon id                                                                                          |
| `kitsuden-fine-scope`          | error | `scope` is `kon:<kon>:<operation>`                                                                                   |
| `kitsuden-errors-documented`   | error | each code in `errors` has a `application/problem+json` response naming it                                            |
| `kitsuden-standard-errors`     | error | 403, 429 and 500 everywhere; 401 on session operations                                                               |
| `kitsuden-idempotency-key`     | error | non-GET operations announce `Idempotency-Key`                                                                        |
| `kitsuden-success-response`    | error | at least one 2xx or 3xx                                                                                              |
| `kitsuden-get-no-body`         | error | GET takes no body                                                                                                    |
| `kitsuden-documented`          | error | `summary` and `description`                                                                                          |
| `kitsuden-deprecation-sunset`  | error | a deprecated operation or parameter has `x-sunset`                                                                   |
| `kitsuden-path-style`          | error | lowercase kebab-case, no trailing slash, a file last (`.js`); deprecated ok                                          |
| `kitsuden-list-pagination`     | error | `list-*`/`search-*` reach the next page (`offset`, `page`, `cursor`, `before`/`after`), or say `unpaginated` and why |
| `kitsuden-query-camel-case`    | error | camelCase query parameters (a deprecated alias or a dotted foreign name is ok)                                       |
| `kitsuden-operation-declared`  | warn  | (hand-written routes found by discovery) declared with `defineOperation`                                             |

`error` rules hold for the whole contract (0 errors, 0 warnings) and fail CI. The gaps the first run
left were closed: three lists that stopped silently at a cap (connections at 200, saved reports at
500, dashboards at 200) now take `limit`/`offset` (the default is the old cap) and answer `hasMore`;
nine lists that are bounded by nature say so with `unpaginated: "<why>"` in `defineOperation`
(`x-kitsuden-operation.unpaginated`); `include_blocks` became `includeBlocks`, the old name
deprecated. Spectral's generic `array-items` is off: it reads the `items: false` of an OpenAPI 3.1
tuple as a missing `items`. Spectral runs with
`npx` at a pinned version (`SPECTRAL` in `scripts/api-contract/lint.mjs`).

The first run found that 34 operations could answer 403 without declaring it (a denial in an agent
key's scopes covers any operation, public ones included); `operationErrors` now declares it on all of them.
Running the rules on the kons found that a recursive zod schema (kon-dc's blueprints) was published with
references to a `#/$defs` that does not exist at the root of the document; `openApiOperation` now
rewrites them as pointers to where the schema lives.

### The kons

kitsuden-kons runs the same rules on its kons' operations (`pnpm api:lint` there,
`scripts/api-contract.mjs`): the core builds their document from the declarations with
`apps/api/scripts/sdk-openapi.ts --kon=…` (no database) and lints it with this ruleset, and the CI step
fails on an error. The first run (1092 operations, 33 kons) found 140 errors in 27 kons, all closed:
lists that page or say `unpaginated`, routes and a query parameter renamed through deprecation, and two
ambiguous route templates merged into one.

## Reading the document

Every operation in `/api/docs/openapi.json` also carries:

- `x-codeSamples`: the call with `@kitsuden/sdk` and the Python `kitsuden` client, shown by Scalar
  and RapiDoc next to the curl they build. `apps/api/src/lib/code-samples.ts` copies the generator's
  naming rules, and `tests/unit/code-samples.test.ts` checks every sample against the committed
  clients.
- `x-badges`: Public, Sensitive, Stream (SSE), Not an MCP tool.

`GET /api/docs/operations` lists every operation, the ones declared with `defineOperation` included
(it used to read only hand-written `openApi.paths`, which no kon has, and listed nothing for them).
`?filter=` takes RapiDoc-style terms; every plain term must match and no `!` term may:

```
?filter=kon:media method:get        # a kon (with or without kon-), a method
?filter=tag:files !deprecated       # a tag; leave out the deprecated
?filter=sdk /api/page-builder/**    # declared with defineOperation; a path glob (* one segment, ** any)
?filter=blocks.get-page             # an operationId; any other word searches id, summary and path
```

## Typed clients: filters and `kitsuden-lock.json`

`scripts/sdk/generate.mjs` can build a client for part of the API:

```
node scripts/sdk/generate.mjs --include-kon=blog,media
node scripts/sdk/generate.mjs --exclude-kon=analytics --exclude-path=/admin/**
node scripts/sdk/generate.mjs --include-path=/datasets/**#GET     # only the GETs under /datasets
node scripts/sdk/generate.mjs --reset-filters                     # back to every kon
```

`*` is one path segment, `**` anything, `#METHOD` limits the method. A kon name that is not in the
contract is an error, not a smaller client.

Each output folder gets `kitsuden-lock.json`: the filters, the hash of the contract the client was
generated from (only what the generator reads, so `--from-url` and `--from-kon` give the same lock) and
the hash of the generator. A run without filter flags reuses the filters in the lock, so a filtered
client stays filtered when regenerated, and `--check` says why a client is stale:

```
[sdk] generated clients are STALE:
  why: the contract changed (API 0.9.0-beta → 0.9.0-beta); same kons and operation counts
  stale: packages/sdk/src/generated/kons/datasets.ts
```

## The documentation viewers

`/api/docs` (Swagger UI) and `/api/docs/modern` (Scalar) are served by the API itself. They used to load
their code from jsDelivr with no version, on a page where people paste tokens.

- `apps/api/src/lib/docs-viewers.json` pins each viewer: npm version, tarball `integrity` (sha512) and the
  SRI (sha384) of each file served.
- `node scripts/docs-viewers.mjs` (run by the API `build` and `dev`, by the image build and by the
  `kitsuden` package build) downloads the tarball, checks it, extracts only those files into
  `apps/api/docs-viewers/` (git-ignored) and checks each file. The packages are not installed: Scalar
  would bring about 30 packages (Vue, CodeMirror, an AI chat) to serve one file.
- The pages send `Content-Security-Policy` with a per-request nonce and `connect-src 'self'`, and each
  script and stylesheet carries its `integrity`. Scalar's telemetry, font CDN, AI agent and MCP
  generator are switched off; Swagger UI's validator badge (which sends the document's URL to
  swagger.io) too.
- Scalar shows one document per entry of its selector: the whole API, then each kon at
  `/api/docs/<kon>/openapi.json`.
- Without the files, both pages answer 503 and say how to get them.

To move a viewer to another version: change `version`, `tarball` and `integrity` in the JSON
(`npm view <package>@<version> dist.integrity dist.tarball`), run
`node scripts/docs-viewers.mjs --update` (it recomputes each `sri`), and check both pages.
`node scripts/docs-viewers.mjs --outdated` says which pins have a newer release on npm; the
workflow `docs-viewers.yml` runs it on the first of every month (Dependabot does not read the JSON).

### The API console in the panel

In the panel, **Kons** shows an **API** button on each enabled kon's card. It opens a side panel with
RapiDoc's `<rapi-doc-mini>`: pick one operation of that kon (or every operation of a tag) to read it
and try it. It is developer oversight, not a work screen. Requests go to this API with the panel
session cookie (the console says so); the console never asks for a token.

- **Pin.** `rapidoc` 12.0.0 is in `docs-viewers.json` with the other viewers and served at
  `/api/docs/assets/rapidoc@12.0.0/rapidoc-min.js`. The panel imports that JSON at build time
  (`packages/admin/src/lib/api-console/rapidoc.ts`) for the URL and the SRI, and adds the script (an ES
  module, `integrity` + `crossorigin`) only the first time a console opens. It comes from the panel's
  own origin through the `/api` proxy, so the panel's `script-src 'self'` needs no change. Why 12.0.0:
  the project jumped from 9.3.8 (2024) to 14.1.0 in six weeks of 2026, with one maintainer and
  breaking attribute changes (13 replaced `match-paths` with `filter-operations`); 12.0.0 was the
  newest release more than two weeks old, has `<rapi-doc-mini>`, `loadSpec(object)` and
  `fetch-credentials`, and its sanitizer is the same file as in 14.1.0. The console filters the
  document itself, so it uses neither filter attribute. Before a bump, read the new
  `src/utils/sanitize.js` and the mini's attributes. The 12.0.0 bundle carries no notices of the
  libraries it bundles (lit, marked and others); 12.1.0 and later ship `rapidoc-min.js.LICENSE.txt`.
- **Its sanitizer.** RapiDoc renders descriptions, summaries and schema titles as Markdown into HTML
  (`marked`, then `sanitizeHTML`, then lit's `unsafeHTML`). `sanitizeHTML` uses the browser's
  Sanitizer API when there is one; otherwise a shim that only removes `<script>`, `on*` attributes,
  and `href`/`src` values containing `javascript:` or `data:text/html`. The shim lets through:
  `<iframe srcdoc>` (same origin as the panel), `<object data>`, `<form action>`, `formaction`,
  `<meta http-equiv="refresh">`, `<base>`, `<style>` and `style` attributes, SVG `xlink:href` and
  animation tricks, `javascript:` hidden by an entity (`java&#9;script:`), remote images (a tracking
  pixel), and, by design, mutation XSS: it parses with `DOMParser` (scripting off) and lit parses the
  output again with scripting on, so a `<noscript><p title="</noscript><img src=x onerror=…>">` can
  come out with a live `onerror`. Checked in Chromium with the shim forced, on a hostile sample: an
  `iframe srcdoc` with an inline script and two inline event handlers reached the page, and only the
  panel's `<meta>` CSP (hashes, no `'unsafe-inline'`) stopped them; the nginx header alone
  (`'unsafe-inline'`) would not. With the native Sanitizer API the iframe and the handlers go,
  but remote images stay. The bundle also
  fetches any external `$ref` (`http(s)://…`) while resolving a document. Kon descriptions are
  untrusted: kons can be third-party code.
- **Mitigation.** RapiDoc never fetches a document: the panel fetches `/api/docs/<kon>/openapi.json`,
  passes it through `prepareConsoleSpec` (`packages/admin/src/lib/api-console/spec.ts`, tested with
  hostile payloads rendered by `marked` in `spec.test.ts`) and hands the object to `loadSpec()`. Every
  `description`, `summary` and `title` gets `&`, `<` and `>` as entities (no raw HTML, no entity
  tricks), Markdown links to `javascript:`/`vbscript:` lose their scheme, and `![…](…)` stops being
  an image. External `$ref`s are dropped, `servers` becomes this API only (at every level), and
  security schemes, `security`, webhooks and callbacks are removed. The element gets
  `persist-auth="false"`, `mock-server="false"` (the mock server replaces `window.fetch` for the whole
  page) and `allow-spec-url-load="false"`/`allow-spec-file-load="false"` (attributes of `<rapi-doc>`,
  not of the mini in 12.0.0: set so a later version cannot start loading URLs). Cost: inside a
  Markdown code span the entity shows as written (`` `<id>` `` reads `&lt;id&gt;`), and `<`, `>` or
  `&` in an example value under a `title` or `description` key shows the same way.
