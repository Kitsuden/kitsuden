#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Backup of the MEDIA volume (the API's /app/data) with rotation
#
# `scripts/backup.ts` only does `pg_dump`: the database stores the ADDRESSES of
# the images, not the images. Losing the uploads volume leaves a restorable
# database and a website without a single image.
#
# Called by the `kitsuden_backup` loop (docker-compose.yml) after each
# dump, and it decides whether it is due: a full copy every BACKUP_MEDIA_DAYS days
# (7 by default) and the last BACKUP_MEDIA_KEEP are kept (2). Media
# almost never changes (hash keys, additions only), so a
# full weekly copy is enough and nothing incremental is needed.
#
# Format: uncompressed tar. They are WebP and MP4, already compressed: gzip would take
# minutes to gain 1-2%.
#
# It is written to `<name>.tar.partial` and renamed only if verification
# passes: a half-done copy (disk full, container stopped) is never mistaken
# for a good one, and rotation never deletes the last good one because of a bad one.
#
# Archives are named media-<date>.tar. Those written by earlier versions are
# named medios-<date>.tar: they are rotated and restored the same way.
#
# Variables: MEDIA_DIR (/media), BACKUP_DIR (/backups), BACKUP_MEDIA_DAYS,
# BACKUP_MEDIA_KEEP. `--force` (old alias `--forzar`) copies even if it is not due.
# The `.medios-ultimo-ok` mark and `medios-*.tar.parcial` leftovers are the old
# names, read for compatibility.
#
# Restore: see docs/install/upgrade-and-backups.md.
# ═══════════════════════════════════════════════════════════════════════════
set -eu

MEDIA_DIR="${MEDIA_DIR:-/media}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DAYS="${BACKUP_MEDIA_DAYS:-7}"
KEEP="${BACKUP_MEDIA_KEEP:-2}"
MARK="$BACKUP_DIR/.media-last-ok"
LEGACY_MARK="$BACKUP_DIR/.medios-ultimo-ok"

if [ ! -d "$MEDIA_DIR" ]; then
  echo "media: $MEDIA_DIR is not mounted; nothing to copy" >&2
  exit 1
fi

now=$(date -u +%s)
if [ ! -f "$MARK" ] && [ -f "$LEGACY_MARK" ]; then cp "$LEGACY_MARK" "$MARK"; fi
if [ "${1:-}" != "--force" ] && [ "${1:-}" != "--forzar" ] && [ -f "$MARK" ]; then
  last=$(cat "$MARK")
  if [ $((now - last)) -lt $((DAYS * 86400)) ]; then
    echo "media: last copy $(((now - last) / 3600)) h ago; the next one after $DAYS days"
    exit 0
  fi
fi

name="media-$(date -u +%Y-%m-%dT%H-%M-%S).tar"
target="$BACKUP_DIR/$name"
partial="$target.partial"
rm -f "$BACKUP_DIR"/media-*.tar.partial "$BACKUP_DIR"/medios-*.tar.parcial

# Does it fit? What the media takes plus 10%. Better not to start than to fill the
# disk where the database also lives.
needed_kb=$(du -sk "$MEDIA_DIR" | awk '{print int($1 * 1.1)}')
free_kb=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt "$needed_kb" ]; then
  echo "media: NOT enough space (${needed_kb} KB needed, ${free_kb} KB free)" >&2
  exit 1
fi

echo "media: copying $MEDIA_DIR → $name"
start=$(date -u +%s)
tar -cf "$partial" -C "$MEDIA_DIR" .

# Verification: the tar is read in full and has as many files as the source.
in_source=$(find "$MEDIA_DIR" -type f | wc -l | tr -d ' ')
in_copy=$(tar -tf "$partial" | grep -vc '/$' || true)
if [ "$in_copy" -lt "$in_source" ]; then
  echo "media: INCOMPLETE copy ($in_copy of $in_source files); discarded" >&2
  rm -f "$partial"
  exit 1
fi
mv "$partial" "$target"
echo "$now" > "$MARK"
echo "media: ok, $in_copy files, $(du -h "$target" | cut -f1), $(( $(date -u +%s) - start )) s"

# Rotation: the most recent KEEP are kept. The date in the name orders them,
# whichever prefix they carry.
ls -1 "$BACKUP_DIR"/media-*.tar "$BACKUP_DIR"/medios-*.tar 2>/dev/null \
  | awk '{ d = $0; sub(/^.*\/medi(a|os)-/, "", d); print d "\t" $0 }' \
  | sort -r | cut -f2- | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "media: rotation, deleting $(basename "$old")"
  rm -f "$old"
done
