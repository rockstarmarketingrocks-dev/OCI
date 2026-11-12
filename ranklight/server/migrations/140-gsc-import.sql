-- Google Search Console query data imported for keyword discovery (gsc-import module).
CREATE TABLE IF NOT EXISTS gsc_queries (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  query TEXT NOT NULL,                 -- normalized: trimmed, single-spaced, lowercase
  page TEXT NOT NULL DEFAULT '',       -- landing page when the export has one, '' otherwise
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,         -- fraction 0..1
  position REAL,                       -- average position
  imported_at TEXT NOT NULL,
  UNIQUE(domain_id, query, page)
);
CREATE INDEX IF NOT EXISTS idx_gsc_queries_domain ON gsc_queries(domain_id, impressions DESC);
