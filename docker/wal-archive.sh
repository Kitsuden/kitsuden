#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Kitsuden — Postgres `archive_command`: one finished WAL segment → the archive
# ═══════════════════════════════════════════════════════════════════════════
#
# Called by Postgres (as the `postgres` user, inside the database container) for
# every WAL segment it finishes, when KITSUDEN_PITR=on:
#
#     archive_command = 'sh /kitsuden/wal-archive.sh %p %f'
#
# Exit 0 tells Postgres the segment is safe and may be recycled; anything else
# makes it keep the segment in pg_wal and try again later. So this script must
# only say 0 once the copy is DURABLE:
#
#   · gzip to a temporary name, fsync it, then rename it into place: a crash
#     midway leaves a `.tmp`, never a truncated segment under its real name;
#   · never overwrite: if the segment is already archived (Postgres retries after
#     a crash between our rename and its bookkeeping), succeed only if the
#     content is identical, fail loudly otherwise.
#
# A forced switch (`archive_timeout`) leaves a mostly empty 16 MB segment; gzip
# shrinks those to a few KB.
#
# Only uses what the Postgres image ships (sh, gzip, cmp, sync, mv).
# Restore side: `restore_command = 'gzip -dc /wal-archive/%f.gz > %p'`.
# See docs/install/high-availability.md.
set -eu

src="$1"
name="$2"
dir="${WAL_ARCHIVE_DIR:-/wal-archive}"
dest="$dir/$name.gz"

if [ -f "$dest" ]; then
  if gzip -dc "$dest" | cmp -s - "$src"; then
    exit 0
  fi
  echo "wal-archive: $dest already exists with different content; refusing to overwrite" >&2
  exit 1
fi

gzip -c "$src" > "$dest.tmp"
sync "$dest.tmp"
mv "$dest.tmp" "$dest"
# The rename itself is durable only once the directory is synced.
sync "$dir" 2>/dev/null || sync
