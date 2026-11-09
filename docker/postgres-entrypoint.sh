#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — the database container's entrypoint (wraps the image's own)
# ═══════════════════════════════════════════════════════════════════════════
#
# With KITSUDEN_PITR unset or `off` it does nothing: it hands over to the
# image's `docker-entrypoint.sh` exactly as before.
#
# With KITSUDEN_PITR=on (point-in-time restore, docs/install/high-availability.md):
#
#   1. /wal-archive (a volume) is made the `postgres` user's: a fresh named
#      volume mounts owned by root and Postgres could not write to it.
#   2. WAL archiving is switched on with `-c` flags, so nothing in
#      postgresql.conf is edited and turning PITR off again is just removing the
#      variable:
#         archive_mode=on, archive_command=docker/wal-archive.sh,
#         archive_timeout=PG_ARCHIVE_TIMEOUT (default 300 s: at most five
#         minutes of writes live only in pg_wal),
#         max_slot_wal_keep_size=PG_MAX_SLOT_WAL_KEEP_SIZE (default 10GB: a
#         replica that is gone for days cannot fill the disk; past that it must
#         be cloned again).
#   3. pg_hba.conf gets ONE line, once (found again by its comment; initdb's own
#      replication rules only cover 127.0.0.1, so they do not count):
#         host replication all all scram-sha-256
#      `pg_basebackup` (the backup container) and a streaming replica connect
#      with the replication protocol, which `host all all all` does NOT cover.
#      It still needs a role with REPLICATION and its password, and the port
#      stays on 127.0.0.1 and the compose network. On a brand-new volume it is
#      added by an init script this wrapper drops in /docker-entrypoint-initdb.d.
#
# Runs as root (the image drops to `postgres` itself), so it can chown.
set -eu

PITR="${KITSUDEN_PITR:-off}"

if [ "$PITR" = "on" ]; then
  mkdir -p /wal-archive
  chown postgres:postgres /wal-archive
  chmod 700 /wal-archive

  # The same few lines serve an existing volume (now) and a brand-new one (as
  # an init script: initdb has not run yet at this point).
  allow_replication='hba="$PGDATA/pg_hba.conf"
if [ -f "$hba" ] && ! grep -q "Added by docker/postgres-entrypoint.sh" "$hba"; then
  printf "\n# Added by docker/postgres-entrypoint.sh (KITSUDEN_PITR=on)\nhost replication all all scram-sha-256\n" >> "$hba"
  echo "postgres-entrypoint: replication connections allowed in pg_hba.conf"
fi'
  export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
  if [ -s "$PGDATA/PG_VERSION" ]; then
    sh -c "$allow_replication"
  else
    printf '%s\n' "$allow_replication" > /docker-entrypoint-initdb.d/zz-kitsuden-replication.sh
  fi

  set -- "$@" \
    -c archive_mode=on \
    -c "archive_command=sh /kitsuden/wal-archive.sh %p %f" \
    -c "archive_timeout=${PG_ARCHIVE_TIMEOUT:-300}" \
    -c wal_level=replica \
    -c max_wal_senders=10 \
    -c "max_slot_wal_keep_size=${PG_MAX_SLOT_WAL_KEEP_SIZE:-10GB}"
  echo "postgres-entrypoint: WAL archiving on (/wal-archive, timeout ${PG_ARCHIVE_TIMEOUT:-300}s)"
elif [ "$PITR" != "off" ]; then
  echo "postgres-entrypoint: KITSUDEN_PITR must be on or off, got '$PITR': archiving stays OFF" >&2
fi

exec docker-entrypoint.sh "$@"
