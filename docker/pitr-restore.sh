#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — point-in-time restore (KITSUDEN_PITR=on)
# ═══════════════════════════════════════════════════════════════════════════
#
# Two steps, on purpose. The first never touches the live database.
#
#   1. RESTORE into a NEW volume and check it:
#
#        docker/pitr-restore.sh --target-time "2026-11-04 10:41:00+00"
#
#      Picks the newest base backup taken before that moment (or --base NAME),
#      unpacks it into a new volume, replays the WAL archive up to the target
#      (`recovery_target_time`, then promote) in a temporary container on
#      127.0.0.1:${PORT:-5439}, and leaves it running so you can look:
#
#        psql -h 127.0.0.1 -p 5439 -U kitsuden kitsuden_prod
#
#   2. APPLY it, once you are sure (stops the API, the backup and the database,
#      keeps a copy of the current data in another volume, puts the restored
#      data in its place and starts them again):
#
#        docker/pitr-restore.sh --apply <restore-volume> --yes-i-am-sure
#
# It uses plain `docker` commands, never compose, and only the names derived
# from KITSUDEN_INSTANCE (default `kitsuden`): <instance>_backups_prod,
# <instance>_wal_archive_prod, <instance>_postgres_prod, <instance>_db_prod…
#
# Options:
#   --target-time T   a timestamp Postgres understands; give the zone ("+00")
#   --base NAME       base-<stamp> under /backups/base (default: newest before T)
#   --instance NAME   KITSUDEN_INSTANCE (default: $KITSUDEN_INSTANCE or kitsuden)
#   --user NAME       the database superuser (default: $POSTGRES_USER or kitsuden)
#   --port N          local port of the temporary container (default 5439)
#   --image IMAGE     Postgres image (default pgvector/pgvector:pg16, as compose)
#   --backups-volume V / --wal-volume V
#                     other volume names than <instance>_backups_prod and
#                     <instance>_wal_archive_prod (a copy brought from another host)
#
# Full procedure, timings and what can go wrong: docs/install/high-availability.md.
set -euo pipefail

INSTANCE="${KITSUDEN_INSTANCE:-kitsuden}"
PGUSER_NAME="${POSTGRES_USER:-kitsuden}"
PORT=5439
IMAGE="pgvector/pgvector:pg16"
TARGET=""
BASE=""
APPLY=""
SURE=false
BACKUPS_VOL=""
WAL_VOL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target-time) TARGET="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --user) PGUSER_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --backups-volume) BACKUPS_VOL="$2"; shift 2 ;;
    --wal-volume) WAL_VOL="$2"; shift 2 ;;
    --apply) APPLY="$2"; shift 2 ;;
    --yes-i-am-sure) SURE=true; shift ;;
    -h | --help) sed -n '3,43p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

BACKUPS_VOL="${BACKUPS_VOL:-${INSTANCE}_backups_prod}"
WAL_VOL="${WAL_VOL:-${INSTANCE}_wal_archive_prod}"
LIVE_VOL="${INSTANCE}_postgres_prod"
TEMP_CT="${INSTANCE}_pitr_restore"
MARK_BEGIN="# >>> kitsuden pitr-restore"
MARK_END="# <<< kitsuden pitr-restore"

die() { echo "pitr-restore: $*" >&2; exit 1; }
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

# ── Step 2: apply ───────────────────────────────────────────────────────────
if [ -n "$APPLY" ]; then
  volume_exists "$APPLY" || die "no volume $APPLY (it is printed at the end of step 1)"
  volume_exists "$LIVE_VOL" || die "no volume $LIVE_VOL: wrong --instance?"
  if [ "$SURE" != true ]; then
    cat <<EOF
