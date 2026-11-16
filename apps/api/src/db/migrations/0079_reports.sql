-- Reports and dashboards (docs/reports.md).
--
-- A report is an aggregate query stored as data (`query`, see
-- packages/shared/src/reports.ts) with a hint on how to draw it (`chart`).
-- A dashboard is an ordered list of tiles, each pointing at a report: one a
-- person saved here (by id) or one a kon ships (`kon:<kon id>/<report id>`).
--
-- Until now the only "saved view" was the panel's localStorage and an
-- in-memory map in the explorer: neither survives a restart or reaches a
-- second person.
--
-- No row policies: both tables are reached only through the report
-- operations, which are for administrators and for agents holding the
-- `reports:*` scopes. What a report COUNTS is decided when it runs, by the row
-- policies of the table it reads, as whoever runs it.

CREATE TABLE IF NOT EXISTS reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(200) NOT NULL,
  description   text,
  query         jsonb NOT NULL,
  chart         jsonb,
  created_by_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reports_updated_idx ON reports (updated_at DESC);

CREATE TABLE IF NOT EXISTS dashboards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(200) NOT NULL,
  description   text,
  -- [{ "report": "<uuid>" | "kon:<kon id>/<report id>", "title"?: text, "width"?: 1..12 }]
  tiles         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboards_updated_idx ON dashboards (updated_at DESC);
