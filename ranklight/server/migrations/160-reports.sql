-- Scheduled rank reports delivered by email (or written to data/outbox). See server/modules/reports.js.
-- recipients / sections: JSON arrays. days: reporting period length. Timestamps are ISO UTC.
CREATE TABLE IF NOT EXISTS report_schedules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  format TEXT NOT NULL DEFAULT 'html' CHECK (format IN ('html', 'csv', 'pdf-html')),
  recipients TEXT NOT NULL DEFAULT '[]',
  sections TEXT NOT NULL DEFAULT '["kpis","chart","movers","keywords"]',
  days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_user ON report_schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_report_schedules_domain ON report_schedules(domain_id);
