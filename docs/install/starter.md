# A website with the starter

Kitsuden is headless: the public website is a separate project that reads the
API. The repository ships a neutral starting point,
**`packages/starters/kitsuden-starter-basic`** (package
`@kitsuden/starter-basic`): an Astro 7 website rendered on the server
(`@astrojs/node` standalone) that shows

- **pages** made with the page builder, by slug;
- the **blog** (paginated list and one post);
- **images** from the media library, served from the website's own origin;
- a 404, a 503 when the API does not answer, SEO basics (canonical URLs, Open
  Graph, `sitemap.xml`, `robots.txt`), a light/dark theme and an English
  interface with one dictionary per language.

It only needs the Kitsuden core (pages and media) and `kon-blog`, both enabled
by default. The full reference (structure, blocks, API routes it uses,
languages, tests) is its
[README](../../packages/starters/kitsuden-starter-basic/README.md); this page
sums up what you need to install it.

## Variables

Template: the starter's `.env.example`.

| Variable                      | When it is read | Purpose                                                                                                                                                                                             |
| ----------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KITSUDEN_API_URL`            | at start        | Where **this server** reaches the API. In Docker, the internal address (`http://kitsuden_api:3000`). On Windows with a local API, `localhost`.                                                      |
| `SITE_URL`                    | at build        | Public origin of the website: canonical URLs, Open Graph and the sitemap. Rebuild after changing it.                                                                                                |
| `SITE_NAME`                   | at build        | Name in the header, the `<title>` and the footer.                                                                                                                                                   |
| `SITE_LOCALE`                 | at build        | Interface language; also sent to the blog API as `?locale=`.                                                                                                                                        |
| `KITSUDEN_SITE_KEY`           | at start        | Optional and secret: the same value as the API's `SITE_API_KEY`. With it the API counts the rate limit per visitor instead of for the whole website at once.                                        |
| `KITSUDEN_TRUST_PROXY`        | at start        | Optional (`false`). Behind a reverse proxy (Caddy, nginx), `true` takes the visitor's IP from the **last** `X-Forwarded-For` entry, the one the proxy adds. Only when the proxy is the only way in. |
| `PORT`, `HOST`                | at start        | Of the Node server (`4321` and `0.0.0.0` in the Docker image).                                                                                                                                      |
| `INTI`, `INTI_KITSUDEN_TOKEN` | build / start   | Only for Inti ([inti.md](inti.md)).                                                                                                                                                                 |

Add the website's origin to the API's `ALLOWED_ORIGINS` if the browser will
call the API from it (session, Inti editor).

## Development

```bash
cd packages/starters/kitsuden-starter-basic
cp .env.example .env              # KITSUDEN_API_URL=http://localhost:3000, SITE_URL=http://localhost:4321
pnpm dev                          # http://localhost:4321 (with the API running)
```

(From the monorepo root, `pnpm --filter @kitsuden/starter-basic dev`.) In the
admin, create a page with the slug `home` (or mark one as the homepage), add
blocks and publish it: it appears at `/`. Every published page is served at
`/<slug>` and listed in the header; published blog posts appear at `/blog`.

## Build and serve (without Docker)

```bash
cd packages/starters/kitsuden-starter-basic
SITE_URL=https://example.com pnpm build
KITSUDEN_API_URL=http://localhost:3000 PORT=4321 HOST=0.0.0.0 pnpm start   # node ./dist/server/entry.mjs
```

Because it is rendered on the server, what you publish in the admin shows up
without a rebuild; the API caches public reads for 1 to 5 minutes.

## With Docker

`docker/Dockerfile.web` builds the starter (Node 22 and pnpm 9.15.4, only the
starter's dependencies) and serves it without root on :4321. It is the
`kitsuden_web` service of the TLS overlay, behind Caddy
([server.md](server.md#9-first-public-start)):

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml build kitsuden_web
```

The overlay passes `SITE_URL=https://${SITE_DOMAIN}`, `SITE_NAME` and
`SITE_LOCALE` at build time, and at start
`KITSUDEN_API_URL=http://kitsuden_api:3000`,
`KITSUDEN_SITE_KEY=${SITE_API_KEY}` and `KITSUDEN_TRUST_PROXY=true`. On its
own, without compose:

```bash
docker build -f docker/Dockerfile.web --target web \
  --build-arg SITE_URL=https://example.com -t kitsuden-web .
docker run -p 127.0.0.1:4321:4321 -e KITSUDEN_API_URL=http://<api>:3000 kitsuden-web
```

The image is built **without** Inti.

## Your own website

The usual path is to copy the starter and change it: new blocks in
`src/blocks/` (registered in `src/blocks/index.ts`), another language in
`src/i18n/`, styles and templates in `src/layouts` and `src/components`. To
copy it without `node_modules`, `dist` or `.env`, the repository's CLI does it
for you (`kitsuden new my-site --api-url http://localhost:3000`; see
`packages/cli/README.md`: the CLI is not on npm, run it from the repository
with `node packages/cli/dist/index.js`).

In your own copy, consider pinning dependency versions with `~` (for example
`astro ~7.4.2`) so a reinstall does not move you to a version with changes.

### Inside the monorepo

The root `pnpm-workspace.yaml` only includes
`packages/starters/kitsuden-starter-*`. If you copy the starter **inside**
`packages/starters/` under another name (`packages/starters/my-site`), it
stays out of the workspace on purpose, so that the root `pnpm-lock.yaml` only
describes what is in the repository. That folder needs:

- its own `pnpm-workspace.yaml`, which makes it a separate workspace:

  ```yaml
  packages:
    - "."
  ```

- and its own `pnpm-lock.yaml`: `pnpm --dir packages/starters/my-site install`
  (not tested with a copy of the neutral starter);
- with Inti and pnpm 10, `onlyBuiltDependencies` in that
  `pnpm-workspace.yaml` ([inti.md](inti.md#1-what-you-need)).

Outside the monorepo (another folder, another repository) it works the same:
the starter imports nothing from the monorepo.

### Serving it in production

Your own compose overlay that redefines `kitsuden_web` (another Dockerfile,
other build arguments) and, if the website needs other routes or domains,
another `Caddyfile` mounted in `kitsuden_proxy`. Pass it after the TLS
overlay, or with `KITSUDEN_OVERLAYS` in `scripts/deploy.sh`
([server.md](server.md#another-website-instead-of-the-starter)).
