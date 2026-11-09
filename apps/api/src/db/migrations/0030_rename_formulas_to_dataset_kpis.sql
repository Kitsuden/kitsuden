-- 0030 — `formulas` → `dataset_kpis`
-- ============================================================================
-- Idempotent and NON-destructive: it is a rename, the data is kept.
--
-- WHY
--
-- The core `formulas` table was never game formulas: they are KPIs over
-- datasets (`kpi_name`, `threshold` at 95%, `enabled`), and the admin's DatasetCreator
-- talks about exactly that — "create KPIs like totals, averages, or custom
-- formulas".
--
-- With the arrival of `kon-formulas` —game formula evaluator for
-- builders, calculators and simulators— the name came to designate two
-- different things in the same project. `dataset_kpis` says what the table is and
-- leaves `formulas` free for its only meaning.
--
-- NOTE: the table is ORPHANED. No code reads or writes it (verified
-- across all of `apps/api/src`); only the schema declares it. Renaming it clarifies it,
-- but if it is never going to be used, the honest thing is to delete it — and that is a
-- product decision, not a refactor one, because there may be data.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'formulas')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'dataset_kpis')
  THEN
    ALTER TABLE formulas RENAME TO dataset_kpis;
  END IF;
END $$;
