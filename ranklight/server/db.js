// Database bootstrap. Uses Node's built-in node:sqlite (no native deps).
// Core tables live here. Feature modules add tables via server/migrations/NNN-name.sql,
// which are applied in filename order and recorded in _migrations.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',          -- owner | admin | member | viewer
  organization_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS domains (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,                           -- e.g. example.com (no scheme)
  display_name TEXT NOT NULL DEFAULT '',
  include_subdomains INTEGER NOT NULL DEFAULT 1,
  exact_match INTEGER NOT NULL DEFAULT 0,
  default_country TEXT NOT NULL DEFAULT 'US',
  default_location TEXT NOT NULL DEFAULT '',
  default_language TEXT NOT NULL DEFAULT 'en',
  group_name TEXT NOT NULL DEFAULT 'Default',
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  phrase TEXT NOT NULL,
  search_engine TEXT NOT NULL DEFAULT 'google',  -- google | bing | youtube
  device TEXT NOT NULL DEFAULT 'desktop',        -- desktop | mobile
  country TEXT NOT NULL DEFAULT 'US',
  location TEXT NOT NULL DEFAULT '',             -- city / zip / free text, '' = national
  language TEXT NOT NULL DEFAULT 'en',
  preferred_url TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  ignore_local_pack INTEGER NOT NULL DEFAULT 0,
  search_volume INTEGER,                         -- latest known monthly volume
  cpc REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain_id, phrase, search_engine, device, country, location, language)
);
CREATE TABLE IF NOT EXISTS rank_snapshots (
  id INTEGER PRIMARY KEY,
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,                     -- ISO date-time (UTC)
  rank INTEGER,                                 -- organic position, NULL = not in top 100
  url TEXT,                                     -- ranking URL of the tracked domain
  serp_features TEXT NOT NULL DEFAULT '[]',     -- JSON array of feature ids present on SERP
  owned_features TEXT NOT NULL DEFAULT '[]',    -- JSON array of feature ids owned by the domain
  results TEXT NOT NULL DEFAULT '[]',           -- JSON array of {position,url,host,title}
  above_the_fold INTEGER,
  pixels_from_top INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snap_kw_time ON rank_snapshots(keyword_id, checked_at);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280',
  UNIQUE(domain_id, name)
);
CREATE TABLE IF NOT EXISTS keyword_tags (
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (keyword_id, tag_id)
);
CREATE TABLE IF NOT EXISTS competitors (
  id INTEGER PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain_id, host)
);
CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

export function openDb(file = process.env.DB_PATH || path.join(here, '..', 'data', 'ranklight.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(CORE_SCHEMA);
  runMigrations(db);
  return db;
}

export function runMigrations(db) {
  const dir = path.join(here, 'migrations');
  if (!fs.existsSync(dir)) return;
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map(r => r.name));
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      db.prepare('INSERT INTO _migrations(name) VALUES (?)').run(f);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${f} failed: ${e.message}`); }
  }
}

// Small helper: run fn inside a transaction.
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
