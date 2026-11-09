#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — streaming replica (docker-compose.replica.yml)
# ═══════════════════════════════════════════════════════════════════════════
#
# First start (empty volume): clones the primary with `pg_basebackup -R`, which
# writes `standby.signal` and `primary_conninfo`, through a physical replication
# slot so the primary keeps the WAL this replica has not received yet
# (bounded by max_slot_wal_keep_size on the primary, see postgres-entrypoint.sh).
# Every later start: just Postgres, which resumes streaming.
#
# The primary must accept replication connections (KITSUDEN_PITR=on adds the
# pg_hba line) and have the role, created once on the primary:
#
#   CREATE ROLE kitsuden_replicator WITH REPLICATION LOGIN PASSWORD '…';
#
# Read-only by construction (hot standby). Promoting it is a manual decision:
# docs/install/high-availability.md, "Failover".
set -eu

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
: "${PRIMARY_HOST:?PRIMARY_HOST is required}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD is required}"
USER_NAME="${REPLICATION_USER:-kitsuden_replicator}"
SLOT="${REPLICATION_SLOT:-kitsuden_replica}"

mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "replica-entrypoint: cloning $PRIMARY_HOST (slot $SLOT) …"
  until pg_isready -h "$PRIMARY_HOST" -p 5432 >/dev/null 2>&1; do sleep 2; done
  # The password goes through a .pgpass, never the command line (`ps`).
  pgpass="$(mktemp)"
  printf '%s:5432:*:%s:%s\n' "$PRIMARY_HOST" "$USER_NAME" "$REPLICATION_PASSWORD" > "$pgpass"
  chown postgres "$pgpass"
  chmod 600 "$pgpass"
  # -C creates the slot; if a previous attempt already did, reuse it.
  if ! gosu postgres env PGPASSFILE="$pgpass" pg_basebackup -h "$PRIMARY_HOST" -U "$USER_NAME" \
    -D "$PGDATA" -X stream -R -C -S "$SLOT" --checkpoint=fast; then
    rm -rf "${PGDATA:?}"/*
    gosu postgres env PGPASSFILE="$pgpass" pg_basebackup -h "$PRIMARY_HOST" -U "$USER_NAME" \
      -D "$PGDATA" -X stream -R -S "$SLOT" --checkpoint=fast
  fi
  rm -f "$pgpass"
  # primary_conninfo written by -R carries the password: owner-only file.
  chmod 600 "$PGDATA/postgresql.auto.conf"
  echo "replica-entrypoint: clone done, starting as a hot standby"
fi

exec gosu postgres postgres -c hot_standby=on
