-- Alert rules and the notifications they produce. See server/modules/alerts.js.
-- alert_rules.domain_id NULL = applies to all of the user's domains. threshold meaning depends on type:
--   rank_drop / rank_gain: minimum positions moved; enters_top / leaves_top: the top-N boundary; others: unused.
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rank_drop','rank_gain','enters_top','leaves_top','url_change','feature_lost')),
  threshold INTEGER,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  channels TEXT NOT NULL DEFAULT '["inapp"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id INTEGER REFERENCES domains(id) ON DELETE CASCADE,
  keyword_id INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
  rule_id INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',        -- JSON {prevRank, rank, prevUrl, url, features}
  snapshot_id INTEGER,                       -- latest snapshot that triggered it (dedup key)
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(rule_id, keyword_id, snapshot_id);
