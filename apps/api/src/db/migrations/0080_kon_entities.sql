-- Kon entities (docs/kons/entities.md).
--
-- A kon declares entities in `defineKon({ entities })` and the host creates
-- one dataset per entity at load, with no SQL written by the kon. `kon_id`
-- says which kon a dataset belongs to; NULL is a dataset a person made.
--
-- It is what lets the host tell "the CRM's vehicles" from "a dataset someone
-- happened to call vehicles": a kon never takes over a slug it does not own.
--
-- In the core chain, like the other columns of the datasets battery (0035):
-- it is the chain every schema check builds from.

ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS kon_id varchar(100);

-- Settings the kon keeps for the entity (numbering, flags): stored with the
-- definition, never read by the core.
ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS kon_settings jsonb;

CREATE INDEX IF NOT EXISTS data_sets_kon_id_idx ON data_sets (kon_id);
