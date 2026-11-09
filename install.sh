#!/usr/bin/env bash
#
# Kitsuden on your machine, with one command. It only needs Docker.
#
#   ./install.sh             create .env, build, start and print the URLs
#   ./install.sh --dry-run   only create .env and say what it would use
#   ./install.sh --rebuild   build again (after updating the code)
#
# For a server with a domain and TLS: scripts/deploy.sh (docs/install/server.md).
#
# It overwrites nothing. If this machine already has another install, it picks
# another prefix (kitsuden2, ...) and other ports: docker-compose.yml names its
# volumes after KITSUDEN_INSTANCE, so without this it would share the first one's
# database. Set KITSUDEN_INSTANCE yourself to choose the prefix.
# Keep in step with install.ps1.

set -euo pipefail
cd "$(dirname "$0")"

MARKER="# Created by install.sh"
DRY_RUN=false
REBUILD=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --rebuild) REBUILD=true ;;
    -h | --help) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

die() { printf '\nInstall stopped: %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Get it at https://docs.docker.com/get-docker/ and run this again."
docker compose version >/dev/null 2>&1 || die "this needs the Docker Compose v2 plugin ('docker compose')."
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start it and run this again."

# A checkout with an override is a custom deployment: this is not for it.
[ -f docker-compose.override.yml ] && die "this folder has a docker-compose.override.yml, so it is a custom deployment. Use your own deploy process."

compose() { docker compose -f docker-compose.yml "$@"; }
secret() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
env_value() { sed -n "s/^$1=//p" .env | tr -d '\r' | tail -n 1; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
free_port() {
  local p="$1"
  while port_in_use "$p"; do p=$((p + 1)); done
  echo "$p"
}

instance_in_use() {
  docker ps -a --format '{{.Names}}' | grep -qx "$1_db_prod" && return 0
  docker volume inspect "$1_postgres_prod" >/dev/null 2>&1
}

choose_instance() {
  local instance=kitsuden n=2
  if [ -n "${KITSUDEN_INSTANCE:-}" ]; then
    instance="$KITSUDEN_INSTANCE"
    case "$instance" in
      [a-z0-9]*) ;;
      *) die "KITSUDEN_INSTANCE must start with a lowercase letter or a digit." ;;
    esac
    case "$instance" in
      *[!a-z0-9_-]*) die "KITSUDEN_INSTANCE can only have lowercase letters, digits, '-' and '_'." ;;
    esac
    instance_in_use "$instance" && die "the instance '$instance' already exists on this machine. Choose another KITSUDEN_INSTANCE."
  else
    while instance_in_use "$instance"; do
      instance="kitsuden$n"
      n=$((n + 1))
    done
  fi
  echo "$instance"
}

create_env() {
  local instance api admin db valkey line
  instance=$(choose_instance)
  api=$(free_port 3000)
  admin=$(free_port 3001)
  [ "$admin" = "$api" ] && admin=$(free_port $((api + 1)))
  db=$(free_port 5432)
  valkey=$(free_port 6379)

  umask 077
  {
    printf '%s. Secrets are in here: never commit it, and keep a copy.\n' "$MARKER"
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      case "$line" in
        *'=<openssl rand -hex 32>') line="${line%%=*}=$(secret)" ;;
        SITE_DOMAIN=* | ACME_EMAIL=* | MAIL_FROM=*) line="${line%%=*}=" ;;
        COMPOSE_PROJECT_NAME=*) line="COMPOSE_PROJECT_NAME=$instance" ;;
      esac
      printf '%s\n' "$line"
    done <.env.production.example
    cat <<EOF

# --- This machine (install.sh) ---
KITSUDEN_INSTANCE=$instance
KITSUDEN_API_IMAGE=$instance/api:latest
KITSUDEN_ADMIN_IMAGE=$instance/admin:latest
API_PORT=$api
ADMIN_PORT=$admin
DB_PORT=$db
VALKEY_PORT=$valkey
BETTER_AUTH_URL=http://localhost:$api
ADMIN_URL=http://localhost:$admin
APP_URL=http://localhost:$admin
ALLOWED_ORIGINS=http://localhost:$admin,http://127.0.0.1:$admin,http://localhost:$api,http://127.0.0.1:$api
EOF
  } >.env.tmp
  grep -qE '^[A-Z_]+=<' .env.tmp && { rm -f .env.tmp; die ".env.production.example has a placeholder this script does not know."; }
  mv .env.tmp .env
  chmod 600 .env
}

