#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — secrets generated on the first start
# ═══════════════════════════════════════════════════════════════════════════
#
# Run once per `docker compose up` by the one-shot `kitsuden_secrets` service,
# before Postgres, Valkey and the API start. For each secret, in order:
#
#   0. The variable holds an example file's placeholder (`<openssl rand -hex 32>`)
#      → the start stops and names it: Postgres, Valkey and the API would take
#      it literally, since they only read the file when the variable is empty.
#   1. The file already exists in the volume  → kept (never rotated here).
#   2. The variable is set in .env            → copied into the file, so the
#      files and .env agree if the variable is removed later.
#   3. Neither                                → 32 random bytes, in hex (no URL
#      encoding needed: some of them go into connection URLs).
#
# The consumers read the variable first and the file second, so an install
# whose .env holds every secret (the older way) behaves exactly as before.
#
# The files are root's, mode 0400: Postgres, Valkey and the API's start script
# read them as root before dropping privileges, and the running API (user
# `bun`) cannot open them, so it cannot read the superuser's password.
# `site_api_key` is the exception, 0444: the public web reads it as its own
# non-root user, and it only separates visitors for the rate limit.
#
# LOSING THIS VOLUME LOSES DATA: KITSUDEN_SECRETS_KEY seals stored credentials,
# and the database passwords only exist here. Back it up with the rest
# (docs/install/upgrade-and-backups.md).
set -eu

DIR="${KITSUDEN_SECRETS_DIR:-/kitsuden-secrets}"
placeholders=""
mkdir -p "$DIR"
chmod 0755 "$DIR"

random_hex() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# name of the file, name of the variable that may already hold it, mode
generate() {
  file="$DIR/$1"
  value=$(printenv "$2" 2>/dev/null || true)
  # An example file's placeholder (`<openssl rand -hex 32>`) is not a secret. The
  # value itself is not printed.
  case "$value" in "<"*)
    echo "  ! $2 in .env still holds a placeholder (<...>)" >&2
    placeholders="$placeholders $2"
    return 0
    ;;
  esac
  if [ -s "$file" ]; then
    if [ -n "$value" ] && [ "$value" != "$(cat "$file")" ]; then
      echo "  ! $2 in .env differs from the generated $1: the variable wins while it is set"
    fi
    chmod "$3" "$file"
    return 0
  fi
  if [ -n "$value" ]; then
    origin="from .env"
  else
    value=$(random_hex)
    origin="generated"
  fi
  # Written aside and moved: a crash never leaves half a secret behind.
  umask 077
  printf '%s' "$value" > "$file.tmp"
  chmod "$3" "$file.tmp"
  mv "$file.tmp" "$file"
  echo "  + $1 ($origin)"
}

echo "Kitsuden secrets in $DIR"
generate postgres_password    POSTGRES_PASSWORD    0400
generate app_db_password      APP_DB_PASSWORD      0400
generate ddl_db_password      DDL_DB_PASSWORD      0400
generate valkey_password      VALKEY_PASSWORD      0400
generate better_auth_secret   BETTER_AUTH_SECRET   0400
generate kitsuden_secrets_key KITSUDEN_SECRETS_KEY 0400
generate site_api_key         SITE_API_KEY         0444
if [ -n "$placeholders" ]; then
  echo "Stopped: .env holds placeholders for:$placeholders." >&2
  echo "Delete those lines (or leave them empty) to have them generated, or write real values (openssl rand -hex 32)." >&2
  exit 1
fi
echo "Secrets ready."
