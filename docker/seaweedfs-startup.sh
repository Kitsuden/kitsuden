#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# SeaweedFS startup (s3/full/dev profiles of docker-compose.yml)
#
# Replaces MinIO, whose free edition is no longer maintained: no official images
# since October 2025 and with the repository archived in April
# 2026. `minio/minio:latest` still started, but it would no longer receive
# security patches.
#
# ── WHY A SCRIPT AND NOT JUST A `command:` ─────────────────────────────────
#
# SeaweedFS with no identities configured starts in «Allow-All»: anyone
# who reaches the S3 port reads, writes and deletes without credentials. It needs
# an identities file, and that file carries the keys. Writing it here,
# from the environment, avoids two things:
#
#   · a file with secrets in the repository;
#   · the keys on the command line, where any `ps` shows them.
#
# It is regenerated on every startup: rotating the keys means changing `.env` and
# restarting the container.
#
# ── THE TWO IDENTITIES ────────────────────────────────────────────────────
#
#   kitsuden   — the API's (S3_ACCESS_KEY / S3_SECRET_KEY), everything allowed.
#   anonymous  — READ-ONLY on the PUBLIC prefixes of the media bucket. The public
#                URLs the API stores (`S3_PUBLIC_URL/<bucket>/<key>`) are requested
#                by the browser unsigned; without this they would return 403. It cannot
#                list the bucket or write, and it does not see other buckets.
#
# ── WHY NOT `Read:<bucket>` ───────────────────────────────────────────────
#
# `Read:<bucket>` lets anonymous read EVERY object in the bucket, `private/`
# included. Private keys (a customer's voice note, a contract) are meant to be
# readable only through a short-lived presigned GET (apps/api/src/lib/store.ts),
# and every presigned URL shows its key in clear: with a bucket-wide grant,
# whoever once held a signed link could drop the query string and read the
# object for ever. So anonymous gets `Read:<bucket>/<prefix>/*` for each public
# prefix, and never one for `private`.
#
# S3_PUBLIC_PREFIXES (comma or space separated) replaces the default list. A
# kon that serves public files under another top-level prefix adds it there.
# ═══════════════════════════════════════════════════════════════════════════
# -f: no globbing, so a `*` in S3_PUBLIC_PREFIXES is refused instead of expanded
set -euf

DEFAULT_PUBLIC_PREFIXES="uploads transforms cartas juegos media dms"
BUCKET="${S3_BUCKET:-kitsuden-media}"
PUBLIC_PREFIXES="$(printf '%s' "${S3_PUBLIC_PREFIXES:-$DEFAULT_PUBLIC_PREFIXES}" | tr ',' ' ')"

# The anonymous grants as JSON array items: `"Read:<bucket>/<prefix>/*"`, one per
# public prefix. A prefix is one path segment of safe characters; `private` (in
# any case) is refused, and so is anything that could widen the grant (`*`, `/`,
# `..`, an empty list).
anonymous_actions() {
  out=""
  for prefix in $PUBLIC_PREFIXES; do
    case "$prefix" in
      *[!A-Za-z0-9._-]* | . | ..)
        echo "S3_PUBLIC_PREFIXES: invalid prefix '$prefix' (one path segment of letters, digits, . _ -)" >&2
        return 1
        ;;
    esac
    lower="$(printf '%s' "$prefix" | tr 'A-Z' 'a-z')"
    if [ "$lower" = "private" ]; then
      echo "S3_PUBLIC_PREFIXES: 'private' can never be public" >&2
      return 1
    fi
    item="\"Read:$BUCKET/$prefix/*\""
    if [ -z "$out" ]; then out="$item"; else out="$out, $item"; fi
  done
  if [ -z "$out" ]; then
    echo "S3_PUBLIC_PREFIXES is empty" >&2
    return 1
  fi
  printf '%s' "$out"
}

# The bucket goes inside a JSON and a grant: a quote, a backslash or a slash
# would break it or widen it
case "$BUCKET" in
  *'"'* | *'\'* | */* | *'*'*)
    echo "S3_BUCKET cannot contain double quotes, backslashes, slashes or *" >&2
    exit 1
    ;;
esac

ANONYMOUS_ACTIONS="$(anonymous_actions)"

# Used by tests/unit/security-audit-2026-11-19-media-storage.test.ts: print only
# the anonymous grants (no keys) and stop.
if [ "${SEAWEEDFS_PRINT_ANONYMOUS:-}" = "1" ]; then
  printf '[%s]\n' "$ANONYMOUS_ACTIONS"
  exit 0
fi

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required - set it in .env}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required - set it in .env}"

# They go inside a JSON: a quote or a backslash would break it and
# SeaweedFS would start with a configuration that is not the one that was written
case "$S3_ACCESS_KEY$S3_SECRET_KEY$BUCKET" in
  *'"'* | *'\'*)
    echo "S3_ACCESS_KEY, S3_SECRET_KEY and S3_BUCKET cannot contain double quotes or backslashes" >&2
    exit 1
    ;;
esac

mkdir -p /etc/seaweedfs
cat > /etc/seaweedfs/s3.json <<JSON
{
  "identities": [
    {
      "name": "kitsuden",
      "credentials": [{ "accessKey": "$S3_ACCESS_KEY", "secretKey": "$S3_SECRET_KEY" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    },
    { "name": "anonymous", "actions": [$ANONYMOUS_ACTIONS] }
  ]
}
JSON
# The process runs as `seaweed` (the image entrypoint drops
# privileges): it must be able to read it, and nobody else
chown seaweed:seaweed /etc/seaweedfs/s3.json
chmod 600 /etc/seaweedfs/s3.json

# `mini`: master, volume, filer, S3 and panel in a single process, which is
# what fits a single machine. Through the image entrypoint, which
# adjusts the permissions of /data and stops being root.
#
#   -bucket                  creates the bucket if it does not exist (what
#                            `minio/mc mb` did in a separate container)
#   -master.telemetry=false  by default it sends statistics to seaweedfs.com
#
# The panel asks for a user and password; WITHOUT a password it would be open. They are
# the same keys, as in the MinIO console, and they go through the environment
# (`WEED_ADMIN_*`) and not as `-admin.password`, which would show up in `ps`.
export WEED_ADMIN_USER="$S3_ACCESS_KEY"
export WEED_ADMIN_PASSWORD="$S3_SECRET_KEY"
exec /entrypoint.sh mini \
  -dir=/data \
  -bucket="$BUCKET" \
  -s3.config=/etc/seaweedfs/s3.json \
  -master.telemetry=false
