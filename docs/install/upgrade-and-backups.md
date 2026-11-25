# Upgrades and backups

## What has to be kept

| What              | Where it lives                                         | How it is copied                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database          | volume `kitsuden_postgres_prod`                        | automatic `pg_dump -Fc` (the `kitsuden_backup` service)                                                                                                                          |
| Uploaded media    | volume `<project>_kitsuden_uploads_prod` (`/app/data`) | automatic tar every `BACKUP_MEDIA_DAYS` days                                                                                                                                     |
| `.env`            | repository root                                        | **by hand**, off the server and encrypted: without `KITSUDEN_SECRETS_KEY` (or `BETTER_AUTH_SECRET` if you did not set it) the secrets stored in the database cannot be decrypted |
| TLS certificates  | `kitsuden_caddy_data`                                  | not needed: Caddy requests them again                                                                                                                                            |
| Generated secrets | volume `<instance>_secrets_prod`                       | **by hand**, like `.env`: the passwords and keys the stack generated because `.env` did not set them. See below                                                                  |

### The secrets volume

Every password and key left out of `.env` is generated on the first start and
kept in the `<instance>_secrets_prod` volume (`docker/generate-secrets.sh`).
Without a copy, a lost disk loses `KITSUDEN_SECRETS_KEY` (the credentials sealed
in the database cannot be opened) and the database passwords (a restored dump
still works: the start script sets the roles' passwords again). Copy it off the
server, encrypted, after the first start and whenever you change one:

```bash
docker run --rm -v kitsuden_secrets_prod:/s:ro -v "$PWD":/out alpine \
  tar czf /out/kitsuden-secrets.tgz -C /s .
# then encrypt it (age, gpg) and move it off the machine; delete the plain file
```

Restoring is the reverse, into an empty volume, before the first `up`. To keep
the secrets in `.env` instead (the older way, what `install.sh` does), write them
there: a value in `.env` always wins and is copied into the volume.

The automatic backups do **not** include this volume on purpose: a dump and the
key that opens its sealed credentials should not travel together.

## Automatic backups

`kitsuden_backup` (same image as the API) runs in a loop **(tested
2026-10-15)**. For each dump its log gives the file name
(`kitsuden-2026-10-15T18-29-49.dump`), its size, the number of objects and the
time taken, then confirms it was checked with `pg_restore --list`. The media
copy logs the archive it writes.

- The dump is made with the **superuser** (with the app role `pg_dump` would
  fail because of RLS) and checked with `pg_restore --list` right after it is
  written; `BACKUP_KEEP` dumps are kept.
- After the dump, `docker/media-backup.sh` copies the media volume (mounted
  read-only) every `BACKUP_MEDIA_DAYS` days and keeps `BACKUP_MEDIA_KEEP`.
- The healthcheck turns "unhealthy" if the last good backup is too old.
- On a new installation the **first** backup is taken before the API has
  finished migrating (in the test: 1 KB, 2 objects). That is normal; the next
  one has everything. To force one:

```bash
docker exec -w /app/apps/api kitsuden_backup_prod bun run scripts/backup.ts
docker exec kitsuden_backup_prod ls -la /backups
```

**Everything stays in the `kitsuden_backups_prod` volume, on the same disk.**
It protects against a deletion or a broken migration, not against losing the
machine. For that, copy them elsewhere (provider snapshots, or `rclone` to
object storage from a cron job on the host) and **try a restore** now and
then. An example **(not tested)**:

```bash
# /etc/cron.d/kitsuden-offsite  (with rclone already configured as "offsite:")
30 5 * * * root rclone sync /var/lib/docker/volumes/kitsuden_backups_prod/_data offsite:kitsuden-backups --max-age 15d
```

A dump restores the database as it was at the moment of the dump: up to a day of
writes is lost. To restore to **any moment** (just before a bad `DELETE`), turn
on `KITSUDEN_PITR=on`: WAL archiving plus weekly base backups. See
[High availability and point-in-time restore](high-availability.md). With it on,
copy `kitsuden_wal_archive_prod` off the machine as well.

## Restoring the database

The dumps are made by the `pg_dump` of the API image, which is **newer than
the server** (17 or later depending on when the image was built; in the test,
`pg_dump (PostgreSQL) 18.6` against Postgres 16). The `pg_restore` of the
Postgres 16 image **cannot read them** (`unsupported version … in file
header`): always restore with the API image.

**(tested 2026-10-15)**, into a new database next to the existing one:

```bash
# 1. empty target database
docker exec kitsuden_db_prod sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE kitsuden_restored"'

# 2. pg_restore from the API image, on the stack's network
docker run --rm --network kitsuden_net_prod -v kitsuden_backups_prod:/b:ro --env-file .env \
  --entrypoint sh ghcr.io/kitsuden/kitsuden/api:latest -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h kitsuden_db_prod -U "$POSTGRES_USER" -d kitsuden_restored -j 4 /b/kitsuden-YYYY-MM-DDTHH-MM-SS.dump'
```

Expected result: two `unrecognized configuration parameter
"transaction_timeout"` errors (a `SET` from pg_dump ≥ 17 that Postgres 16 does
not know; harmless), and `pg_restore` exits with code 1 because of them.
Check: the same counts in both databases (in the test: 80 tables, 61 rows in
`kitsuden_migrations`, 1 game, 1 page, 1 user in both).

To **replace** the database in use:

```bash
docker compose -f docker-compose.yml stop kitsuden_api kitsuden_backup
# either --clean --if-exists in pg_restore, or DROP DATABASE + CREATE DATABASE first
# … restore into POSTGRES_DB as above …
docker compose -f docker-compose.yml up -d
```

On start, the API applies the migrations the backup did not have and grants
the app role its permissions again. If the `kitsuden_app` role does not exist
on a new server, create it first (`CREATE ROLE kitsuden_app NOLOGIN`): the
restored tables carry its `GRANT`s. If the target's `POSTGRES_USER` is
different, add `--no-owner --role=<user>`.

### Moving the data to another machine

The same, with a copied dump:

```bash
# source: take the latest dump out of the volume
docker run --rm -v kitsuden_backups_prod:/b:ro -v "$PWD":/out alpine \
  sh -c 'cp "$(ls -1 /b/kitsuden-*.dump | tail -1)" /out/'
scp kitsuden-*.dump user@server:/tmp/
```

On the target, **before** the first full start: build the API image, start
only `kitsuden_db`, create the app role (`CREATE ROLE kitsuden_app NOLOGIN`)
and restore with the API image's `pg_restore` as above, mounting `/tmp`
instead of the backup volume. On start, the API applies whatever migrations
the backup is missing.

## Restoring the media

```bash
docker run --rm -v <project>_kitsuden_uploads_prod:/d -v kitsuden_backups_prod:/b:ro alpine \
  sh -c 'tar -xf /b/media-YYYY-MM-DDTHH-MM-SS.tar -C /d && chown -R 1000:1000 /d && find /d -type f | wc -l'
```

Archives written by earlier versions are named `medios-<date>.tar`; they restore the same way.

**(not tested in this guide; a byte-for-byte restore was tested on
2026-10-12.)** The `chown` is essential: the API runs without root (uid 1000)
and without it uploads from the panel fail.

---

## Upgrading

### Breaking changes in the compose stack

From 0.9.0-beta onwards:

- An existing `.env` needs one new line, or compose refuses to start:
  `VALKEY_PASSWORD=<openssl rand -hex 32>`. Valkey keeps its data; only the
  password changes.
- Add `DDL_DB_PASSWORD=<openssl rand -hex 32>` too, unless you already pass
  `DATABASE_DDL_URL` with an overlay: without it, enabling a kon from the panel fails.
- If an overlay names a container (`kitsuden_api_prod`…) as a host, use the service
  name (`kitsuden_api`): the panel, Caddy and the website now do, because the
  container's name depends on `KITSUDEN_INSTANCE`.
- The panel container now listens on 8080 instead of 80: update any overlay that
  points at `kitsuden_admin_prod:80`.
- In production the API refuses to start while `BETTER_AUTH_SECRET`,
  `KITSUDEN_SECRETS_KEY`, `SITE_API_KEY` or `APP_DB_PASSWORD` holds a
  placeholder copied from an example file.
- Public sign-up (`/api/auth/sign-up/*`) is closed by default in production
  (`KITSUDEN_SIGNUP`). A site that relies on public accounts must set
  `KITSUDEN_SIGNUP=open` before upgrading.
- On an installation that has no administrator yet, the first one needs the
  one-time setup token from the API log ([first-run.md](first-run.md#2-the-first-administrator)).

After 0.9.0-beta (security review 2026-11-03):

- **`KITSUDEN_SECRETS_KEY` is required in production** (and with
  `KITSUDEN_PUBLIC=true`): the API refuses to start without it. Before, it was
  derived from `BETTER_AUTH_SECRET`, so one value signed sessions and decrypted
  the stored secrets (the secrets manager, data source passwords, agent
  notification secrets). `.env` files made by `install.sh`/`install.ps1` already
  have it. If yours does not, pick one:
  1. **Re-encrypt (recommended).** Back up the database, add
     `KITSUDEN_SECRETS_KEY=<openssl rand -hex 32>` to `.env`, recreate the API
     container, and run once, with the admin connection:
     ```bash
     docker exec <api-container> sh /app/docker/as-admin.sh bun run scripts/rekey-secrets.ts --dry-run
     docker exec <api-container> sh /app/docker/as-admin.sh bun run scripts/rekey-secrets.ts
     ```
     The old key is derived from `BETTER_AUTH_SECRET` (or `KITSUDEN_SECRETS_KEY_OLD`
     when rotating from another key). It runs in one transaction: a row that
     decrypts with neither key aborts it and nothing changes; running it twice is
     harmless. Until it has run, stored secrets do not decrypt.
  2. **Keep them as they are.** Set `KITSUDEN_SECRETS_KEY` to the current value of
     `BETTER_AUTH_SECRET`: the derivation is the same, so everything decrypts. The
     API starts with a warning, and the two secrets are still one.
- **New agent keys expire after 90 days** unless created with
  `"expiresInDays": null` (`AGENT_KEY_DEFAULT_EXPIRY_DAYS`, `0` restores the old
  behaviour). Existing keys keep their expiry.
- **Valkey gets its password on stdin**, not on the command line; nothing to do.

From the one-compose install onwards:

- **Secrets are generated.** A new `kitsuden_secrets` service fills what `.env`
  does not set. An existing `.env` keeps working unchanged: its values win and
  are copied into the new volume. Back that volume up ([above](#the-secrets-volume)).
- **The API container starts as root** (`user: "0:0"`) only to read those root-only
  files; its start script drops to `bun` before anything else runs, so the API
  still serves as uid 1000. The image gains `su-exec`: rebuild it with the
  compose files of the same version (an older image refuses to start as root).
- **The TLS overlay is split in two.** `docker-compose.public.yml` holds the
  public URLs, the website and the limits; `docker-compose.tls.yml` only Caddy.
  Replace `-f docker-compose.yml -f docker-compose.tls.yml` with
  `-f docker-compose.yml -f docker-compose.public.yml -f docker-compose.tls.yml`
  in your own scripts (`scripts/deploy.sh` already does), or set
  `COMPOSE_FILE` in `.env`. With the old command compose stops at once: Caddy
  depends on the website, which is now in the public file.
- **The website listens on `127.0.0.1:4321`** (`WEB_PORT`), for a proxy on the
  host. Nothing reaches it from outside.
- New, optional: `KITSUDEN_ENABLE_KONS` (which kons come on at the first start),
  `KITSUDEN_WORKERS` and the `workers` profile ([../kons/workers.md](../kons/workers.md)).

### Before

1. Read the release notes and the [compatibility matrix](versions.md#compatibility-matrix):
   if a **contract** your Inti uses is bumped, update
   `@intijs/adapter-kitsuden` too.
2. Take a backup **and check that it reads**:

   ```bash
   docker exec -w /app/apps/api kitsuden_backup_prod bun run scripts/backup.ts
   ```

3. Tag the image that works, so you can go back:

   ```bash
   docker tag ghcr.io/kitsuden/kitsuden/api:latest ghcr.io/kitsuden/kitsuden/api:before-$(date +%F)
   docker tag ghcr.io/kitsuden/kitsuden/admin:latest ghcr.io/kitsuden/kitsuden/admin:before-$(date +%F)
   ```

### Upgrade (Docker)

```bash
cd /opt/kitsuden                 # new code: git pull
C="docker compose -f docker-compose.yml"          # or with -f docker-compose.public.yml -f docker-compose.tls.yml in public mode
$C build kitsuden_api kitsuden_admin              # + kitsuden_web with the TLS overlay
$C up -d
$C logs -f kitsuden_api                           # until "[6/6] Setup complete"
curl -s http://127.0.0.1:3000/api/version         # the new version and its contracts
```

- The API **migrates by itself** on start (step `[4/6]`); if a migration
  fails, the container does not start and the log names it. Nothing has to be
  run by hand.
- `kitsuden_backup` uses the API image: `up -d` recreates it with the new one.
- If `up -d` does not recreate a container (Docker had restarted it on its
  own), compare `docker inspect kitsuden_api_prod --format '{{.Image}}'` with
  `docker image inspect ghcr.io/kitsuden/kitsuden/api:latest --format '{{.Id}}'`.
- The TLS overlay's **website** writes `SITE_URL`, `SITE_NAME` and
  `SITE_LOCALE` at build time: changing `SITE_DOMAIN` (or those names) needs a
  rebuild of `kitsuden_web`.
- In public mode, `./scripts/deploy.sh` does the `build` and the `up -d` of
  everything (with your `KITSUDEN_OVERLAYS`) without stopping what is serving
  while it builds.
- If the new version adds kons you want, enable them afterwards
  ([first-run.md](first-run.md#3-enabling-kons)).
- If the media volume comes from an image that ran as root, do the
  `chown -R 1000:1000` from [server.md](server.md#the-api-runs-without-root-uid-1000)
  first.

**(Not tested as a real upgrade in this guide**: the build, the start with
migrations and the API restart were tested separately; not with the TLS
overlay.)

### Upgrade (local)

```bash
git pull
pnpm install --frozen-lockfile
pnpm --filter @kitsuden/shared build
cd apps/api && bun run scripts/migrate.ts
```

### Upgrade (published images, no build)

A project made with `create-kitsuden` (or any install that sets
`KITSUDEN_API_IMAGE` and `KITSUDEN_ADMIN_IMAGE`) builds nothing: change the
version in `.env` and pull.

```bash
# .env: the new tag on both lines, never `latest`
KITSUDEN_API_IMAGE=ghcr.io/kitsuden/kitsuden/api:1.2.0
KITSUDEN_ADMIN_IMAGE=ghcr.io/kitsuden/kitsuden/admin:1.2.0
```

```bash
docker compose pull kitsuden_api kitsuden_admin
docker compose up -d
docker compose logs -f kitsuden_api     # until "[6/6] Setup complete"
```

Take the compose files of the same version too (`create-kitsuden` writes them
for its version): an image and compose files from different versions can
disagree on what the start needs. [verify-images.md](verify-images.md) checks
the signature before you pull.

### Rolling back

Going back is the same three things in reverse: the image, the compose files,
and the database if the new version migrated it.

1. **The image.** With published images, put the previous tag back in `.env`
   and `docker compose up -d`. With images built here, restore the tag you made
   before upgrading:

   ```bash
   docker tag ghcr.io/kitsuden/kitsuden/api:before-YYYY-MM-DD ghcr.io/kitsuden/kitsuden/api:latest
   docker compose -f docker-compose.yml up -d --no-deps kitsuden_api kitsuden_backup
   ```

2. **The compose files**, from the same version as that image
   (`git checkout <previous tag> -- docker-compose*.yml docker/`).
3. **The secrets stay.** Never delete the secrets volume to roll back. A version
   that predates it reads the secrets only from `.env`, so if your `.env` has
   none of them, append them there first (nothing is printed to the terminal):

   ```bash
   docker run --rm -v kitsuden_secrets_prod:/s:ro alpine sh -c '
     for p in postgres_password=POSTGRES_PASSWORD app_db_password=APP_DB_PASSWORD \
              ddl_db_password=DDL_DB_PASSWORD valkey_password=VALKEY_PASSWORD \
              better_auth_secret=BETTER_AUTH_SECRET kitsuden_secrets_key=KITSUDEN_SECRETS_KEY \
              site_api_key=SITE_API_KEY; do
       printf "%s=%s\n" "${p#*=}" "$(cat "/s/${p%%=*}")"
     done' >> .env
   ```

Migrations are **not undone** by themselves: if the new version migrated the
database and the old one does not understand the schema, restore the backup
from before ([above](#restoring-the-database)). That is why the backup comes
first.
