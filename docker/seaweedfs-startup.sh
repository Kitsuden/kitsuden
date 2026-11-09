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
#   anonymous  — READ-ONLY on the media bucket. The public URLs the API
#                stores (`S3_PUBLIC_URL/<bucket>/<key>`) are requested by the
#                browser unsigned; without this they would return 403. It cannot list the
#                bucket or write, and it does not see other buckets.
# ═══════════════════════════════════════════════════════════════════════════
set -eu

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required - set it in .env}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required - set it in .env}"
BUCKET="${S3_BUCKET:-kitsuden-media}"

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
    { "name": "anonymous", "actions": ["Read:$BUCKET"] }
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