if [ -f .env ]; then
  # An .env that is not ours may be a real install: it is not touched.
  grep -qF "$MARKER" .env || die "this folder already has a .env that this script did not create. Use scripts/deploy.sh, or move that file away."
  echo "Using the existing .env."
else
  [ -f .env.production.example ] || die ".env.production.example is missing. Run this from a full copy of the repository."
  create_env
  echo "Created .env with new random secrets."
fi

INSTANCE=$(env_value KITSUDEN_INSTANCE)
API_PORT=$(env_value API_PORT)
ADMIN_PORT=$(env_value ADMIN_PORT)
[ "$INSTANCE" = kitsuden ] || echo "This install is '$INSTANCE': its containers, volumes and ports are its own, and it shares nothing with another Kitsuden."

if $DRY_RUN; then
  echo "Dry run: would start '$INSTANCE' with the API on port $API_PORT and the panel on port $ADMIN_PORT."
  exit 0
fi

# Nothing is published to a registry yet, so the images are built here.
# One at a time: building them in parallel has brought Docker Desktop down.
image_missing() { ! docker image inspect "$1" >/dev/null 2>&1; }
if $REBUILD || image_missing "$(env_value KITSUDEN_API_IMAGE)"; then
  echo "Building the API image. The first time takes 5 to 15 minutes..."
  compose build kitsuden_api
fi
if $REBUILD || image_missing "$(env_value KITSUDEN_ADMIN_IMAGE)"; then
  echo "Building the panel image..."
  compose build kitsuden_admin
fi

# Building takes a while: the chosen ports may have been taken since, or since the
# last start. Nobody uses the database and Valkey ports by hand, so those just move;
# the API and panel ports are in the URLs, so stop and say so.
set_env() {
  sed "s/^$1=.*/$1=$2/" .env >.env.tmp
  mv .env.tmp .env
  chmod 600 .env
}
if [ -z "$(compose ps -q --status running kitsuden_api 2>/dev/null)" ]; then
  for key in DB_PORT VALKEY_PORT; do
    current=$(env_value "$key")
    if port_in_use "$current"; then
      next=$(free_port "$current")
      echo "Port $current is now in use, so $key moves to $next."
      set_env "$key" "$next"
    fi
  done
  for port in "$API_PORT" "$ADMIN_PORT"; do
    port_in_use "$port" && die "port $port is in use by another program. Close it and run this again."
  done
fi

echo "Starting..."
compose up -d || die "the containers did not start. Docker's reason is just above."

ready=false
for _ in $(seq 1 90); do
  if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$ADMIN_PORT/" 2>/dev/null &&
    curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$API_PORT/live" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
$ready || die "it did not become ready in 3 minutes. See: docker compose -f docker-compose.yml logs kitsuden_api"

# The API prints the token in its log, and only there. The last one is the valid one:
# each restart makes a new one.
TOKEN_NOTE="Your administrator already exists: sign in."
if curl -fsS -m 3 "http://127.0.0.1:$API_PORT/api/system/init-check" 2>/dev/null | grep -q '"initialized":false'; then
  TOKEN=$(compose logs --no-log-prefix kitsuden_api 2>/dev/null |
    sed -n '/one-time setup token in the panel/{n;n;p;}' | tr -d ' \r' | tail -n 1)
  TOKEN_NOTE="It asks for this one-time setup token, which only the API log has:
       ${TOKEN:-(not found: use the command below)}
     A restart of the API replaces it. To read it again:
       docker compose -f docker-compose.yml logs kitsuden_api | grep -A4 \"No administrator\""
fi

cat <<EOF

Kitsuden is running.

  1. Open the panel and create your administrator:
       http://localhost:$ADMIN_PORT
     $TOKEN_NOTE
     Everything listens on this machine only.

  2. In the panel, go to Agents, create one and copy its key.

  3. Point your MCP client at:
       http://localhost:$API_PORT/api/mcp

  API: http://localhost:$API_PORT    Guide for agents: http://localhost:$API_PORT/llms.txt

  Stop:    docker compose -f docker-compose.yml stop
  Start:   ./install.sh
  Logs:    docker compose -f docker-compose.yml logs -f kitsuden_api
  Delete everything, data included:
           docker compose -f docker-compose.yml down -v
EOF
