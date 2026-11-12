-- Search volume enrichment: monthly volume history per keyword plus latest competition score.
CREATE TABLE IF NOT EXISTS keyword_volume_history (
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                          -- YYYY-MM
  volume INTEGER NOT NULL,
  PRIMARY KEY (keyword_id, month)
);
CREATE TABLE IF NOT EXISTS keyword_volume_meta (
  keyword_id INTEGER PRIMARY KEY REFERENCES keywords(id) ON DELETE CASCADE,
  competition REAL,                             -- 0..1
  updated_at TEXT NOT NULL
);