This REPLACES the live database ($LIVE_VOL) with the restored copy ($APPLY).
The current data is first copied to ${LIVE_VOL}_before_pitr_<stamp>.
The API, the backup and the database containers of '$INSTANCE' are stopped meanwhile.
Repeat with --yes-i-am-sure to do it.
EOF
    exit 1
  fi
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  KEEP_VOL="${LIVE_VOL}_before_pitr_${STAMP}"

  # A clean shutdown of the checked copy: the data is consistent either way, but
  # this spares a crash recovery on the first live start.
  docker stop "$TEMP_CT" >/dev/null 2>&1 || true
  docker rm "$TEMP_CT" >/dev/null 2>&1 || true
  for c in "${INSTANCE}_api_prod" "${INSTANCE}_backup_prod" "${INSTANCE}_db_prod"; do
    docker stop "$c" >/dev/null 2>&1 && echo "stopped $c" || true
  done

  docker volume create "$KEEP_VOL" >/dev/null
  echo "copying the current data to $KEEP_VOL …"
  docker run --rm -v "$LIVE_VOL:/from:ro" -v "$KEEP_VOL:/to" "$IMAGE" sh -c 'cp -a /from/. /to/'

  echo "putting the restored data in $LIVE_VOL …"
  # The recovery settings this script appended are removed: they only matter
  # during recovery, and `archive_mode = off` would hide the live flag's intent.
  # The new timeline's history file goes to the archive, which the restore
  # container could not write: a later restore across this timeline needs it.
  docker run --rm -v "$APPLY:/from:ro" -v "$LIVE_VOL:/to" -v "$WAL_VOL:/wal-archive" "$IMAGE" sh -c "
    set -e
    find /to -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a /from/. /to/
    sed -i '/^$MARK_BEGIN\$/,/^$MARK_END\$/d' /to/postgresql.auto.conf
    rm -f /to/recovery.signal /to/standby.signal
    for h in /to/pg_wal/*.history; do
      [ -f \"\$h\" ] || continue
      n=\$(basename \"\$h\")
      [ -f /wal-archive/\$n.gz ] || gzip -c \"\$h\" > /wal-archive/\$n.gz
    done
    chown -R postgres:postgres /wal-archive
  "

  for c in "${INSTANCE}_db_prod" "${INSTANCE}_api_prod" "${INSTANCE}_backup_prod"; do
    docker start "$c" >/dev/null && echo "started $c"
  done
  cat <<EOF

Done. The previous data stays in $KEEP_VOL (remove it when you no longer need it):
  docker volume rm $KEEP_VOL
Take a fresh base backup now: the old ones restore the OLD history, not this one.
  docker exec ${INSTANCE}_backup_prod bun run scripts/backup.ts --base --force
The restored copy volume $APPLY can be removed too:
  docker volume rm $APPLY
EOF
  exit 0
fi

# ── Step 1: restore into a new volume ───────────────────────────────────────
[ -n "$TARGET" ] || die "--target-time is required (see --help)"
volume_exists "$BACKUPS_VOL" || die "no volume $BACKUPS_VOL: wrong --instance?"
volume_exists "$WAL_VOL" || die "no volume $WAL_VOL: was KITSUDEN_PITR=on?"

if [ -z "$BASE" ]; then
  # Base names carry their UTC start: base-YYYY-MM-DDTHH-MM-SS. GNU date parses
  # the target; elsewhere, pass --base.
  TARGET_STAMP="$(date -u -d "$TARGET" +%Y-%m-%dT%H-%M-%S 2>/dev/null)" ||
    die "could not read --target-time with date -d; pass --base base-<stamp> explicitly"
  BASE="$(docker run --rm -v "$BACKUPS_VOL:/backups:ro" "$IMAGE" sh -c 'ls -1 /backups/base 2>/dev/null' |
    grep -E '^base-[0-9T-]+$' | sort | awk -v t="base-$TARGET_STAMP" '$0 < t' | tail -n 1 || true)"
  [ -n "$BASE" ] || die "no base backup older than $TARGET in $BACKUPS_VOL/base"
fi
echo "base backup: $BASE"
echo "target:      $TARGET"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESTORE_VOL="${INSTANCE}_pitr_restore_${STAMP}"
docker volume create "$RESTORE_VOL" >/dev/null
echo "restore volume: $RESTORE_VOL"

# Unpack as root, hand it to postgres, append the recovery settings (between
# markers, so step 2 can remove them) and ask for recovery.
docker run --rm -v "$BACKUPS_VOL:/backups:ro" -v "$RESTORE_VOL:/data" "$IMAGE" sh -c "
  set -e
  b=/backups/base/$BASE
  [ -f \$b/base.tar.gz ] || { echo 'missing '\$b/base.tar.gz >&2; exit 1; }
  tar -xzf \$b/base.tar.gz -C /data
  mkdir -p /data/pg_wal
  tar -xzf \$b/pg_wal.tar.gz -C /data/pg_wal
  cat >> /data/postgresql.auto.conf <<CONF
$MARK_BEGIN
restore_command = 'test -f /wal-archive/%f.gz && gzip -dc /wal-archive/%f.gz > %p'
recovery_target_time = '$TARGET'
recovery_target_action = 'promote'
archive_mode = off
$MARK_END
CONF
  touch /data/recovery.signal
  chown -R postgres:postgres /data
  chmod 700 /data
"

docker rm -f "$TEMP_CT" >/dev/null 2>&1 || true
# The archive is mounted READ-ONLY: the copy under test can never write into it.
docker run -d --name "$TEMP_CT" \
  -v "$RESTORE_VOL:/var/lib/postgresql/data" \
  -v "$WAL_VOL:/wal-archive:ro" \
  -p "127.0.0.1:${PORT}:5432" \
  "$IMAGE" postgres >/dev/null
echo "replaying WAL in $TEMP_CT …"

state=""
for _ in $(seq 1 720); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$TEMP_CT" 2>/dev/null)" != "true" ]; then
    docker logs --tail 30 "$TEMP_CT" >&2 || true
    die "the restore container stopped. «recovery ended before configured recovery target» means the archive has no WAL up to that moment."
  fi
  state="$(docker exec -u postgres "$TEMP_CT" psql -U "$PGUSER_NAME" -d postgres -tAXc 'SELECT pg_is_in_recovery()' 2>/dev/null || true)"
  [ "$state" = "f" ] && break
  sleep 5
done
[ "$state" = "f" ] || die "still recovering after an hour; see: docker logs $TEMP_CT"

echo
docker logs "$TEMP_CT" 2>&1 | grep -E 'recovery stopping|last completed transaction|selected new timeline' || true
cat <<EOF

Restored and promoted. Look before you apply:
  psql -h 127.0.0.1 -p $PORT -U $PGUSER_NAME ${POSTGRES_DB:-kitsuden_prod}

Wrong moment? Remove it and run step 1 again with another --target-time:
  docker rm -f $TEMP_CT && docker volume rm $RESTORE_VOL

Right moment? Make it the live database:
  docker/pitr-restore.sh --apply $RESTORE_VOL --instance $INSTANCE --yes-i-am-sure
EOF
