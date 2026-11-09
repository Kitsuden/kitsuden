#!/bin/bash
# ===================================================================
# Kitsuden — deploy / update on the VPS (production with TLS)
#
#   ./scripts/deploy.sh            builds and (re)starts everything
#   ./scripts/deploy.sh --check   only validates .env and the configuration
#                                 (`--comprobar` is kept as an old alias)
#
# Full guide (first deployment, data, backups): docs/install/server.md
#
# Rewritten after an audit. The previous version was dangerous in production:
#   · it used the base compose + override (SeaweedFS, development ports) and
#     NOT the TLS overlay, so the site was never served;
#   · it ran `down --remove-orphans` first (everything down while building,
#     ~10 min);
#   · it migrated with `bunx drizzle-kit migrate`, which applies 2 of the ~100
#     migrations (API startup already migrates with the right runner);
#   · it ran `src/db/seed.ts` against the real database on every deployment;
#   · it required DATABASE_URL/REDIS_URL in .env, which compose already builds on its own.
#
# It prints no secrets: it never dumps `docker compose config` or the environment.
# ===================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
C=(docker compose -f docker-compose.yml -f docker-compose.tls.yml)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[0;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Own overlays (another site instead of the neutral starter, extra services):
# KITSUDEN_OVERLAYS, in the environment or in .env, comma-separated files.
# They are added AFTER docker-compose.tls.yml:
#
#   KITSUDEN_OVERLAYS=docker-compose.miweb.yml ./scripts/deploy.sh
#
# Only that line is read from .env: the rest is not loaded into this shell.
if [ -z "${KITSUDEN_OVERLAYS:-}" ] && [ -f .env ]; then
  KITSUDEN_OVERLAYS=$(sed -n 's/^KITSUDEN_OVERLAYS=//p' .env | tail -n 1 | tr -d "\"'\r")
fi
IFS=',' read -r -a OVERLAYS <<< "${KITSUDEN_OVERLAYS:-}"
for o in "${OVERLAYS[@]}"; do
  o=$(echo "$o" | xargs)
  [ -z "$o" ] && continue
  [ -f "$o" ] || fail "KITSUDEN_OVERLAYS: $o does not exist"
  C+=(-f "$o")
done

step "1. Requirements"
command -v docker >/dev/null || fail "Docker is not installed (see docs/install/server.md)"
docker compose version >/dev/null 2>&1 || fail "The «docker compose» plugin (v2) is missing"
[ -f .env ] || fail "There is no .env: cp .env.production.example .env and fill it in"
# A value that STARTS with "<" is a template placeholder (a real MAIL_FROM,
# "Name <email>", does not start with "<")
if grep -qE '^[A-Z0-9_]+=<' .env; then
  fail "The .env still has values to fill in (<...>): $(grep -oE '^[A-Z0-9_]+=<' .env | cut -d= -f1 | tr '\n' ' ')"
fi
perm=$(stat -c %a .env 2>/dev/null || echo 600)
[ "$perm" = "600" ] || printf '⚠ .env has permissions %s; better: chmod 600 .env\n' "$perm"

step "2. Configuration (without printing values)"
"${C[@]}" config -q || fail "docker compose rejects the configuration (see the message above)"
echo "ok"

{ [ "${1:-}" = "--check" ] || [ "${1:-}" = "--comprobar" ]; } && exit 0

step "3. Build (API ~10 min, web a few minutes; the current services keep serving)"
"${C[@]}" build

step "4. Start / replace containers"
"${C[@]}" up -d --remove-orphans

step "5. Wait until everything is healthy (up to 5 min)"
for _ in $(seq 1 60); do
  unhealthy=$("${C[@]}" ps --format '{{.Service}} {{.Health}}' | awk '$2 != "" && $2 != "healthy" && $1 != "kitsuden_backup" {print $1"("$2")"}')
  [ -z "$unhealthy" ] && break
  sleep 5
done
"${C[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
[ -z "${unhealthy:-}" ] || fail "Did not finish starting: $unhealthy — ${C[*]} logs --tail 100 <service>"

step "Done"
echo "Check from outside: docs/install/server.md"
