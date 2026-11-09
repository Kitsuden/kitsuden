# Installing Kitsuden

How to install Kitsuden, a backend built for AI agents (efficient and secure
by default), on a new machine; and, if you want, a public website built from
the starter and the optional Inti layer. Written for someone installing it for
the first time.

**Just want it running on your machine?** `./install.sh` (Windows:
`powershell -ExecutionPolicy Bypass -File install.ps1`) does everything; it only
needs Docker. The guides below are for doing it by hand, on a server, or for
development.

Each command carries its status:

- **(tested 2026-10-15)**: it was run exactly like this on that day, on a clean
  copy with its own Docker stack, and the result is written down.
- **(not tested)**: what it does and why is explained, but it could not be run
  in the test (real domain, TLS, mail…).

A command that changed after that date carries no test mark.

## Contents

|                                                                     |                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [What gets installed](#what-gets-installed)                         | the pieces and the requirements                                                 |
| [Local install](local.md)                                           | for development, on your computer                                               |
| [Server install (Docker)](server.md)                                | the recommended way; includes a VPS, domain and TLS                             |
| [Environment variables](variables.md)                               | one by one: required, optional, and why                                         |
| [First run](first-run.md)                                           | migrations, first administrator (one-time token), enabling kons                 |
| [Installing kons](../kons/installing.md)                            | `kitsuden kon add`, `KITSUDEN_KONS`, kons in the Docker image                   |
| [A website with the starter](starter.md)                            | `kitsuden-starter-basic`: development, build, Docker                            |
| [Connecting Inti](inti.md)                                          | visual editing: adapter, agent key, editor session, cookie                      |
| [Agent permissions, keys and quotas](../agents/permissions.md)      | broad + fine-grained scopes, deny, key rotation, quotas                         |
| [Human approval](../agents/approvals.md)                            | proposals: what an agent may not do without a human, the inbox, the audit       |
| [Upgrades and backups](upgrade-and-backups.md)                      | new code, migrations, backups, restore, rolling back                            |
| [High availability and point-in-time restore](high-availability.md) | WAL archive, base backups, restore to a timestamp, a streaming replica, RPO/RTO |
| [Versions and compatibility](versions.md)                           | semver, API contracts, Kitsuden ↔ Inti matrix                                   |
| [Troubleshooting](troubleshooting.md)                               | symptoms, causes and fixes                                                      |
| [Errors and safe retries](errors-and-retries.md)                    | `problem+json` error codes, `Idempotency-Key`                                   |
| [The request transaction in a kon](kon-transactions.md)             | parallel queries, swallowed SQL errors, slow external calls                     |
| [Background jobs: the Postgres queue](queue.md)                     | outbox, retries, dead letter, Valkey optional, measured throughput              |
| [PgBouncer (transaction mode)](pgbouncer.md)                        | what goes through it, what must go direct, the probe script                     |
| [Runtimes](runtimes.md)                                             | Bun, Node 22+, why not a single binary, why not edge                            |
| [Threat model](../threat-model.md)                                  | what Kitsuden defends against, and what it does not                             |

## What gets installed

```
  browser ──► public website (Astro, starter) ──► Kitsuden API (Bun + Hono) ──► PostgreSQL 16 + pgvector
          └─► admin panel (SvelteKit + nginx) ─┘        │                     └─► Valkey (optional: shared cache)
                                                        └─► /app/data (media, or S3)
  editor  ──► public website with INTI=true ──(agent key)──► API
```

| Piece               | Where it lives                                                                                                                                                         | Required                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| API                 | `apps/api`                                                                                                                                                             | yes                                                                                   |
| Database            | Postgres **16** with the **pgvector** extension (image `pgvector/pgvector:pg16`)                                                                                       | yes                                                                                   |
| Valkey (or Redis 7) | shared cache and rate-limit counters across several API replicas                                                                                                       | no for one API; the root compose file starts it anyway and requires `VALKEY_PASSWORD` |
| Admin panel         | `packages/admin` (static SvelteKit build served by nginx)                                                                                                              | yes, to administer it                                                                 |
| Kons (plugins)      | core: `packages/core/*`; the rest installed with `kitsuden kon add` from the `kitsuden-kons` repository (not public yet) or a registry ([kons](../kons/installing.md)) | the ones you install and enable                                                       |
| Public website      | `packages/starters/kitsuden-starter-basic` (Astro 7, server-rendered)                                                                                                  | no (Kitsuden is headless)                                                             |
| Inti                | a separate repository (`@intijs/*`), installed from git                                                                                                                | no: only for on-page editing                                                          |
| Backups             | the `kitsuden_backup` service (same image as the API)                                                                                                                  | yes in production                                                                     |

The monorepo packages (`@kitsuden/*`) are **not** published on npm (nor on
PyPI), and the Docker images are **not** published to GHCR: the packages are used
from this repository, as a pnpm workspace, and the images are built from it.

### Requirements

**Server with Docker (recommended):**

- Linux x86_64 with Docker Engine 24+ and the `docker compose` v2 plugin.
  Tested with Docker Desktop (Windows, Linux engine) and compose v2; for a VPS,
  Ubuntu 24.04 ([server.md](server.md#7-preparing-a-vps)).
- BuildKit (on by default in a modern Docker): the Dockerfiles use
  `COPY --parents` and cache mounts.
- **Memory to build**: the API image took **21 min** to build in the
  2026-10-15 test (with other load on the machine). 4 GB of RAM is tight: add
  swap ([server.md](server.md#7-preparing-a-vps)).
- Disk: API image ≈ 1.4 GB, panel ≈ 110 MB, plus the build cache (several GB)
  and your media.

**Local development, in addition:**

- [Bun](https://bun.sh) 1.3+ (the API runs on Bun; tested 1.4.4). Install it
  **before** `pnpm install`: the `prepare` script of `@kitsuden/shared` builds
  with Bun.
- Node.js **22.12** or newer (22.23.4+ to build the starter: Astro requires it) and
  **pnpm 9** (`npm i -g pnpm@9.15.4`, the `packageManager` version and the one
  the images use; `pnpm-lock.yaml` is written by it).
- Postgres 16 + pgvector (easiest: the containers in [local.md](local.md)).
  Valkey 9 is optional: only several API replicas need it.
- On **Windows**, a short path for the repository (for example
  `C:\src\kitsuden`): see [troubleshooting.md](troubleshooting.md#installing).

**For Inti:** `@intijs/core` and `@intijs/adapter-kitsuden` (from git, see
[inti.md](inti.md)) and a Kitsuden with `kon-blocks` (pages) and, to edit game
pages, `kon-games`.

## What a production start enforces

The API is stricter when `NODE_ENV=production` (the Docker images) or
`KITSUDEN_PUBLIC=true` (the TLS overlay):

- **No first administrator without the setup token.** While no administrator
  exists, the API prints a one-time token in its log at startup. The panel (or
  `POST /api/system/setup`) needs it, and public sign-up is refused until the
  first administrator exists ([first-run.md](first-run.md#2-the-first-administrator)).
- **Sign-up is closed by default.** `KITSUDEN_SIGNUP` defaults to `closed` in
  production, so strangers cannot create accounts. Set `KITSUDEN_SIGNUP=open`
  only for a site with public accounts ([variables.md](variables.md)).
- **Placeholder secrets are refused.** The API does not start while
  `BETTER_AUTH_SECRET`, `KITSUDEN_SECRETS_KEY`, `SITE_API_KEY` or
  `APP_DB_PASSWORD` still holds a value copied from an example file (something
  starting with `<`, or containing `changeme`, `generate`…). Generate each one
  with `openssl rand -hex 32`.
- **Valkey has a password.** The root `docker-compose.yml` requires
  `VALKEY_PASSWORD`; compose refuses to start without it.
- **The panel container listens on 8080.** It is published on host port 3001 by
  default (`ADMIN_PORT`); an overlay that points at the container directly must
  use port 8080, not 80.

## Known caveats

- **Fixed names in the compose file.** `container_name`, volumes with `name:` and
  the `kitsuden_net_prod` network are fixed: only **one** installation fits on a
  machine. A second one (for testing) needs an overlay that renames them
  ([server.md](server.md#a-second-installation-on-the-same-machine)).
- **`docker compose up` without `-f` merges `docker-compose.override.yml`**
  wherever that file exists (it is a local development file, not in a clean
  clone; it starts SeaweedFS). On a server always use `-f docker-compose.yml`
  (plus the TLS overlay).
- **Kons are not in the clone.** A fresh clone has no kon; install the ones you
  want ([../kons/installing.md](../kons/installing.md)).
- **Inti is installed from git**, not from npm ([inti.md](inti.md)).
