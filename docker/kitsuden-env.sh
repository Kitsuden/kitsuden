# shellcheck shell=sh
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — the API container's secrets and connection URLs (sourced, not run)
#
#   . /app/docker/kitsuden-env.sh
#   kitsuden_load_secrets     # as root: fills what the environment lacks from the
#                             # secrets volume (docker/generate-secrets.sh)
#   kitsuden_build_urls       # builds the URLs that are not set, drops the raw
#                             # passwords
#
# Used by docker/start-with-check.sh (the API's start) and docker/as-admin.sh
# (maintenance commands with the admin account), so both read the same values
# the same way. A variable set in the environment (.env) always wins.
# ═══════════════════════════════════════════════════════════════════════════

KITSUDEN_SECRETS_DIR="${KITSUDEN_SECRETS_DIR:-/kitsuden-secrets}"

kitsuden_secret() {
    [ -s "$KITSUDEN_SECRETS_DIR/$1" ] && cat "$KITSUDEN_SECRETS_DIR/$1" || true
}

# The files are root's (mode 0400): only a root shell can read them. Without the
# folder (a plain `docker run`, an older compose) it does nothing.
kitsuden_load_secrets() {
    [ -d "$KITSUDEN_SECRETS_DIR" ] || return 0
    : "${POSTGRES_PASSWORD:=$(kitsuden_secret postgres_password)}"
    : "${APP_DB_PASSWORD:=$(kitsuden_secret app_db_password)}"
    : "${DDL_DB_PASSWORD:=$(kitsuden_secret ddl_db_password)}"
    : "${VALKEY_PASSWORD:=$(kitsuden_secret valkey_password)}"
    : "${BETTER_AUTH_SECRET:=$(kitsuden_secret better_auth_secret)}"
    : "${KITSUDEN_SECRETS_KEY:=$(kitsuden_secret kitsuden_secrets_key)}"
    : "${SITE_API_KEY:=$(kitsuden_secret site_api_key)}"
    export POSTGRES_PASSWORD APP_DB_PASSWORD DDL_DB_PASSWORD VALKEY_PASSWORD \
        BETTER_AUTH_SECRET KITSUDEN_SECRETS_KEY SITE_API_KEY
}

# The URLs, when compose did not give them whole: the pieces compose passes
# (KITSUDEN_DB_HOST, POSTGRES_USER…) and each password. Then the raw passwords
# leave the environment: the URLs carry them where needed.
kitsuden_build_urls() {
    _at="${KITSUDEN_DB_HOST:-kitsuden_db}:${KITSUDEN_DB_PORT:-5432}/${POSTGRES_DB:-kitsuden_prod}"
    if [ -z "${DATABASE_ADMIN_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
        DATABASE_ADMIN_URL="postgresql://${POSTGRES_USER:-kitsuden}:${POSTGRES_PASSWORD}@${_at}"
        export DATABASE_ADMIN_URL
    fi
    if [ -z "${DATABASE_URL:-}" ] && [ -n "${APP_DB_PASSWORD:-}" ]; then
        DATABASE_URL="postgresql://${APP_DB_USER:-kitsuden_app}:${APP_DB_PASSWORD}@${_at}"
        export DATABASE_URL
    fi
    if [ -z "${DATABASE_DDL_URL:-}" ] && [ -n "${DDL_DB_PASSWORD:-}" ]; then
        DATABASE_DDL_URL="postgresql://${DDL_DB_USER:-kitsuden_ddl}:${DDL_DB_PASSWORD}@${_at}"
        export DATABASE_DDL_URL
    fi
    if [ -z "${REDIS_URL:-}" ] && [ -n "${VALKEY_PASSWORD:-}" ]; then
        REDIS_URL="redis://:${VALKEY_PASSWORD}@${KITSUDEN_STATE_HOST:-kitsuden_state}:6379"
        export REDIS_URL
    fi
    unset _at POSTGRES_PASSWORD APP_DB_PASSWORD DDL_DB_PASSWORD VALKEY_PASSWORD
}

# su-exec keeps HOME; bun keeps its cache under it, and /root is not bun's.
kitsuden_bun_home() {
    HOME=$(awk -F: '$1 == "bun" { print $6 }' /etc/passwd)
    HOME="${HOME:-/tmp}"
    export HOME
}
