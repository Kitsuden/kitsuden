#!/bin/sh
# ===================================================================
# Kitsuden Start Script with Auto-Setup
#
# Migration strategy:
#   1. Drizzle migrations (core schema)
#   2. Each kon handles its own tables via SQL
# ===================================================================

set -e

# Two connections, and the distinction is about security, not style:
#
#   DATABASE_ADMIN_URL  administer: create the database, install pgvector, migrate,
#                       create the application role. Needs superuser.
#   DATABASE_URL        serve: what the API uses at runtime. NORMAL role.
#
# Postgres IGNORES RLS policies for a superuser. With a single
# superuser URL for everything, isolation between tenants was not applied: the
# policies existed and were decorative. That is exactly the class of failure
# that gives no error — it works the same, just without isolating anything.
#
# If DATABASE_ADMIN_URL is not defined, DATABASE_URL is used for both, which
# is the old behavior. It still starts, but step [4/6] warns.
DB_URL="${DATABASE_URL}"
if [ -z "$DB_URL" ]; then
    echo "ERROR: DATABASE_URL is not set. Configure it in your .env file."
    exit 1
fi
DB_ADMIN_URL="${DATABASE_ADMIN_URL:-$DATABASE_URL}"
API_URL="${BETTER_AUTH_URL:-http://localhost:3000}"

echo "==================================================================="
echo "  Kitsuden Auto-Setup"
echo "==================================================================="

# [0/6] Public configuration — BEFORE touching the database.
#
# An installation marked as public (TLS overlay, KITSUDEN_PUBLIC=true) does not
# start if any URL is still localhost, if email would go to the console or if
# the session secret is short. None of the three gives an error on startup:
# they fail later, in front of a user. That is why they are checked here.
echo ""
echo "[0/6] Checking public configuration..."
if ! bun run /app/apps/api/scripts/verify-public-config.ts; then
    echo ""
    echo "   ABORTED: the public configuration is not ready (see above)."
    exit 1
fi

