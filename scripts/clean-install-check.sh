#!/bin/bash
# ===================================================================
# Kitsuden — a clean install, end to end, the way a new user does it
#
#   KITSUDEN_API_IMAGE=kitsuden-api:ci KITSUDEN_ADMIN_IMAGE=kitsuden-admin:ci \
#     ./scripts/clean-install-check.sh
#
# For CI and for a THROWAWAY machine. It starts the base compose with NO .env
# (every secret generated), under its own instance name and ports, checks what a
# new user depends on, and removes everything it created, volumes included.
#
#   1. `docker compose up` with no .env reaches a healthy API.
#   2. The generated secrets are root's: the running API (user bun) cannot read
#      the superuser's password, and does not run as root.
#   3. The limited DDL role exists, so enabling a kon from the panel can create
#      its tables.
#   4. The API log prints the setup link, and its token creates the first admin.
#   5. A second `up` keeps the secrets (nothing is rotated) and the admin.
#
# Never point it at an install you care about: it ends with `down -v`.
# ===================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

export KITSUDEN_INSTANCE="${KITSUDEN_INSTANCE:-kitsudenclean}"
export COMPOSE_PROJECT_NAME="$KITSUDEN_INSTANCE"
export API_PORT="${API_PORT:-23000}" ADMIN_PORT="${ADMIN_PORT:-23001}"
export DB_PORT="${DB_PORT:-25432}" VALKEY_PORT="${VALKEY_PORT:-26379}"
export ADMIN_URL="http://localhost:${ADMIN_PORT}"
: "${KITSUDEN_API_IMAGE:?set KITSUDEN_API_IMAGE to an image built from this checkout}"
: "${KITSUDEN_ADMIN_IMAGE:?set KITSUDEN_ADMIN_IMAGE to an image built from this checkout}"
export KITSUDEN_API_IMAGE KITSUDEN_ADMIN_IMAGE

case "$KITSUDEN_INSTANCE" in
  *prod* | kitsuden) echo "refusing: KITSUDEN_INSTANCE=$KITSUDEN_INSTANCE looks like a real install" >&2; exit 1 ;;
esac

# No .env: compose must not read one from this folder either.
EMPTY_ENV=$(mktemp)
C=(docker compose --env-file "$EMPTY_ENV" -f docker-compose.yml)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[0;31m✗ %s\033[0m\n' "$1" >&2; "${C[@]}" logs --tail 80 kitsuden_api >&2 || true; exit 1; }
cleanup() { "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; rm -f "$EMPTY_ENV"; }
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 1 90); do
    state=$(docker inspect -f '{{.State.Health.Status}}' "${KITSUDEN_INSTANCE}_api_prod" 2>/dev/null || echo missing)
    [ "$state" = "healthy" ] && return 0
    sleep 4
  done
  fail "the API never became healthy (last: $state)"
}

# A fingerprint of the secrets, never the values (root: the files are 0400)
secrets_fingerprint() {
  docker run --rm -u 0:0 --entrypoint sh -v "${KITSUDEN_INSTANCE}_secrets_prod:/s:ro" \
    "$KITSUDEN_API_IMAGE" -c 'cat /s/* | sha256sum' 2>/dev/null || true
}

# As the API's own user: `docker exec` is root in this container (compose's
# `user: "0:0"`), and what matters is what the running API can do.
as_api() { "${C[@]}" exec -T -u bun kitsuden_api sh -c "$1"; }

step "1. up with no .env"
"${C[@]}" up -d --no-build kitsuden_db kitsuden_state kitsuden_api kitsuden_admin
wait_healthy
curl -fsS "http://127.0.0.1:${API_PORT}/ready" >/dev/null || fail "/ready does not answer"

step "2. the API serves as bun and cannot read the root-only secrets"
pid1_user=$(as_api 'stat -c %U /proc/1')
[ "$pid1_user" = "bun" ] || fail "PID 1 runs as $pid1_user, not bun"
if as_api 'cat /kitsuden-secrets/postgres_password' >/dev/null 2>&1; then
  fail "the API's user can read the superuser's password"
fi
environ=$(as_api 'tr "\0" "\n" < /proc/1/environ | cut -d= -f1')
for v in DATABASE_URL REDIS_URL BETTER_AUTH_SECRET KITSUDEN_SECRETS_KEY DATABASE_DDL_URL; do
  echo "$environ" | grep -qx "$v" || fail "the running API lacks $v"
done
for v in DATABASE_ADMIN_URL POSTGRES_PASSWORD APP_DB_PASSWORD DDL_DB_PASSWORD VALKEY_PASSWORD; do
  if echo "$environ" | grep -qx "$v"; then fail "the running API still has $v"; fi
done
# Maintenance with the admin account still works (docker/as-admin.sh)
"${C[@]}" exec -T kitsuden_api sh /app/docker/as-admin.sh bun run scripts/migrate.ts --status >/dev/null \
  || fail "as-admin.sh could not run migrate.ts --status"

step "3. the DDL role exists (enabling a kon from the panel)"
roles=$("${C[@]}" exec -T kitsuden_db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT rolname FROM pg_roles WHERE rolname IN ('"'"'kitsuden_app'"'"','"'"'kitsuden_ddl'"'"') ORDER BY 1"')
[ "$(echo "$roles" | tr -d '\r' | xargs)" = "kitsuden_app kitsuden_ddl" ] || fail "roles found: $roles"

step "4. the setup link and token create the first admin"
token=$("${C[@]}" logs kitsuden_api 2>/dev/null | sed -n 's|.*#setup-token=\([A-Za-z0-9_-]*\).*|\1|p' | tail -n 1)
[ -n "$token" ] || fail "no setup link in the API log"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${API_PORT}/api/system/setup" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Owner\",\"email\":\"owner@example.com\",\"password\":\"clean-install-check-pw\",\"setupToken\":\"$token\"}")
[ "$code" = "200" ] || [ "$code" = "201" ] || fail "setup answered $code"
init=$(curl -fsS "http://127.0.0.1:${API_PORT}/api/system/init-check")
echo "$init" | grep -q '"initialized":true' || fail "init-check after setup: $init"

step "5. a second up keeps the secrets and the admin"
before=$(secrets_fingerprint)
[ -n "$before" ] || fail "could not read the secrets volume"
"${C[@]}" up -d --no-build --force-recreate kitsuden_api
wait_healthy
[ "$(secrets_fingerprint)" = "$before" ] || fail "the secrets changed on the second start"
curl -fsS "http://127.0.0.1:${API_PORT}/api/system/init-check" | grep -q '"initialized":true' \
  || fail "the admin is gone after the second start"

printf '\n\033[0;32m✓ clean install: healthy, secrets generated and kept, API as bun, DDL role, first admin\033[0m\n'
