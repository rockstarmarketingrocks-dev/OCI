-- Annotations on a domain's timeline (optionally pinned to one keyword). See server/modules/notes.js.
-- date: YYYY-MM-DD (UTC day). Deleting a keyword keeps its notes as domain-level notes.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  keyword_id INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_domain_date ON notes(domain_id, date);
CREATE INDEX IF NOT EXISTS idx_notes_keyword ON notes(keyword_id);
