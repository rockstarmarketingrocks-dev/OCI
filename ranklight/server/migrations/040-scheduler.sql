-- Scheduler: one row per domain per refresh/backfill run.
CREATE TABLE IF NOT EXISTS scheduler_runs (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- manual | daily | added | backfill
  started_at TEXT NOT NULL,
  finished_at TEXT,
  keywords INTEGER NOT NULL DEFAULT 0,
  checked INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_domain ON scheduler_runs(domain_id, started_at);
