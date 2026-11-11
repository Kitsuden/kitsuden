# High availability and point-in-time restore

What Kitsuden offers for the database beyond the nightly dump, what each piece
costs, and what it does **not** do. Everything here is operator work on the
Docker stack (`docker-compose.yml`); none of it is on by default.

| You want                                        | Use                                                | Default |
| ----------------------------------------------- | -------------------------------------------------- | ------- |
| The database as it was yesterday                | the nightly dump (`kitsuden_backup`)               | on      |
| The database as it was at 10:41, before a bug   | point-in-time restore (`KITSUDEN_PITR`)            | off     |
| A second copy, seconds behind, ready to promote | a streaming replica (`docker-compose.replica.yml`) | off     |
| Automatic failover                              | not provided (see [below](#what-is-not-provided))  | —       |

## Point-in-time restore

### How it works

- With `KITSUDEN_PITR=on`, the database container's entrypoint
  (`docker/postgres-entrypoint.sh`) starts Postgres with `archive_mode=on`. Every
  finished 16 MB WAL segment is gzipped into the `<instance>_wal_archive_prod`
  volume by `docker/wal-archive.sh`, durably (fsync, then rename) and never
  overwriting. `PG_ARCHIVE_TIMEOUT` (300 s) forces a segment out even when it is
  not full, so the archive is at most five minutes behind.
- The backup container, after each nightly dump, takes a **base backup**
  (`pg_basebackup`, tar + gzip, with the WAL of the copy itself) every
  `BACKUP_BASE_DAYS` (7) days into `/backups/base/base-<stamp>/`, checks it
  (both archives readable, `backup_label` inside), keeps `BACKUP_BASE_KEEP` (2)
  and deletes the archived WAL older than what the oldest kept base needs.
- Restoring = unpack a base backup, replay archived WAL up to
  `recovery_target_time`, promote. `docker/pitr-restore.sh` does it into a
  **new** volume first, so you can look before replacing anything.

The backup container refuses to take a base backup when the database is not
archiving, and fails loudly when `pg_stat_archiver` shows archiving failing. Its
healthcheck also turns unhealthy when the last good base backup is older than
two intervals.

### Turning it on

```bash
# .env
KITSUDEN_PITR=on
# optional: PG_ARCHIVE_TIMEOUT=300  BACKUP_BASE_DAYS=7  BACKUP_BASE_KEEP=2

docker compose -f docker-compose.yml up -d kitsuden_db kitsuden_backup      # restarts Postgres: a few seconds of downtime
docker exec -w /app/apps/api <instance>_backup_prod bun run scripts/backup.ts --base --force
docker exec -w /app/apps/api <instance>_backup_prod bun run scripts/backup.ts --list
```

The entrypoint also adds one line to `pg_hba.conf`, once
(`host replication all all scram-sha-256`): `pg_basebackup` and replicas use the
replication protocol, which `host all all all` does not cover. It still needs a
role with `REPLICATION` (the superuser, or the replicator below) and its
password, and the port stays on `127.0.0.1` and the compose network.

**Disk.** The archive holds every change since the oldest kept base: roughly
the write volume of `BACKUP_BASE_DAYS × BACKUP_BASE_KEEP` days, plus two base
backups (each about the compressed size of the database). Forced switches on an
idle database gzip down to a few KB. If the archive volume fills up, archiving
fails, Postgres keeps the segments in `pg_wal`, and **the database's own disk
fills next**: watch the backup container's health and the free space.

**Off the machine.** Archive and base backups sit on the same disk as the
database: they protect against a bad `DELETE`, a broken migration or a corrupt
table, not against losing the server. Copy `<instance>_wal_archive_prod` and
`<instance>_backups_prod` elsewhere as well (the `rclone` example in
[upgrades and backups](upgrade-and-backups.md) works for both volumes). A
`wal-g` or `pgBackRest` setup can replace `docker/wal-archive.sh` to push
straight to S3; neither ships in the images, so it means a custom Postgres image.

### Restoring to a moment

Tested 2026-11-04 with throwaway containers: three rows, a target between the
second and the third, the restored copy held exactly the first two.

```bash
# 1. Restore into a NEW volume and look (the live database is not touched).
docker/pitr-restore.sh --target-time "2026-11-04 10:41:00+00"
#    → picks the newest base taken before that moment, replays WAL, promotes,
#      leaves it running on 127.0.0.1:5439:
psql -h 127.0.0.1 -p 5439 -U kitsuden kitsuden_prod

# Wrong moment? Remove it and repeat with another time:
docker rm -f kitsuden_pitr_restore && docker volume rm kitsuden_pitr_restore_<stamp>

# 2. Right moment: make it the live database. Stops API, backup and database,
#    copies the current data to kitsuden_postgres_prod_before_pitr_<stamp>,
#    puts the restored data in place and starts them again.
docker/pitr-restore.sh --apply kitsuden_pitr_restore_<stamp> --yes-i-am-sure

# 3. Take a new base backup: the old ones restore the OLD history.
docker exec -w /app/apps/api kitsuden_backup_prod bun run scripts/backup.ts --base --force
```

Give the time zone in `--target-time`. The log line `recovery stopping before
commit of transaction …, time …` says exactly where it stopped. A target later
than the newest archived WAL fails with `recovery ended before configured
recovery target was reached`: the archive is up to `PG_ARCHIVE_TIMEOUT` behind
the database. `--instance`, `--user`, `--port`, `--backups-volume` and
`--wal-volume` cover other names (`--help`).

Restoring the database does not restore the media, and rolls back sessions,
agent keys and queue jobs to that moment too: a job that ran after the target
will run again unless its effect was recorded somewhere that was not rolled back.

## A streaming replica

`docker-compose.replica.yml` adds `kitsuden_db_replica`: a hot standby that
follows the primary over the replication protocol, typically less than a second
behind, read-only.

```bash
# 1. On the primary: KITSUDEN_PITR=on (for the pg_hba line), then the role:
docker exec -it <instance>_db_prod psql -U kitsuden -d kitsuden_prod \
  -c "CREATE ROLE kitsuden_replicator WITH REPLICATION LOGIN PASSWORD '<password>'"
# 2. .env: REPLICATION_PASSWORD=<password>
# 3. Start it (the first start clones the primary with pg_basebackup):
docker compose -f docker-compose.yml -f docker-compose.replica.yml up -d kitsuden_db_replica
# 4. Check it streams:
docker exec <instance>_db_prod psql -U kitsuden -d kitsuden_prod \
  -c "SELECT client_addr, state, replay_lag FROM pg_stat_replication"
```

It uses a replication slot (`kitsuden_replica`): the primary keeps the WAL the
replica has not received, up to `PG_MAX_SLOT_WAL_KEEP_SIZE` (10 GB). A replica
that stays down longer loses its place and must be cloned again (remove its
volume and start it). A replica that is gone for good must have its slot
dropped: `SELECT pg_drop_replication_slot('kitsuden_replica')`.

On the same host a replica protects against a corrupted data directory, not
against losing the machine. For that run it on another host with the same file,
`REPLICA_PRIMARY_HOST=<primary address>`, and the primary's port reachable from
there over a private network or a tunnel, never the open internet.

### What the API needs

Nothing, and it does not use the replica. There is **no read routing**: every
request reads and writes the primary through `DATABASE_URL`. Sending reads to a
replica would break read-your-own-writes (an entry created and read back in the
next request may not be there yet) and the per-request RLS transaction, so it is
left out on purpose. The replica is for failover and for read-only consumers you
point at it yourself (reports, analytics, `pg_dump` without load on the primary).

### Failover (manual)

When the primary is lost and will not come back soon:

```bash
docker stop <instance>_db_prod                         # if it is still half alive: never two primaries
docker exec -u postgres <instance>_db_replica pg_ctl promote -D /var/lib/postgresql/data
# Point the API and the backup at the replica: in docker-compose.yml their
# DATABASE_URL / DATABASE_ADMIN_URL / DATABASE_DDL_URL use the host
# <instance>_db_prod; change it to <instance>_db_replica (or swap the volumes)
# and recreate them:
docker compose -f docker-compose.yml up -d kitsuden_api kitsuden_backup
```

The promoted replica is now the primary on a new timeline. The old primary must
**not** be started again as it was: rebuild it as a replica of the new one
(empty volume + the replica entrypoint), then switch back in a maintenance
window if you want the original layout. Take a base backup after promoting.

## RPO and RTO, honestly

| Setup                   | Data lost (RPO)                                                                                                                              | Time to be back (RTO)                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Nightly dump only       | up to `BACKUP_INTERVAL_HOURS` (24 h)                                                                                                         | restore time of the dump: minutes for a small database, hours for a big one                |
| `KITSUDEN_PITR=on`      | up to `PG_ARCHIVE_TIMEOUT` (5 min) **if the archive survives**; same disk as the database, so losing the disk loses it too unless copied off | unpack the base + replay the WAL since it: from minutes to an hour or more for a busy week |
| Replica on another host | the replication lag: usually under a second (asynchronous, so the last commits can be lost)                                                  | a manual promotion and an API restart: minutes, once someone is awake                      |

There is no synchronous replication, no automatic failover and no fencing: the
times above include a human noticing and acting. If you need minutes of RTO
without a person, you need a managed Postgres or Patroni-style orchestration,
which this stack does not ship.

## What is not provided

- **Automatic failover.** Promoting by script without fencing risks two
  primaries accepting writes (split brain). Kitsuden leaves the decision to a
  person.
- **Read replicas in the API.** See [what the API needs](#what-the-api-needs).
- **Off-site copies.** The volumes stay on the host; copying them is yours.
- **Media.** Uploaded files are backed up by the media tar, not by any of this.