# The ADMIN URL is parsed: it is the one used by steps 1-4.
DB_HOST=$(echo "$DB_ADMIN_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
DB_PORT=$(echo "$DB_ADMIN_URL" | sed -n 's|.*@[^:]*:\([0-9]*\)/.*|\1|p')
DB_NAME=$(echo "$DB_ADMIN_URL" | sed -n 's|.*/\([^?]*\)$|\1|p')
DB_USER=$(echo "$DB_ADMIN_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
DB_PASS=$(echo "$DB_ADMIN_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-kitsuden_prod}"
DB_USER="${DB_USER:-kitsuden}"

# psql gets the password in PGPASSWORD, never inside the URL it receives as an
# argument: an argument is visible to anyone who runs `ps` on the host, an
# environment variable only to the same user. The URLs below carry no password,
# and `pg_admin` sets PGPASSWORD for that one psql process only (the API started
# at the end never inherits the administrator's password). The URL form is
# percent-encoded; PGPASSWORD wants the plain value.
DB_PASS_PLAIN=$(KITSUDEN_URL_PW="$DB_PASS" bun -e 'const v = process.env.KITSUDEN_URL_PW ?? ""; let out = v; try { out = decodeURIComponent(v); } catch {} process.stdout.write(out);')
pg_admin() {
    PGPASSWORD="$DB_PASS_PLAIN" psql "$@"
}
ADMIN_DB_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/postgres"
DB_ADMIN_PSQL_URL=$(echo "$DB_ADMIN_URL" | sed 's|^\([A-Za-z0-9+.-]*://[^:/@]*\):[^@]*@|\1@|')

echo ""
echo "[1/6] Checking PostgreSQL..."
echo "   Host: $DB_HOST:$DB_PORT"
echo "   Database: $DB_NAME"

MAX_RETRIES=60
RETRY_COUNT=0

while ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "ERROR: PostgreSQL not responding"
        exit 1
    fi
    echo "   Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 2
done

echo "   OK - PostgreSQL ready"

# `pg_isready` only confirms that the server ANSWERS. It does not check that we can
# authenticate, and that is precisely the failure that slips through to step [4/6] and
# shows up disguised as "Failed query: CREATE TABLE kitsuden_migrations".
#
# The cause is almost always the same and no Postgres message states it:
# the official image runs `initdb` —and creates POSTGRES_USER— only ONCE, when
# the volume is empty. If you later change POSTGRES_USER or POSTGRES_PASSWORD in
# .env, the volume keeps the old user, the new one does not exist, and all
# you see is `password authentication failed for user "..."`.
#
# The check runs against the `postgres` maintenance database, not against
# $DB_NAME: if what is missing is the DATABASE (new volume with a different POSTGRES_DB, or
# a DATABASE_URL pointing to a database nobody created), Postgres says
# `database "..." does not exist`, and that used to be announced as a problem
# with the user. A missing database is not an error: step [2/6] creates it.
ERR_AUTH=$(pg_admin "$ADMIN_DB_URL" -c "SELECT 1" 2>&1 >/dev/null) || {
    case "$ERR_AUTH" in
        *"database \""*"\" does not exist"*)
            # Not even the `postgres` database exists: the user gets in, but there is
            # nowhere to check. Step [2/6] will tell.
            ;;
        *)
            echo ""
            echo "ERROR: PostgreSQL answers, but does not accept the user '$DB_USER'."
            echo ""
            echo "  The Postgres image creates POSTGRES_USER only when it initializes an"
            echo "  EMPTY volume. If you changed POSTGRES_USER or POSTGRES_PASSWORD"
            echo "  after the first time, the volume still has the previous user"
            echo "  and the new one does not exist."
            echo ""
            echo "  Options, from least to most destructive:"
            echo ""
            echo "    1. Set POSTGRES_USER/POSTGRES_PASSWORD back to the values the"
            echo "       volume was created with."
            echo ""
            echo "    2. Create the new user in the existing database, connecting"
            echo "       with the old one (<db-container>: the Postgres one, see docker ps):"
            echo "         docker exec -u postgres <db-container> psql -d $DB_NAME -U <old-user> \\"
            echo "           -c \"CREATE ROLE $DB_USER LOGIN SUPERUSER PASSWORD '<password>';\""
            echo ""
            echo "    3. Start from scratch. THIS DELETES ALL DATA:"
            echo "         docker compose down -v"
            echo ""
            echo "  To see which users exist right now:"
            echo "    docker exec -u postgres <db-container> psql -d $DB_NAME -U <old-user> \\"
            echo "      -c \"SELECT rolname, rolsuper FROM pg_roles WHERE rolcanlogin\""
            echo ""
            exit 1
            ;;
    esac
}

echo "   OK - authentication successful ($DB_USER)"

# Auto-create database
echo ""
echo "[2/6] Checking database '$DB_NAME'..."

DB_EXISTS=$(pg_admin "$ADMIN_DB_URL" -t -A -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" 2>/dev/null || echo "")

if [ "$DB_EXISTS" = "1" ]; then
    echo "   OK - Database exists"
else
    echo "   Creating database..."
    # If it cannot be created, the failure is the DATABASE's, and it is stated as such. Before, a
    # `|| true` silenced it and the error showed up at step [4/6] as a migration
    # failure.
    if ! pg_admin "$ADMIN_DB_URL" -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";" 2>&1; then
        echo ""
        echo "ERROR: the database '$DB_NAME' does not exist and the user '$DB_USER'"
        echo "  cannot create it. The user IS valid: what is missing is the database."
        echo ""
        echo "  Create it with a user that has CREATEDB (or give that permission to"
        echo "  '$DB_USER'), or fix the database name in DATABASE_URL /"
        echo "  DATABASE_ADMIN_URL (POSTGRES_DB in docker-compose)."
        exit 1
    fi
fi

# Verify pgvector
echo ""
echo "[3/6] Checking pgvector..."

PGVECTOR_CHECK=$(pg_admin "$DB_ADMIN_PSQL_URL" -t -A -c "SELECT 1 FROM pg_extension WHERE extname = 'vector'" 2>/dev/null || echo "")

if [ "$PGVECTOR_CHECK" = "1" ]; then
    echo "   OK - pgvector installed"
else
    echo "   Installing pgvector..."
    pg_admin "$DB_ADMIN_PSQL_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || echo "   WARN: Could not install pgvector"
fi

# Database Migrations - CORE ONLY
echo ""
cd /app/apps/api
echo "[4/6] Running core migrations + RLS..."

# This used to be `bunx drizzle-kit migrate || echo "No pending migrations"`, and it
# had TWO serious flaws:
#
#   1. drizzle-kit only knows the 2 migrations in drizzle/. The other 29 in
#      src/db/migrations/ were applied by nobody — the schema was maintained by hand.
#   2. The `|| echo` swallowed the error. A migration that blew up printed
#      "No pending migrations" and the API started anyway, with a half-built schema.
#      A migration failure has to STOP the deployment, not be covered up.
#
# The runner applies the full chain and then the RLS policies —
# which also depended on someone remembering to run a script.
#
# No `||`: `set -e` is active above, so if this fails the container
# does not start. That is what we want.
# DATABASE_URL is overridden ONLY for this command: migrating is DDL and needs
# the superuser. The API, further below, starts with the serving one.
#
# The app role has to EXIST before migrating. Several migrations grant it
# permissions with `IF EXISTS (SELECT 1 FROM pg_roles ...) THEN GRANT` on their
# functions (0056 the queue, 0057 the traces), and an applied migration does not run
# again: on an empty database they skipped the GRANT, the API got «permission denied
# for function kitsuden_queue_claim» for good, and background jobs did not run.
# Nobody saw it because it only happens on a new install. This only creates the
# role; its permissions on tables come further below.
APP_USER=$(echo "$DB_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
APP_PASS=$(echo "$DB_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
if [ "$DB_ADMIN_URL" != "$DB_URL" ] && [ -n "$APP_USER" ] && [ -n "$APP_PASS" ]; then
    pg_admin "$DB_ADMIN_PSQL_URL" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
    CREATE ROLE "${APP_USER}" LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;
SQL
fi

DATABASE_URL="$DB_ADMIN_URL" bun run scripts/migrate.ts

echo "   Migrations + RLS complete"

# Check that what the code DECLARES really exists in the database.
#
# Migrating without errors does not guarantee the schema is complete: a table can
# be declared in `schema-core.ts` and have no migration that creates it. This happened with
# `auth_accounts`, and the symptom was that on a NEW installation it was impossible
# to create the first administrator — 500 on «System Init» and, in the log,
# `relation "auth_accounts" does not exist`. Worse: better-auth stores the user
# in `auth_users` and the credential in `auth_accounts`, so the user was created
# WITHOUT a password and retrying no longer fixed anything.
#
# Nobody saw it for months because existing installations already had those
# tables. It only appears on a freshly set up server: the worst possible moment.
#
# It runs with the ADMIN URL because it queries the system catalog. If something
# is missing, `set -e` stops startup: a deployment that does not start gets fixed;
# one that starts half-working is discovered when someone cannot log in.
echo ""
echo "   Verifying schema..."
DATABASE_URL="$DB_ADMIN_URL" bun run scripts/verify-schema.ts

# ── Application role ──────────────────────────────────────────────────────
#
# Its permissions are given AFTER migrating, because the GRANTs need the tables to
# exist. Idempotent: it can be rerun on every startup with no effect.
#
# `ALTER DEFAULT PRIVILEGES` is the part that gets forgotten and then hurts: without it,
# every new table a future migration creates is born without permissions for the application
# role, and the API starts returning "permission denied" in production for
# a table that worked in development.
if [ "$DB_ADMIN_URL" = "$DB_URL" ]; then
    echo ""
    echo "   WARNING: DATABASE_ADMIN_URL is not defined, so the API will run"
    echo "   with the SAME account that migrates. If it is a superuser, Postgres ignores"
    echo "   the RLS policies and isolation between tenants is NOT applied."
elif [ -n "$APP_USER" ] && [ -n "$APP_PASS" ]; then
    echo ""
    echo "   Application role: $APP_USER (no superuser)"
    pg_admin "$DB_ADMIN_PSQL_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
    CREATE ROLE "${APP_USER}" LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE "${APP_USER}" WITH LOGIN PASSWORD '${APP_PASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${APP_USER}";
GRANT USAGE ON SCHEMA public TO "${APP_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${APP_USER}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${APP_USER}";

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${APP_USER}";

-- The blanket GRANT above reopened what migrations 0056 and 0057 narrowed: the
-- queue and the traces are INSERT only for the app role, everything else goes
-- through their SECURITY DEFINER functions (security review 2026-11-03). The
-- effects ledger (0064) is reached only through kitsuden_effect_begin/_finish.
DO \$\$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kitsuden_outbox', 'kitsuden_request_traces'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %I FROM %I', t, '${APP_USER}');
      EXECUTE format('GRANT INSERT ON %I TO %I', t, '${APP_USER}');
    END IF;
  END LOOP;
  IF to_regclass('public.kitsuden_action_effects') IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON kitsuden_action_effects FROM %I', '${APP_USER}');
  END IF;
END
\$\$;

-- A hung query or a forgotten transaction cannot block the database:
-- only for the application role; migrations and loads use the admin one.
ALTER ROLE "${APP_USER}" SET statement_timeout = '60s';
ALTER ROLE "${APP_USER}" SET idle_in_transaction_session_timeout = '60s';
SQL
    echo "   Permissions granted (including future tables)"
fi

# ── Limited DDL role (optional: DATABASE_DDL_URL) ─────────────────────────
#
# For what the API creates AT RUNTIME (enabling a kon from the panel, the
# Vault) without giving it the superuser: a role with no SUPERUSER, no BYPASSRLS, no
# CREATEROLE/CREATEDB, with CREATE on `public` and nothing else. It owns only what
# it creates; the core tables remain the administrator's. See
# apps/api/src/lib/ddl-connection.ts and docs/agents/sandbox.md.
DDL_URL="${DATABASE_DDL_URL:-}"
DDL_USER=$(echo "$DDL_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
DDL_PASS=$(echo "$DDL_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
if [ -n "$DDL_URL" ] && [ -n "$DDL_USER" ] && [ -n "$DDL_PASS" ] && [ "$DDL_URL" != "$DB_ADMIN_URL" ]; then
    echo ""
    echo "   Limited DDL role: $DDL_USER"
    pg_admin "$DB_ADMIN_PSQL_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DDL_USER}') THEN
    CREATE ROLE "${DDL_USER}" LOGIN PASSWORD '${DDL_PASS}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSE
    ALTER ROLE "${DDL_USER}" WITH LOGIN PASSWORD '${DDL_PASS}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE "${DB_NAME}" TO "${DDL_USER}";
GRANT USAGE, CREATE ON SCHEMA public TO "${DDL_USER}";
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA public TO "${DDL_USER}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${DDL_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON TABLES TO "${DDL_USER}";

-- What the DDL role creates is used by the app (DML) without going through the admin.
ALTER DEFAULT PRIVILEGES FOR ROLE "${DDL_USER}" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${APP_USER}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${DDL_USER}" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "${APP_USER}";
ALTER ROLE "${DDL_USER}" SET statement_timeout = '120s';
SQL
    echo "   DDL role ready (no superuser)"
fi

# ── Isolation is TESTED, not declared ─────────────────────────────────────
#
# So far everything that has been checked is DECLARATIONS: that the role exists,
# that it is not a superuser, that the policies were created. None of those things
# proves that one user cannot see another's rows.
#
# And the four ways to break isolation give no error, they give data: a role
# that turns out to be a superuser, a BYPASSRLS granted for debugging and never removed,
# a new table with ENABLE but no FORCE, or a policy that always evaluates
# to true. The system keeps working just as well, showing other people's data.
#
# So it is checked against the real database, with the real role, at deployment:
# with the context set to a user that does not exist, an isolated table must
# return ZERO rows. If any returns more, startup stops here.
echo ""
echo "[4.5/6] Verifying RLS isolation..."
if ! bun run scripts/verify-rls.ts; then
    echo ""
    echo "   ABORTED: isolation between users is not being applied."
    echo "   Starting here would serve data from some users to others."
    exit 1
fi

# Auto-Install Kons
echo ""
echo "[5/6] Installing kons..."

bun run - << 'KON_SCRIPT'
import { db } from "./src/db";
import { installedKons } from "./src/db/schema";
import { eq } from "drizzle-orm";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { readdir } from "fs/promises";

const KON_CONFIG_PATH = "./kitsuden.config.ts";

async function scanLocalKons() {
  const konsDir = "/app/packages/kons";
  const found = [];

  try {
    const entries = await readdir(konsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const konJsonPath = join(konsDir, entry.name, "kon.json");
      const kitsudenJsonPath = join(konsDir, entry.name, "kitsuden.json");

      let manifest = null;

      if (existsSync(konJsonPath)) {
        manifest = JSON.parse(readFileSync(konJsonPath, "utf-8"));
      } else if (existsSync(kitsudenJsonPath)) {
        manifest = JSON.parse(readFileSync(kitsudenJsonPath, "utf-8"));
      }

      if (manifest && manifest.id) {
        found.push({
          konId: manifest.id,
          name: manifest.name || manifest.id,
          description: manifest.description,
          version: manifest.version || "1.0.0",
          source: "local",
          path: join(konsDir, entry.name),
          manifest,
          enabled: true,
        });
      }
    }
  } catch (err) {
    console.log("   WARN: Scan error:", err.message);
  }

  return found;
}

async function getConfigKons() {
  try {
    if (!existsSync(KON_CONFIG_PATH)) return [];

    // Import the static config directly instead of regex-parsing TS
    const configModule = await import(KON_CONFIG_PATH);
    const staticConfig = configModule.staticConfig || configModule.default || configModule;
    return staticConfig.kons || staticConfig.modules || [];
  } catch (err) {
    console.log("   WARN: Could not import kitsuden.config.ts:", err.message);
    return [];
  }
}

async function main() {
  const [localKons, configIds] = await Promise.all([
    scanLocalKons(),
    getConfigKons(),
  ]);

  const toInstall = configIds.length > 0
    ? localKons.filter(g => configIds.includes(g.konId))
    : localKons;

  console.log("   Found " + localKons.length + " kons (" + toInstall.length + " active)");

  const installed = await db.select().from(installedKons);
  const installedIds = new Set(installed.map(i => i.konId));

  for (const kon of toInstall) {
    if (installedIds.has(kon.konId)) {
      console.log("   ✓ " + kon.konId + " already registered");
      continue;
    }

    try {
      await db.insert(installedKons).values({
        konId: kon.konId,
        name: kon.name,
        description: kon.description,
        version: kon.version,
        source: kon.source,
        sourceUrl: kon.sourceUrl,
        path: kon.path,
        manifest: kon.manifest,
        enabled: kon.enabled,
      });
      console.log("   + " + kon.konId + " registered");
    } catch (err) {
      console.log("   ✗ " + kon.konId + ": " + err.message);
    }
  }
}

// ALWAYS exit, not only on error.
//
// This used to be `main().catch(() => process.exit(0))`, which only ends on the
// bad path. On the good one, `main()` finished its work (registering the kons and
// printing each line) and the process did NOT exit: `db` leaves a Postgres pool
// open, and while a handle is alive the runtime does not end.
//
// The effect was that startup stopped here forever: step [6/6] never got to run
// `bun run dist/index.js`, nothing listened on 3000, and `docker compose up`
// ended up saying only that the container was 'unhealthy', with not a single
// line of error, because there was no error.
//
// The exit code stays 0 when it fails too, on purpose: not being able to
// register a kon must not stop the API from starting.
main()
  .catch((err) => console.log('   WARN: ' + err.message))
  .finally(() => process.exit(0));
KON_SCRIPT

echo ""
echo "==================================================================="
echo "[6/6] Setup complete. Starting API..."
echo "==================================================================="
echo ""
echo "  API: ${API_URL}"
echo "  Docs: ${API_URL}/api/swagger"
echo ""

# ── The API serves WITHOUT the superuser ──────────────────────────────────
#
# Everything that needed the admin URL (creating the database, pgvector,
# migrating, the app role, verifying RLS) was already done above, in THIS shell.
# With `exec` the API inherits the environment: if DATABASE_ADMIN_URL were still there,
# any API failure —or user code escaping the sandbox—
# would read the superuser from `process.env` or from /proc/1/environ.
#
# `docker exec` is NOT affected: it takes the environment from the container's
# configuration, not from process 1's, so `docker exec <api> bun run
# scripts/migrate.ts --kon <id>` still has the administration account.
#
# KITSUDEN_API_KEEP_ADMIN_URL=true keeps the previous behavior (for
# example, to enable kons that alter core tables without restarting).
# This script's variables (DB_ADMIN_URL, ADMIN_DB_URL, DB_PASS…) are
# not exported: they do not reach the API.
if [ "${KITSUDEN_API_KEEP_ADMIN_URL:-false}" = "true" ]; then
    echo "  WARNING: KITSUDEN_API_KEEP_ADMIN_URL=true: the API keeps DATABASE_ADMIN_URL."
else
    unset DATABASE_ADMIN_URL
    echo "  DATABASE_ADMIN_URL removed from the API environment (app role only${DDL_USER:+ + limited DDL})."
fi
unset DDL_PASS DB_PASS APP_PASS

exec bun run dist/index.js
