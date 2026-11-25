#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — run a maintenance command with the database's admin account
#
#   docker exec <api-container> sh /app/docker/as-admin.sh bun run scripts/migrate.ts --kon blog
#   docker exec <api-container> sh /app/docker/as-admin.sh bun run scripts/rekey-secrets.ts --dry-run
#
# The running API has no admin URL (its start removes it), and with generated
# secrets the container's configuration has no password either. This builds the
# admin URL the same way the start does (docker/kitsuden-env.sh: .env first, then
# the root-only secrets volume), passes it as DATABASE_URL to that one command,
# and runs it as `bun` from apps/api. `docker exec` is root in this container
# (compose's `user: "0:0"`), which is what lets it read the volume.
# ═══════════════════════════════════════════════════════════════════════════
set -eu

if [ "$#" -eq 0 ]; then
    echo "usage: sh /app/docker/as-admin.sh <command> [args…]" >&2
    exit 2
fi

. "$(dirname "$0")/kitsuden-env.sh"
kitsuden_load_secrets
kitsuden_build_urls

if [ -z "${DATABASE_ADMIN_URL:-}" ]; then
    echo "No admin account: POSTGRES_PASSWORD is not in the environment and the secrets" >&2
    echo "volume is not readable here (run this with docker exec as root, the default)." >&2
    exit 1
fi
# Both names: the scripts read DATABASE_URL, a few look for DATABASE_ADMIN_URL.
DATABASE_URL="$DATABASE_ADMIN_URL"
export DATABASE_URL

cd /app/apps/api
if [ "$(id -u)" = "0" ]; then
    kitsuden_bun_home
    exec su-exec bun:bun "$@"
fi
exec "$@"
