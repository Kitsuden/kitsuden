-- ============================================================================
-- 0043 — Entries of a dataset, in order, without scanning the whole table
-- ============================================================================
--
-- `GET /api/data-sets/:id/entries` is the most requested route of the API (the public
-- site reads every table, tier list and card page this way) and asks for
--
--     WHERE data_set_id = $1 ORDER BY sort_order, id LIMIT n OFFSET m
--
-- No index served both needs at once. For large datasets
-- (39 exceed 1,000 rows, the largest is around 45,000) the planner chose
-- `entries_sort_idx` —sort_order of the WHOLE table— and discarded, row by row,
-- those of other datasets. Measured on a copy of production: 1.6–1.9 s for the
-- third page of 1,000 of the largest dataset, 118,000 rows read and thrown away.
-- With this index the same query reads only its own rows, already ordered.
--
-- `entries_dataset_idx` (data_set_id) is redundant: it is an exact prefix of this one and of
-- two others (`data_entries_set_status_idx`, `idx_data_entries_dataset_owner`).
-- Keeping it only costs writes.
--
-- Without CONCURRENTLY on purpose: the runner applies each file inside a
-- transaction and CONCURRENTLY cannot run inside one. With ~200,000 rows the CREATE
-- takes about a second and only blocks WRITES on data_entries
-- (reads continue); do it outside a data load.

CREATE INDEX IF NOT EXISTS data_entries_set_orden_idx
  ON data_entries (data_set_id, sort_order, id);

DROP INDEX IF EXISTS entries_dataset_idx;
