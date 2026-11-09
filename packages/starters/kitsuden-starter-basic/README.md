# Kitsuden starter (basic)

A small, neutral Astro site that shows how to build a public website on top of
[Kitsuden](https://github.com/Kitsuden/kitsuden). It reads
everything from the Kitsuden API at request time:

- **pages** made with the page builder, by slug, with a renderer for the core
  block types;
- the **blog** (list with pagination, and one post);
- **images** from the media library, served through this site's own origin;
- a **404**, a **503** when the API cannot answer, **SEO** basics (title,
  description, canonical URL, Open Graph, `sitemap.xml`, `robots.txt`);
- a **light/dark theme** (system preference plus a toggle);
- an **English interface** with a simple dictionary per language.

Optionally it can be built with [Inti](#visual-editing-with-inti-optional), the
visual editing layer: a Kitsuden editor then edits the page blocks directly on
the page. Without Inti the site has no Inti code at all.

It only needs the core of Kitsuden (page builder and media library) and the
blog kon (`kon-blog`, active by default). It does not use any other optional kon: blocks
that belong to other kons render nothing.

## Requirements

- Node.js 22.23.4 or newer (Astro requires it) and pnpm 9.
- A running Kitsuden API (see `docs/install/` in the Kitsuden repository).

## Quick start

```bash
cd packages/starters/kitsuden-starter-basic   # or a copy of this folder anywhere
pnpm install
cp .env.example .env                          # then edit KITSUDEN_API_URL and SITE_URL
pnpm dev                                      # http://localhost:4321
```

In the Kitsuden admin, create a page with the slug `home` (or mark a page as
homepage), add some blocks and publish it: it appears at `/`. Every other
published page is served at `/<slug>` and listed in the header. Published blog
posts appear at `/blog`.

Production:

```bash
pnpm build
KITSUDEN_API_URL=http://localhost:3000 PORT=4321 HOST=0.0.0.0 pnpm start   # node ./dist/server/entry.mjs
```

The site is server-rendered (`output: "server"`, `@astrojs/node` standalone):
publishing in the admin shows up without a rebuild. The API caches public
reads for up to 1 to 5 minutes, so a change can take that long to appear.

## Configuration

All variables are in [`.env.example`](.env.example).

| Variable                      | When it is read      | Purpose                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KITSUDEN_API_URL`            | at server start      | Where **this server** reaches the API. Inside Docker, usually the internal address. Use `localhost`, not `127.0.0.1`, when the API runs locally on Windows (it may only listen on `::1`).                                                                                                          |
| `SITE_URL`                    | at build             | Public origin of the site: canonical URLs, Open Graph and the sitemap. Rebuild after changing it.                                                                                                                                                                                                  |
| `SITE_NAME`                   | at build             | Name in the header, the `<title>` and the footer.                                                                                                                                                                                                                                                  |
| `SITE_LOCALE`                 | at build             | Interface language, also sent to the blog API as `?locale=`.                                                                                                                                                                                                                                       |
| `KITSUDEN_SITE_KEY`           | at server start      | Optional, see below. Secret.                                                                                                                                                                                                                                                                       |
| `KITSUDEN_TRUST_PROXY`        | at server start      | Optional boolean, default `false`. Behind a reverse proxy (Caddy, nginx) every request comes from the proxy: with `true` the visitor IP sent to the API is taken from the **last** `X-Forwarded-For` entry, the one the proxy adds (`src/lib/client-ip.ts`). Only if the proxy is the only way in. |
| `PORT`, `HOST`                | at server start      | Of the Node server started by `pnpm start` (`@astrojs/node` standalone).                                                                                                                                                                                                                           |
| `INTI`, `INTI_KITSUDEN_TOKEN` | build / server start | Only for [Inti](#visual-editing-with-inti-optional).                                                                                                                                                                                                                                               |

### `KITSUDEN_SITE_KEY` and the API rate limit

The API limits requests per route and per client IP. Every visitor of this
site reaches the API through this server, so without help they all count as
one client and a busy site can exhaust the limit. Set `KITSUDEN_SITE_KEY` to
the same value as `SITE_API_KEY` in the API: each request then carries the
key (`x-kitsuden-site`) and the visitor's IP (`x-kitsuden-client`), and the
API counts each visitor separately. Behind a reverse proxy, also set
`KITSUDEN_TRUST_PROXY=true`, or every visitor has the proxy's IP. Without the key the IP header is not sent
(the API would ignore it anyway). The key is read at runtime and never written
into the build.

When the API answers 429 or 5xx, or does not answer, the site responds `503`
with `Retry-After` instead of `404`, so search engines do not drop pages
during an outage.

## Structure

```
astro.config.mjs        site, env schema, optional Inti switch
src/
  middleware.ts         API client per request; 503 when the API is down
  lib/kitsuden.ts       typed client: pages, page by slug, posts, post by slug
  lib/media.ts          media ids → same-origin image URLs
  lib/proxy.ts          the image proxy (used by pages/img and pages/media)
  lib/text.ts           Markdown, escaping, safe links, video embeds
  lib/inti-markup.ts    data-inti-* attributes (only for an Inti editor)
  i18n/                 en.ts + t(): add a language by copying en.ts
  blocks/               one component per block type + palette for Inti
  components/           BlockRenderer, Block, PageView, PostList
  layouts/Base.astro    <head> (SEO), header, footer, theme toggle
  pages/
    index.astro         homepage + latest posts
    [slug].astro        any page-builder page
    blog/index.astro    blog list (?page=)
    blog/[slug].astro   one post
    404.astro
    sitemap.xml.ts      built from the API on request
    robots.txt.ts
    img/[id]/[preset].ts   → API /api/media/preset/:id/:preset
    media/[...key].ts      → API /media/:key
  inti/                 stubs used without Inti; inti/live/ is used with INTI=true
tests/
  blocks.test.ts        render test of every block (Astro Container API)
  build.test.mjs        builds with and without Inti and inspects the bundle
  smoke.mjs             end-to-end against a real API
```

### API routes used

All public and read-only:

| Route                                                     | Used for                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/page-builder/pages?limit=100`                   | menu, homepage lookup, sitemap                               |
| `GET /api/page-builder/pages/:slug`                       | a page with its visible blocks                               |
| `GET /api/blog?page=&limit=&locale=`                      | blog list, latest posts, sitemap                             |
| `GET /api/blog/slug/:slug`                                | a post (`blocksHtml` + `content`, both sanitized by the API) |
| `GET /api/media/preset/:id/:preset` and `GET /media/:key` | images (through the proxy)                                   |

`@kitsuden/sdk` is not used: it targets the data explorer and graph APIs and
has no page-builder or blog helpers.

### Images

Images are served from the site's own origin (`/img/<id>/<preset>` and
`/media/<key>`), proxied by the server. The API marks everything under
`/api/*` as `Cross-Origin-Resource-Policy: same-origin`, so a browser would
refuse to paint a preset image linked directly from another origin; the proxy
also keeps the API address private. Presets: `thumbnail`, `small`, `medium`,
`large`, `hero`.

### Blocks

| Type                | Component                | Notes                                                                                                                                                                       |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero`              | `hero.astro`             | headline, text, background image with focal point, two buttons. Also the admin shape (`title`, `subtitle`, `imageUrl`, `ctaLabel`). The first hero of a page is its `<h1>`. |
| `text`, `richtext`  | `text.astro`             | `format`: `html` (default for `text`), `markdown` (default for `richtext`), `plain` (escaped).                                                                              |
| `image`             | `image.astro`            | media id with `srcset`, alt, caption, link.                                                                                                                                 |
| `image-gallery`     | `image-gallery.astro`    | admin editor block.                                                                                                                                                         |
| `video`             | `video.astro`            | YouTube or Vimeo URL, or a `/media/...` file.                                                                                                                               |
| `cards`             | `cards.astro`            | image, title, text, tags, link; 1 to 4 columns.                                                                                                                             |
| `quote`             | `quote.astro`            | author, role, picture.                                                                                                                                                      |
| `cta`               | `cta.astro`              | title, text, one button.                                                                                                                                                    |
| `embed`             | `embed.astro`            | HTML already reduced by the API, or a YouTube/Vimeo `url`.                                                                                                                  |
| `callout`           | `callout.astro`          | admin editor block; Markdown content.                                                                                                                                       |
| `divider`, `spacer` |                          |                                                                                                                                                                             |
| `grid`              | `components/Block.astro` | nested blocks in columns.                                                                                                                                                   |

Any other type (`custom`, or blocks of optional kons such as `tier-list`)
renders nothing in production and a labelled placeholder in `pnpm dev`. To
support one, add `src/blocks/<type>.astro` and register it in
`src/blocks/index.ts`. A block component receives the block's `content` as
props plus `block` (`index`, `isFirst`, `editable`).

Per-block styling stored by the page builder (`backgroundColor`, `textColor`,
`padding`, `cssClass`) is applied to the block's wrapper, only with clean
values.

### Languages

Interface strings live in `src/i18n/en.ts`. To add another language, for example Spanish: copy it to
`src/i18n/es.ts`, translate the values, register it in `src/i18n/index.ts`
and set `SITE_LOCALE=es`. The blog API then returns, for each post, the
version in that language if there is one and the English one otherwise.

## Visual editing with Inti (optional)

[Inti](https://github.com/Kitsuden/inti) adds inline editing on
the real page: an editor double-clicks a heading of a block, types, and the
change is written back to Kitsuden. This starter supports it as an opt-in:

- the site **installs and builds without Inti**. Nothing in `package.json`
  points to Inti, and without `INTI=true` no Inti code is bundled
  (`tests/build.test.mjs` checks it);
- with `INTI=true` **and** `@intijs/core` + `@intijs/adapter-kitsuden`
  installed, the build adds Inti's integration, its write actions
  (`/_actions/inti.*`), a middleware that recognises Kitsuden editors and the
  editor UI. `INTI=true` without the packages stops the build with a message
  that points here.

Public HTML is the same in both modes. Only a request from an editor gets
the `data-inti-*` attributes, the block data and the editor UI, with
`Cache-Control: private, no-store`.

### 1. Install Inti

`@intijs/*` is not published on npm. Two ways:

**From a local clone (developer machine).** Build Inti, then link its two
packages. This changes `package.json` and the lockfile on your machine; do
not commit it, the starter must keep working for people without the clone.

```bash
git clone <inti repository> ../inti
(cd ../inti && npm install && npm run build:core && npm run build:adapter-kitsuden)
pnpm add @intijs/core@link:../inti/packages/core @intijs/adapter-kitsuden@link:../inti/packages/adapter-kitsuden
```

(Adjust the relative path to where the clone is. Inside the Kitsuden
monorepo the starter is three levels deeper: `link:../../../../inti/packages/core`.)

**As a git dependency (pinned commit).** The form for a deployment, added by
the site owner in their own copy of the starter. Use the **same** commit for
both packages, and note the slash after `path:`:

```bash
pnpm add "github:Kitsuden/inti#<commit>&path:/packages/core" \
         "github:Kitsuden/inti#<commit>&path:/packages/adapter-kitsuden"
```

pnpm clones the repository and runs each package's `prepare` script, which
compiles it (`dist/` is not committed). pnpm 9 runs dependency build scripts
by default; **pnpm 10** only runs the ones you allow, so add to the site's
`pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - "@intijs/core"
  - "@intijs/adapter-kitsuden"
```

The starter's own dependencies are pinned with `~` (patch updates only); keep
it that way in your copy so a reinstall does not change Astro under you.

### 2. Create the agent key

Inti writes to the API with a Kitsuden **agent key** that only the site's
server knows. Give it the single scope `content:edit`: it opens the
content writes (the page builder) and nothing else.

In the admin: **Agents → New agent**, scope `content:edit`. Or with an
admin session:

```bash
curl -X POST "$KITSUDEN_API_URL/api/admin/agents" -H 'content-type: application/json' \
  -H 'origin: <admin origin>' -b cookies.txt \
  -d '{"name":"Inti","type":"custom","scopes":["content:edit"]}'
# → 201 {"success":true,"data":{"agent":{…},"apiKey":"kitsuden_agent_…"}}   (shown once)
```

### 3. Build and run

```bash
INTI=true pnpm build                                   # never with the key in the environment
INTI_KITSUDEN_TOKEN=kitsuden_agent_… KITSUDEN_API_URL=http://localhost:3000 pnpm start
```

The key is read when the server starts and never reaches the browser or the
build (`astro.config.mjs` also removes it from the environment while
building). `INTI_ADAPTER` and `INTI_KITSUDEN_ENDPOINT` are filled in
automatically (`kitsuden`, and `KITSUDEN_API_URL`).

### 4. Who sees the editor

- In `pnpm dev` with `INTI=true`, everyone does (it is your machine), but
  writes still require a Kitsuden session with role `admin` or `editor`.
- In production, only a visitor whose browser sends a Kitsuden session cookie
  that the API confirms (`GET /api/auth/get-session`) as `admin` or `editor`.
  The cookie is set by the API for its own host, so the site must receive it:
  locally, run both on `localhost` (cookies ignore the port); in production,
  serve the site and the API under the same host, or configure a cookie for
  the parent domain in the API.
- A write without such a session is refused by the site before any request
  to the API is made.

What can be edited inline: the text fields of `hero`, `quote`, `cta`, `cards`,
`image` captions and `text` blocks in `plain` format. The composer can add,
duplicate, move and delete blocks of the types listed in
`src/blocks/palette.ts`. Markdown/HTML text, `grid` and `custom` are edited in
the admin.

## Tests

```bash
pnpm test           # render test of every block type (vitest + Astro Container API)
pnpm test:build     # builds without Inti (and with it, if installed) and inspects the bundles
SMOKE_API_URL=http://localhost:3000 SMOKE_SITE_URL=http://localhost:4321 pnpm test:smoke
```

`tests/smoke.mjs` runs against a **real** API and a running site. It creates
the first admin if the API has no users (random credentials, never printed;
`SMOKE_CREDENTIALS_FILE=<path>` keeps them for the next run), uploads an image,
creates a page with blocks and a post, checks the site, and deletes what it
created. It refuses to write to anything but localhost unless
`SMOKE_ALLOW_REMOTE=1`: use a throwaway installation. Sign-in sends
`Origin: $SMOKE_ORIGIN` (default `http://localhost:3001`), which must be in the
API's `ALLOWED_ORIGINS`. With a site built with
`INTI=true` and `INTI_KITSUDEN_TOKEN` set, `SMOKE_INTI=1` also checks the
editor markup and a real write through Inti.

## License

MIT, like Kitsuden.
