# Local install (development)

For working on the code: the API runs with Bun on your machine, and the
database (and, if you want it, Valkey) run in containers. If you only want to **use** Kitsuden,
the [Docker install](server.md) is simpler, also on your own computer.

What is marked **(tested)** was run on **2026-10-15** on a clean copy of the
folder (Windows 11 + Git Bash, Docker Desktop, Bun 1.3.14, Node 22.19,
pnpm 9.15.4), with ports different from the ones below so as not to clash
with the existing installation.

## 1. Code and dependencies

```bash
git clone https://github.com/Kitsuden/kitsuden.git ~/src/kitsuden
cd ~/src/kitsuden
# Bun 1.3+ BEFORE pnpm install: the prepare script of @kitsuden/shared builds with Bun
npm i -g pnpm@9.15.4          # the lockfile's version, also used by the images
pnpm install --frozen-lockfile
```

**(tested 2026-10-15** on a copy of the folder, not on a clone**)**: 5 min
50 s with an empty pnpm cache for this project (1,321 packages). Expected
warning:

- `Failed to create bin … kitsuden-mcp … standalone.js` — the MCP server
  binary does not exist until it is built; it does not affect the API.

`pnpm install` also builds `@kitsuden/shared` (its `prepare` script). If you
change `packages/shared/src`, build it again: the API imports it from `dist/`.

```bash
pnpm --filter @kitsuden/shared build      # ✅ @kitsuden/shared — 102 KB
```

> **Windows**: keep the repository on a short path (`C:\src\kitsuden`). With
> the folder inside `AppData\Local\Temp\…` the API did not start: `sharp`
> could not load its DLL (the Windows "file name or extension is too long"
> error). `subst` does not fix it (Bun resolves the real path). See
> [troubleshooting.md](troubleshooting.md).

## 2. Postgres (and Valkey, optional)

With the repository's development containers:

```bash
pnpm dev:infra        # docker compose -f docker-compose.dev.yml up -d
```

(Postgres :5432, Valkey :6379 and SeaweedFS for S3, on 127.0.0.1; it needs
`POSTGRES_PASSWORD`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` in the root `.env`.)

**Two checkouts on one machine:** give the second one its own `KITSUDEN_INSTANCE`
and ports in its root `.env` (for example `KITSUDEN_INSTANCE=kitsuden2`,
`POSTGRES_PORT=5442`, `VALKEY_PORT=6389`, `MINIO_PORT=9010`, `MINIO_CONSOLE_PORT=9011`).
Container, volume and network names start with the instance (`kitsuden2_db`,
`kitsuden2_postgres_data`…), so the two never share a container or a database.
Without it, the names are the usual `kitsuden_*`, and an existing setup keeps its
data.
Or by hand and with your own names (what the test did) **(tested)**:

```bash
docker run -d --name kitsuden_dev_db -e POSTGRES_USER=kitsuden -e POSTGRES_PASSWORD=<pass> \
  -e POSTGRES_DB=kitsuden_dev -p 127.0.0.1:5432:5432 pgvector/pgvector:pg16
docker run -d --name kitsuden_dev_state -p 127.0.0.1:6379:6379 valkey/valkey:7-alpine
docker exec kitsuden_dev_db pg_isready -U kitsuden -h 127.0.0.1    # repeat until "accepting connections"
```

You need the image **with pgvector** (`pgvector/pgvector:pg16`): with a
Postgres without the extension, the migrator refuses before it starts (it
checks `pg_available_extensions`).

**Do not** point it at the database of a running installation: the development
stack uses the same ports as the production one.

## 3. `apps/api/.env`

```bash
cp apps/api/.env.example apps/api/.env
```

and keep at least (each one explained in [variables.md](variables.md#api-without-docker-appsapienv)):

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://kitsuden:<pass>@127.0.0.1:5432/kitsuden_dev
# REDIS_URL=redis://127.0.0.1:6379   # optional: only several API replicas need it
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=http://localhost:3000
ADMIN_URL=http://localhost:5173
ALLOWED_ORIGINS=http://localhost:4321,http://localhost:5173
DEFAULT_STORAGE_PROVIDER=local
```

`PORT` matters: without it the API listens on **3001** (the default in
`apps/api/src/index.ts` and `src/lib/config.ts`), which clashes with the
Docker admin panel. `apps/api/.env.example` already sets `PORT=3000`, the port
Docker, the starter and this guide use.

Use `127.0.0.1` in connection URLs: on Windows `localhost` may resolve to
`::1`, and ports published by Docker only listen on IPv4.

## 4. Migrations

```bash
cd apps/api
bun run scripts/migrate.ts          # = pnpm db:migrate from the root
```

**(tested)**: 59 migrations in 1 min 40 s, then RLS (the log says RLS is
active on 9 tables, 9 with FORCE) and a warning that is expected in
development:

```
!  The connection uses 'kitsuden', which is a SUPERUSER, and there is no
   DATABASE_ADMIN_URL defined: the API will serve with this SAME account.
```

It means the API will serve with the same superuser account. That is fine for
development; in production the API runs with a non-superuser role (Docker sets
it up). More about the migrator (and the `--baseline` rule for databases that
already existed) in [first-run.md](first-run.md#migrations).

**Do not** use `pnpm db:push` (it pushes the Drizzle schema without going
through the migration history) or `--all-kons` (a CI check: it creates
the tables of every kon).

## 5. Start the API

```bash
cd apps/api
bun run dev                          # bun --watch src/index.ts
```

**(tested)** with `bun run src/index.ts`: `/live` answers within seconds; the
kons take a little longer to mount (in the log, `✅ kon-blocks [kon, modern] →
/api/page-builder`). Check:

```bash
curl -s http://127.0.0.1:3000/live                                   # 200
curl -s http://127.0.0.1:3000/api/system/init-check                  # {"initialized":false}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/page-builder/block-types   # 200
```

In the first test, with the machine heavily loaded (two Docker builds at the
same time), the kons did **not** mount: the startup queries ran out of pool
connection time (`Connection terminated due to connection timeout`) and
`/api/page-builder/*` returned 404. Restarting the API with the machine idle
fixed it. See [troubleshooting.md](troubleshooting.md#kons-do-not-mount-404-on-their-routes).

## 6. The admin panel

```bash
pnpm dev:admin                       # Vite on http://localhost:5173 (not tested in this guide)
```

The API's `ADMIN_URL` and `ALLOWED_ORIGINS` must include that origin.

## 7. First administrator and kons

Same as with Docker: [first-run.md](first-run.md). With the panel on Vite
(`http://localhost:5173`) the sign-up screen appears while there is no
administrator; `POST /api/system/setup` against the API works too. In development
the API listens on 127.0.0.1 by default, and there the setup token that it prints
in its log is optional. With `HOST=0.0.0.0` (to reach it from another device) the
token is required and sign-up is closed unless `KITSUDEN_SIGNUP=open`.

## 8. A website

[starter.md](starter.md): `pnpm --filter @kitsuden/starter-basic dev` with
`KITSUDEN_API_URL=http://localhost:3000` in the starter's `.env`.
