# Troubleshooting

Ordered by when they show up. The ones marked **(seen)** came up while preparing
this guide.

## Installing

### `pnpm install` fails in the `prepare` script of `@kitsuden/shared`

It builds with Bun: install [Bun](https://bun.sh) 1.3+ before `pnpm install`.

### With `INTI=true` the website build stops

`@intijs/core` and `@intijs/adapter-kitsuden` are missing: install them from
git ([inti.md](inti.md#1-what-you-need)). With pnpm 10, also
`onlyBuiltDependencies` in the website's `pnpm-workspace.yaml`.

### A website copied inside `packages/starters/` breaks the root `pnpm install`

The root workspace only includes `packages/starters/kitsuden-starter-*`. A
folder with another name is left out: give it its own `pnpm-workspace.yaml`
and lockfile ([starter.md](starter.md#inside-the-monorepo)).

### Windows: `Could not load the "sharp" module …` with a "file name too long" error

The `sharp` DLL does not load from a very long path (seen with a repository
under `AppData\Local\Temp\…`). Move the repository to a short
path (`C:\src\kitsuden`). `subst` is not enough: Bun resolves the real path.
**(seen)**

### `Failed to create bin … kitsuden-mcp`

A pnpm warning: the MCP server binary does not exist until it is built.
Harmless for the API. **(seen)**

## Building the images

### The API image contains nginx

`docker/Dockerfile.prod` was built without `--target api`. Use
`docker compose … build kitsuden_api`.

### `docker compose up` starts SeaweedFS or asks for S3 keys

Without `-f`, compose merges `docker-compose.override.yml` (development) if it
exists. Use `-f docker-compose.yml` (and `-f docker-compose.tls.yml` in
public mode).

### `… is already in use by container "kitsuden_db_prod"` (or another `*_prod`)

There is already an installation on the machine with the same prefix. For a
second one, set `KITSUDEN_INSTANCE` (`./install.sh` does it by itself): see
[server.md](server.md#a-second-installation-on-the-same-machine). **Never** start
it with the same prefix: it would share the other one's named volumes.

## Starting the API

### The start aborts at step `[0/6]`: the public configuration is not ready

Public mode
(`KITSUDEN_PUBLIC=true`, TLS overlay) with some URL on localhost, `http`
instead of `https`, no mail transport, a `MAIL_FROM` without a real domain, or
a `BETTER_AUTH_SECRET` shorter than 32 characters. The log says which. It is
on purpose: these would fail later, in front of a user.

### PostgreSQL answers but rejects the user

`password authentication failed for user "…"`. (Step `[1/6]` tells this apart
from a **database** that does not exist: step `[2/6]` creates that one, and if
it cannot, it says so.) The Postgres image creates
`POSTGRES_USER`/`POSTGRES_PASSWORD` **only** when it initialises an empty
volume; if you changed them later, the volume still has the old ones. Go back
to the original values, create the new user with the old one, or (deleting
everything) `docker compose down -v`. The startup log explains the three
ways.

### The API exits at startup: a secret "still holds a placeholder"

In production (and with `KITSUDEN_PUBLIC=true`) the API refuses to start while
`BETTER_AUTH_SECRET`, `KITSUDEN_SECRETS_KEY`, `SITE_API_KEY` or
`APP_DB_PASSWORD` has a value copied from an example file. The log names the
variables (never their values). Generate each one with `openssl rand -hex 32`.

### `S3_ACCESS_KEY: Required`

An API image built before those keys became optional with local storage, or
`DEFAULT_STORAGE_PROVIDER=s3` without them. Rebuild, or set the keys
([variables.md](variables.md)).

### The API container does not start after a migration

Step `[4/6]` stops the start if a migration fails or if the resulting schema
lacks what the code declares (`verify-schema.ts`). The log names the
migration or the table. Do not "fix" it by skipping the step: restore the
previous backup or correct the migration with a **new** one (applied ones are
never edited: the migrator refuses if the checksum changes).

### The start aborts at step `[4.5/6]`: isolation between users is not being applied

The app role is a superuser, has `BYPASSRLS`, or a table was left without
`FORCE ROW LEVEL SECURITY`. It is not a false positive: with that, one user's
data would be served to another.

### Kons do not mount (404 on their routes)

- The kon is not enabled: `GET /api/modules` (with an admin session) and
  enable it ([first-run.md](first-run.md#3-enabling-kons)).
- Start with a slow database: the log has
  `Connection terminated due to connection timeout` and no `✅ kon-…`. It
  happened locally with the machine saturated (two builds at once);
  restarting the API fixed it. **(seen)**
- Docker restarted the stack and the container still runs the **previous**
  image: compare `docker inspect <api> --format '{{.Image}}'` with
  `docker image inspect ghcr.io/kitsuden/kitsuden/api:latest --format '{{.Id}}'`.

### `/health` answers 503 or takes seconds

It runs deep checks (database, cache, queue). To know whether the process is
alive, use `/live` (at the root, without `/api`). The Docker healthcheck uses
`/live`.

## First use

### `POST /api/system/setup` → `401 Session required`

An old API image: rebuild. With the current code the route works while there is
no administrator; afterwards it answers `403 System already initialized`.

### `POST /api/system/setup` → `403 Invalid or missing setup token`

The one-time token that the API prints in its log when it starts without an
administrator: `docker compose logs kitsuden_api | grep -A4 "No administrator"`.
A restart generates a new one.

### Nobody can sign up on the site

In production `KITSUDEN_SIGNUP` defaults to `closed`: public sign-up is
rejected on purpose. Set `KITSUDEN_SIGNUP=open` if the site has public accounts
([variables.md](variables.md)). The first administrator and agent keys do not
depend on it.

### Sign-in works in the panel but not on the website

The website's origin is not in the API's `ALLOWED_ORIGINS`. Pages still load;
only what uses the session fails.

### Images do not show on the website

The starter serves images from its own origin (`/img/…`, `/media/…`) and asks
`KITSUDEN_API_URL` for them. If that server cannot reach the API (on Windows,
`localhost` versus `127.0.0.1`/`::1`), images come out empty: try the other
form of the host.

### Images do not show in production after a restore

The database may hold absolute URLs of the source machine
(`http://localhost:3000/media/…`, written by loaders or older versions; the
current API stores a relative `/media/…`). `docker/sql/change-media-domain.sql`
rewrites them in one transaction (usage in its header).

### Uploads from the panel fail after restoring the media

The volume is missing `chown -R 1000:1000`: the API runs without root.

### The website starts answering errors after a while of traffic

Without `SITE_API_KEY` in the API and the same value in the website's
`KITSUDEN_SITE_KEY`, the whole website counts as a single client for the
300 requests/min limit. Behind a proxy, also set `KITSUDEN_TRUST_PROXY=true`
on the website (otherwise every visitor has the proxy's IP).

## Inti

See the table in [inti.md](inti.md#5-common-problems): a key that does not
authenticate, 401 after enabling a kon at runtime, nobody sees the editor in
production (cookie), incompatible contracts or a disabled kon.

## Backups

### `pg_restore: unsupported version (1.16) in file header`

You restored with the `pg_restore` of the Postgres 16 image. Use the one in
the API image ([upgrade-and-backups.md](upgrade-and-backups.md#restoring-the-database)).

### `unrecognized configuration parameter "transaction_timeout"`

Harmless: `pg_dump` ≥ 17 against Postgres 16. `pg_restore` exits with code 1
because of those lines, but restores everything. **(seen)**

### The first backup is 1 KB

It was taken while the API was still migrating (they start together). The
next one has everything; force one with `bun run scripts/backup.ts` inside
`kitsuden_backup`. **(seen)**
