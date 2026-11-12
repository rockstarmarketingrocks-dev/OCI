-- Outbound integrations (webhooks, Slack) and tokenized CSV feeds for BI tools. See server/modules/integrations.js.
-- config: JSON, shape depends on type. feed_token: only for looker_csv. last_status: human-readable result of the last delivery/fetch.
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'slack', 'looker_csv')),
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_sent_at TEXT,
  feed_token TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integrations_user ON integrations(user_id, type);
