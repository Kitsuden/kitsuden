# First run

What the API does by itself the first time, how to create the first
administrator and how to enable kons. Tested on **2026-10-15** on a new Docker
installation (empty volumes) and on a local one.

## 1. What the first start does by itself

In Docker, the API container runs `docker/start-with-check.sh` before it
listens. In the log (`docker compose -f docker-compose.yml logs kitsuden_api`)
**(tested 2026-10-15)**:

| Step            | What it does                                                                                                                                                                                                        | If it fails                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `[0/6]`         | With `KITSUDEN_PUBLIC=true`, checks public URLs, mail, the secret's length and that no secret still holds an example-file placeholder                                                                               | aborts (on purpose)                                                                                        |
| `[1/6]`         | Waits for Postgres and tries to **authenticate** against the `postgres` maintenance database                                                                                                                        | tells "the user is rejected" (and explains the changed-user case) apart from "the database does not exist" |
| `[2/6]` `[3/6]` | Creates the database and the `vector` extension if missing                                                                                                                                                          | if `CREATE DATABASE` fails, it stops with that error instead of going on                                   |
| `[4/6]`         | Creates the app role if missing, because migrations grant it permissions. `apps/api/scripts/migrate.ts` with the superuser: the full migration chain (core + active kons) and RLS policies; then `verify-schema.ts` | **stops the start**: a half-built schema does not start                                                    |
|                 | Creates/updates the app role (`APP_DB_USER`) with its `GRANT`s and `ALTER DEFAULT PRIVILEGES`                                                                                                                       | —                                                                                                          |
| `[4.5/6]`       | `verify-rls.ts`: with a non-existent user, the isolated tables must return 0 rows                                                                                                                                   | **stops the start**                                                                                        |
| `[5/6]`         | Registers the kons installed in the image (`packages/kons`; a fresh clone has none)                                                                                                                                 | warns and goes on                                                                                          |
| `[6/6]`         | Starts the API                                                                                                                                                                                                      | —                                                                                                          |

On a new installation the core modules are enabled: **kon-media, kon-datasets
and kon-blocks** (pages, `/api/page-builder`). Kons you have installed follow
the seed in `apps/api/kitsuden.config.ts`: the essential and common ones
(**kon-blog, kon-analytics, kon-members, kon-newsletter, kon-crm and
kon-payments**) start enabled, the specialized ones (for example **kon-games**)
start disabled.

The default image carries the core only. Everything else is a kon you add first:
see [Installing kons](../kons/installing.md). Turning on a kon that is not
installed answers `409` and says how to install it.

## Migrations

- In Docker there is nothing to do: every start applies the pending ones.
- Outside Docker: `cd apps/api && bun run scripts/migrate.ts` (or `pnpm db:migrate`).
- The history is in the `kitsuden_migrations` table (name, checksum,
  duration). An applied migration is **never edited**: the migrator refuses if
  its checksum changes.
- **A database that already existed without that history** (set up by hand or
  with another tool): first run `bun run scripts/migrate.ts --baseline`, which
  marks what is present as applied without running it. Without it, it would
  try to apply everything again.
- **Never** `--all-kons` on a server (it creates the tables
  of every kon; it is a CI check) or `pnpm db:push`.

## 2. The first administrator

With **no administrator**, the panel (`http://localhost:3001`, or
`https://panel.your-domain`) opens the sign-up screen for the first
administrator, which calls `POST /api/system/setup`. That route only works
while there is no admin (afterwards it answers `403 System already initialized`)
and creates the account as `admin` with the email already verified (a new
installation cannot send mail yet). Public sign-up is refused until then.

With `NODE_ENV=production`, `KITSUDEN_PUBLIC=true`, or an API that listens
beyond loopback (`HOST=0.0.0.0`, `::` or a LAN address) it also needs the one-time
**setup token** that the API prints in its log when it starts without an admin.
Only a development API on 127.0.0.1/`::1` (the default outside production since
2026-11-04) skips it, and then the panel does not ask for it. A
restart generates a new one; with several replicas, each prints and accepts its
own, so scale to one for this step.

```bash
docker compose -f docker-compose.yml logs kitsuden_api | grep -A4 "No administrator"   # the token
curl -s http://127.0.0.1:3000/api/system/init-check     # {"initialized":false,"setupTokenRequired":true}
```

Without the panel, through the API:

```bash
curl -s -X POST http://127.0.0.1:3000/api/system/setup \
  -H 'content-type: application/json' -H 'origin: http://localhost:3001' \
  -d '{"name":"Your name","email":"you@example.com","password":"<a long password>","setupToken":"<from the log>"}'
# → {"success":true,"user":{…}}
```

