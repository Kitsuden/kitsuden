-- Automation rules (docs/automation.md).
--
-- A stored action gains a fifth type, `rule`: a list of steps, each naming a
-- handler (`core:webhook`, `core:send-mail`, `core:run-agent`, or one a kon
-- contributes), run in order when the trigger's conditions are met.
--
-- The steps live in `actions.config` and the conditions in
-- `actions.trigger_config`, both jsonb already, so the only schema change is
-- the enum value. Nothing else in this file: a value added to an enum cannot
-- be used in the transaction that adds it.

ALTER TYPE action_type ADD VALUE IF NOT EXISTS 'rule';
