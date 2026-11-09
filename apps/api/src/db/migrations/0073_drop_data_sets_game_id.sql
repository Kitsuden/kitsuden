-- 0073 — `data_sets.game_id` leaves the core (2026-11-04)
-- ============================================================================
-- A nullable column from before kons existed, when games were a core table. The
-- base migration (drizzle/0000) created it with a foreign key to `games`; 0061
-- dropped that key when kon-games was not in use and left the column as a plain
-- link "that kon-games fills in when installed".
--
-- No kon in the kons repository reads or writes it (checked 2026-11-04): a kon that
-- links to a dataset keeps that link in its own tables (kon-tierlist's
-- `catalogDatasetId`, for instance). The core only copied it from the request body. Dropping it removes the last game-shaped field from the
-- dataset API.
--
-- The key is dropped first by name, for databases where 0061 kept it (kon-games
-- installed); DROP COLUMN would drop it anyway, this only makes it explicit. No
-- index, view or policy uses the column.
--
-- Clients that still send `gameId` are not rejected: the dataset body schema is
-- open (passthrough) and the field is ignored.

ALTER TABLE data_sets DROP CONSTRAINT IF EXISTS data_sets_game_id_games_id_fk;

ALTER TABLE data_sets DROP COLUMN IF EXISTS game_id;