Use one of the API's `ALLOWED_ORIGINS` as `Origin`: better-auth checks it on
its routes (`/api/auth/*`), and the API checks it on every write made with the
session cookie. Check:

```bash
curl -s -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'origin: http://localhost:3001' \
  -d '{"email":"you@example.com","password":"…"}' -o /dev/null -w "%{http_code}\n"    # 200
```

`/api/system/setup` is exempt from the early admin gate
(`EARLY_ADMIN_ONLY_ROUTES` in `apps/api/src/middleware/auth-guard.ts`).

Do this **before** opening the installation to the public. While there is no
administrator, public sign-up is refused; the setup token is what keeps the first
administrator yours, so do not share the API log. Once the administrator
exists, sign-up stays closed in production (and on any API listening beyond
loopback) unless you set `KITSUDEN_SIGNUP=open`
([variables.md](variables.md)). The first administrator (`POST /api/system/setup`) and agent keys are
not affected by that setting.

### Two-factor sign-in and magic links

- **Authenticator app (TOTP).** Panel → Settings → Security: give the password,
  add the key to an authenticator app (or open the `otpauth://` link on the
  phone), confirm with a first code, and store the ten backup codes. From then
  on a password sign-in asks for a code; a backup code works once. The secret
  and the codes are stored encrypted with `BETTER_AUTH_SECRET`: rotating it
  means everyone enrols again. API: `POST /api/auth/two-factor/enable`,
  `/verify-totp`, `/verify-backup-code`, `/disable`, `/generate-backup-codes`.
- **Requiring it for admins.** `KITSUDEN_ADMIN_MFA=required` (default
  `optional`): an admin without a second factor gets `403` with
  `reason: "MFA_REQUIRED"` everywhere except sign-in and enrolment, and the panel
  shows only the enrolment screen. Agent keys are not affected. Enrol the
  first administrator **before** turning it on.
- **Magic links.** The login has "Email me a sign-in link"
  (`POST /api/auth/sign-in/magic-link`): a single-use link, valid ten minutes,
  stored hashed, sent through the mailer (`system.magic-link`). It never
  creates an account while sign-up is closed or there is no administrator, and
  accounts with two-factor sign-in never get one (a link is one factor; their
  sign-in is password + code). The answer is the same whether or not a link
  was sent.
- **Not covered:** sign-in through GitHub, Google, Microsoft or Discord does
  not ask for the code (better-auth's two-factor plugin does not hook OAuth);
  the provider's own two-factor protects that path.

Rate limits per IP: 5 magic links an hour, 10 code attempts per 5 minutes (on
top of better-auth's lock after 5 wrong codes on the same challenge).

## 3. Enabling kons

From the panel: the **Kons** section, the kon's toggle. Through the API, with
an administrator session **(tested 2026-10-15)**:

```bash
curl -s -b cookies.txt -H 'origin: http://localhost:3001' http://127.0.0.1:3000/api/modules       # list and state
curl -s -b cookies.txt -H 'origin: http://localhost:3001' -H 'content-type: application/json' \
  -X PATCH http://127.0.0.1:3000/api/modules/kon-games -d '{"enabled":true}'
# → {"key":"kon-games",…,"enabled":true,…,"requiresRestart":false,"mountedNow":true}
```

- The **tables** are created at that moment with `DATABASE_ADMIN_URL` (Docker
  sets it). Without it, the panel says which command to run
  (`bun run scripts/migrate.ts`) instead of leaving the kon half installed.
- The **routes** are mounted without a restart (`mountedNow: true`):
  `GET /api/games` went from 404 to 200 in the test.
- In the 2026-10-15 test, writing with an **agent key** (Inti) to a kon that
  had just been enabled at runtime returned `401 Unauthorized - Authentication
required` until the API was restarted (`docker restart <API container>`).
  It has not been tested again: if it happens to you, restart.
- The `modules` table is the truth about what is enabled;
  `apps/api/kitsuden.config.ts` only **seeds** the missing ones the first time.

The neutral starter only needs the core (pages and media) and `kon-blog`,
enabled by default. A website that calls routes of disabled kons still loads,
with gaps.

## 4. Site settings

In the panel, **Settings**: site name and **Site URL** (the public URL of the
website; it wins over environment variables for whatever the API writes with
an absolute address).

## 5. Final check

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/live                 # 200
curl -s http://127.0.0.1:3000/api/system/init-check                                 # {"initialized":true}
curl -s http://127.0.0.1:3000/api/version                                           # version and contracts
docker compose -f docker-compose.yml ps                                              # everything healthy
```

`/api/version` only announces the contracts whose kon is enabled
([versions.md](versions.md)).
