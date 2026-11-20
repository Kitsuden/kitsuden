# Connecting Inti (visual editing)

[Inti](https://github.com/Kitsuden/inti) is a separate project,
Astro for modernizing CMSs in the AI era: a visual editing layer for Astro
websites on top of any headless CMS. An editor opens the public website, sees
outlines over the blocks and edits them in place. It lives in another repository
(`@intijs/*` packages) and **does not depend on Kitsuden**: it also works with
WordPress, through its own adapter. With Kitsuden it talks to the API through
`@intijs/adapter-kitsuden`. Kitsuden stays headless and works the same
without Inti.

```
 editor (browser, with their Kitsuden session cookie)
    │  1. requests the page
    ▼
 Astro site with INTI=true ── 2. forwards the cookie to GET /api/auth/get-session ──► API
    │                           (role admin|editor?)                                ▲
    │  3. edit → /_actions/inti.* (the website's server)                             │
    └──── 4. adapter with the AGENT KEY (scope content:edit) ────────────────────┘
```

Two different credentials, best not confused:

|                                                                | Who holds it                                                  | What for                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Editor session** (better-auth cookie)                        | each person's browser                                         | deciding **who** may edit: only users with role `admin` or `editor` see the editor |
| **Agent key** `kitsuden_agent_…` with the scope `content:edit` | **only** the website's server (environment variable at start) | **writing** to the API. It never reaches the browser and is never built in         |

## 1. What you need

- Kitsuden with `kon-blocks` (pages, enabled by default) and, to edit game
  pages, `kon-games` ([first-run.md](first-run.md#3-enabling-kons)).
- An Astro website prepared for Inti. The neutral starter
  (`packages/starters/kitsuden-starter-basic`) is: without Inti it contains no
  Inti code, and with `INTI=true` and both packages installed it adds the
  editor.
- `@intijs/core` and `@intijs/adapter-kitsuden`, which are **not** on npm:
  install them from git, both from the **same** commit:

  ```bash
  cd packages/starters/kitsuden-starter-basic     # or your website's folder
  pnpm add "github:Kitsuden/inti#<commit>&path:/packages/core" \
           "github:Kitsuden/inti#<commit>&path:/packages/adapter-kitsuden"
  ```

  Note the slash after `path:`. Each package is built when it is installed
  (its `prepare` script). With **pnpm 10**, which does not run dependency
  build scripts unless allowed, add to the website's `pnpm-workspace.yaml`:

  ```yaml
  onlyBuiltDependencies:
    - "@intijs/core"
    - "@intijs/adapter-kitsuden"
  ```

  pnpm 9 runs them by default. Inside the Kitsuden monorepo, `pnpm add`
  changes the starter's `package.json` and the root `pnpm-lock.yaml`: do it in
  your copy, not in a change for the repository.

- Compatible versions: [versions.md](versions.md#compatibility-matrix).

## 2. The agent key

It must be an **agent** key (`kitsuden_agent_…`) with **only** the scope
`content:edit`. That scope opens exactly the page builder
writes (`/api/page-builder`) and the two routes of the games editorial layer
(`PATCH /api/games/:id/blocks/:blockId/editorial`,
`PUT /api/games/:id/blocks/order`); everything else answers 403 (tested
2026-10-15: `PATCH /api/settings` and `POST /api/games` → 403). `kitsuden_sk_*`
keys do not work: they carry no agent identity and get 401.

From the panel: **Agents → New agent** with the scope `content:edit`. Or
through the API with an administrator session:

```bash
curl -s -X POST http://127.0.0.1:3000/api/admin/agents -b cookies.txt \
  -H 'origin: http://localhost:3001' -H 'content-type: application/json' \
  -d '{"name":"Inti","type":"custom","scopes":["content:edit"]}'
# → 201 {"success":true,"data":{"agent":{…},"apiKey":"kitsuden_agent_…"}}
```

The key is shown **once**: keep it in the website server's environment
(`INTI_KITSUDEN_TOKEN`), not in a file in the repository.

Check (change the slug if it already exists):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/api/page-builder/pages \
  -H "Authorization: Bearer $INTI_KITSUDEN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Test","slug":"inti-test","status":"draft"}'           # 201
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://127.0.0.1:3000/api/settings \
  -H "Authorization: Bearer $INTI_KITSUDEN_TOKEN" -H 'content-type: application/json' -d '{}'   # 403
```

If you just enabled `kon-games` at runtime and editing games with the key
returns 401, restart the API (seen on 2026-10-15,
[first-run.md](first-run.md#3-enabling-kons)).

## 3. The website with `INTI=true`

With the neutral starter:

```bash
cd packages/starters/kitsuden-starter-basic
INTI=true pnpm build                         # NEVER with the key in the environment
INTI_KITSUDEN_TOKEN=kitsuden_agent_… KITSUDEN_API_URL=http://localhost:3000 pnpm start
```

`astro.config.mjs` also removes the key from the environment while building.
`INTI_ADAPTER` and `INTI_KITSUDEN_ENDPOINT` are filled in automatically
(`kitsuden`, and `KITSUDEN_API_URL`). `INTI=true` without the packages stops
the build with a message that points to the starter's README.

With `INTI=true` the website adds: the middleware that recognises editors, the
write actions under `/_actions/inti.*` and the editor UI. Without the
variable none of that is bundled (`packages/starters/kitsuden-starter-basic/tests/build.test.mjs` checks
it). The website's Docker image (`docker/Dockerfile.web`) is built without
Inti; to include it, add the packages to the starter and pass
`--build-arg INTI=true` (not tested).

## 4. The editor session and the cookie

The editor only appears when the request to the **website** carries the
better-auth session cookie (`better-auth.session_token`, or
`__Secure-better-auth.…` over https) and the API, when the cookie is forwarded
to it, answers with an `admin` or `editor` user. The cookie is set by the
**API** at sign-in, for **its own** host. That is why it matters where each
part lives:

- **Locally** (website on `localhost:4321`, API on `localhost:3000`): cookies
  ignore ports, so the session started in the panel or the API reaches the
  website. Use `localhost` for both; **do not** mix it with `127.0.0.1`
  (different hosts for the browser).
- **On a server with a domain** (website on `example.com`, panel/API on
  `panel.example.com`): the better-auth cookie belongs **only to the host**
  that sets it (`panel.example.com`); the website does not receive it and
  **nobody** sees the editor. You need a cookie for the parent domain.
  better-auth supports it with
  `advanced.crossSubDomainCookies: { enabled: true, domain: "example.com" }`
  in `apps/api/src/lib/auth.ts`, which is **not configured today** (there is no
  variable for it). An alternative without touching the API: also serve
  `/api/auth/*` from the website's domain (a `handle /api/auth/*` to the API in
  the `{$SITE_DOMAIN}` block of `docker/Caddyfile`) and sign in from there
  **(not tested)**. Either way, `ALLOWED_ORIGINS` must include the website's
  origin.

## 5. Purging the website's cache when a page changes

A website that caches pages (a CDN, Astro's own cache, a static build) has to
learn when one changed. Kitsuden emits `page:updated` after every committed
change to a page or one of its blocks, and `page:deleted` when one is deleted.
Payload:

| Field          | When                       | What                                                   |
| -------------- | -------------------------- | ------------------------------------------------------ |
| `id`           | always                     | the page's uuid                                        |
| `slug`         | always                     | the slug it has now (`page:deleted`: the one it had)   |
| `previousSlug` | `page:updated`, on renames | the slug before the rename: purge that address **too** |

The webhook is an [automation rule](../automation.md) on that event with a
`core:webhook` step. With an administrator session:

```bash
curl -s -X POST http://127.0.0.1:3000/api/actions -b cookies.txt   -H 'origin: http://localhost:3001' -H 'content-type: application/json' -d '{
  "name": "Purge the website",
  "slug": "purge-website-pages",
  "type": "rule",
  "trigger": "event",
  "triggerConfig": { "eventName": "page:updated" },
  "config": { "steps": [ {
    "handler": "core:webhook",
    "config": {
      "url": "https://example.com/_purge",
      "secret": "<a long random string, also in the website environment>"
    }
  } ] }
}'
```

Repeat it with `"eventName": "page:deleted"` if the website must also drop
deleted pages. What the website receives:

- `POST` with `Content-Type: application/json` and the body
  `{"event":"page:updated","data":{"id":…,"slug":…,"previousSlug":…},"timestamp":…,"action":{…}}`.
- `X-Kitsuden-Signature: sha256=<hex>`: the HMAC-SHA256 of the **raw body**
  with the `secret`. Check it over the bytes as they arrived, before parsing,
  and compare in constant time.
- `Idempotency-Key`: the same on every retry of one delivery. Purging twice is
  harmless, but a receiver that keeps a log can use it.

The URL's host must be written out (the event cannot choose it) and passes the
same target check as any webhook: an internal address is refused unless the
operator allowed it (`KITSUDEN_WEBHOOK_ALLOW_INTERNAL`, [variables.md](variables.md)). A
placeholder may go in the path or the query:
`https://example.com/_purge/{{event.slug}}`.

**Retries.** The first attempt is made right away. If the website does not
answer, or answers 5xx or 429, the retries go to the job queue
(`kitsuden-rule-webhooks`, [queue.md](queue.md)), with backoff, and survive a
restart of the API. A 4xx is final. The rule's run history shows
`retrying: true` with the job id; a delivery that ran out of attempts is in the
queue's dead letter (panel → Queue).

**Listing pages to warm or rebuild a cache.** `GET /api/page-builder/pages`
with `?paging=cursor` answers `nextCursor`; pass it back as `?cursor=` until it
is `null`. Cursor paging counts nothing and does not skip or repeat a page that
is edited while the walk runs. The `offset` form still works and answers
`totalDocs`.

**Searching pages.** `POST /api/search` answers, beside `results` (dataset
entries), `pages`: published pages that do not require a session, matched on
the title, description, meta fields and the text of the blocks visible now. Up
to 10, only on the first page of results (`offset` 0) and without `datasetId`;
`"pages": false` leaves them out.

## 6. Common problems

| Symptom                                                                       | Cause                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The write answers `writing needs token`                                       | `INTI_KITSUDEN_TOKEN` missing when the website **starts**                                            |
| `token has to be an agent key`                                                | it is a `kitsuden_sk_*` key                                                                          |
| `401 Invalid or expired API key`                                              | the key was revoked or mistyped                                                                      |
| `401 Unauthorized - Authentication required` on games                         | kon enabled at runtime: restart the API                                                              |
| `403` on everything except pages and the editorial layer                      | correct: that is the `content:edit` scope                                                            |
| The adapter says Kitsuden speaks `page-builder` v2 but it only understands v1 | incompatible versions: [versions.md](versions.md)                                                    |
| The adapter says Kitsuden does not declare the `games-editorial` contract     | usually the kon that serves it is disabled (`kon-games`; `kon-blocks` for `page-builder`): enable it |
| A `[KitsudenAdapter]` warning that `/api/version` does not exist              | Kitsuden without the version route: works, without the check                                         |
| Nobody sees the editor in production                                          | the cookie does not reach the website (§4)                                                           |

Adapter documentation (options, index rule, game pages):
`apps/docs/src/content/docs/adapters/kitsuden.mdx` in the Inti repository.
