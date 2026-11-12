-- Shareable read-only dashboard links. See server/modules/public-share.js.
-- expires_at: ISO UTC timestamp or NULL (never expires). password_hash: scrypt "salt:hash" or NULL.
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  password_hash TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_share_links_user ON share_links(user_id, domain_id);
