-- Dynamic tag rules: a tag with a rule set is "dynamic"; its keyword membership is
-- recomputed from the rules (see server/modules/tags.js).
-- rules: JSON array of {field, op, value}; match: 'all' | 'any'.
CREATE TABLE IF NOT EXISTS tag_rules (
  tag_id INTEGER PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  rules TEXT NOT NULL DEFAULT '[]',
  match TEXT NOT NULL DEFAULT 'all' CHECK (match IN ('all', 'any')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);
