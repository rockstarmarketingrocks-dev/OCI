// Import/export: CSV keyword + history exports, full JSON domain backup, CSV keyword import.
// Routes (all require auth and an owned ?domainId=):
//   GET  /api/exports/keywords.csv   latest rank per keyword with change vs. previous day
//   GET  /api/exports/history.csv    long format date,keyword,device,rank,url (&days=1..3650, default 30)
//   GET  /api/exports/domain.json    full backup of the domain (keywords, tags, competitors, snapshots)
//   POST /api/exports/import         CSV (text/csv body or JSON {csv}) keyword[,device,country,location,tags]
//                                    &dryRun=1 validates without writing and returns per-row preview.
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { rankChange } from '../lib/metrics.js';
import { tx } from '../db.js';
import { enforceKeywordQuota } from '../lib/quota.js';

const DEVICES = ['desktop', 'mobile'];
const MAX_ROWS = 10000;
const normPhrase = p => String(p ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const normTag = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

// ---- CSV ----
// Quote when needed; neutralise spreadsheet formulas in text cells (undone on import).
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header, rows) => '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// RFC 4180 parser: quoted fields, escaped quotes, embedded newlines, CRLF/LF. Returns [{line, cells}] skipping blank lines.
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const out = [];
  let row = [], cell = '', quoted = false, line = 1, rowLine = 1, i = 0;
  const endRow = () => { row.push(cell); if (row.some(c => c.trim() !== '')) out.push({ line: rowLine, cells: row }); row = []; cell = ''; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else { if (c === '\n') line++; cell += c; }
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' || c === '\n') { if (c === '\r' && src[i + 1] === '\n') i++; endRow(); line++; rowLine = line; }
    else cell += c;
    i++;
  }
  if (quoted) throw httpError(400, `Unterminated quoted field starting on line ${rowLine}`);
  if (cell !== '' || row.length) endRow();
  return out;
}
const unguard = s => s.replace(/^'(?=[=+\-@])/, '');

const intParam = (v, name, min, max, dflt) => {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
};
const fileStem = d => String(d.host).replace(/[^a-z0-9.-]+/gi, '_');
const send = (res, type, name, body) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body);
};

export default {
  name: 'exports',
  router(ctx) {
    const { db, express, events } = ctx;
    const r = express.Router();
    r.use(requireAuth);
    const domainOf = req => {
      const id = intParam(req.query.domainId, 'domainId', 1, Number.MAX_SAFE_INTEGER, null);
      if (id == null) throw httpError(400, 'domainId is required');
      return loadOwnedDomain(db, req, id);
    };
    const tagMap = domainId => {
      const m = new Map();
      for (const t of db.prepare(`SELECT kt.keyword_id, t.name FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id
                                  WHERE t.domain_id = ? ORDER BY t.name`).all(domainId)) {
        (m.get(t.keyword_id) || m.set(t.keyword_id, []).get(t.keyword_id)).push(t.name);
      }
      return m;
    };

    r.get('/keywords.csv', (req, res) => {
      const d = domainOf(req);
      const tags = tagMap(d.id);
      // Latest snapshot, and the latest snapshot from an earlier day for the change column.
      const rows = db.prepare(`
        SELECT k.id, k.phrase, k.device, k.country, k.location, k.search_volume, s.rank, s.url, s.serp_features,
          (SELECT p.rank FROM rank_snapshots p WHERE p.keyword_id = k.id AND substr(p.checked_at,1,10) < substr(s.checked_at,1,10)
           ORDER BY p.checked_at DESC LIMIT 1) AS prev_rank,
          (SELECT 1 FROM rank_snapshots p WHERE p.keyword_id = k.id AND substr(p.checked_at,1,10) < substr(s.checked_at,1,10) LIMIT 1) AS has_prev
        FROM keywords k
        LEFT JOIN rank_snapshots s ON s.id = (SELECT id FROM rank_snapshots WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1)
        WHERE k.domain_id = ? ORDER BY k.phrase, k.device, k.country, k.location`).all(d.id);
      const out = rows.map(k => [k.phrase, k.device, k.country, k.location, (tags.get(k.id) || []).join(';'), k.rank,
        k.has_prev ? rankChange(k.prev_rank, k.rank) : null, k.url, k.search_volume, (parseJson(k.serp_features, []) || []).join(';')]);
      send(res, 'text/csv; charset=utf-8', `${fileStem(d)}-keywords.csv`,
        toCsv(['phrase', 'device', 'country', 'location', 'tags', 'rank', 'change', 'url', 'volume', 'features'], out));
    });

    r.get('/history.csv', (req, res) => {
      const d = domainOf(req);
      const days = intParam(req.query.days, 'days', 1, 3650, 30);
      const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
      // Last snapshot per keyword per day.
      const rows = db.prepare(`
        SELECT substr(s.checked_at,1,10) AS date, k.phrase, k.device, s.rank, s.url
        FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
        WHERE k.domain_id = ? AND s.checked_at >= ? AND s.id = (
          SELECT s2.id FROM rank_snapshots s2 WHERE s2.keyword_id = s.keyword_id AND substr(s2.checked_at,1,10) = substr(s.checked_at,1,10)
          ORDER BY s2.checked_at DESC, s2.id DESC LIMIT 1)
        ORDER BY date, k.phrase, k.device, k.id`).all(d.id, since);
      send(res, 'text/csv; charset=utf-8', `${fileStem(d)}-history-${days}d.csv`,
        toCsv(['date', 'keyword', 'device', 'rank', 'url'], rows.map(x => [x.date, x.phrase, x.device, x.rank, x.url])));
    });

    r.get('/domain.json', (req, res) => {
      const d = domainOf(req);
      const tags = tagMap(d.id);
      const snaps = new Map();
      for (const s of db.prepare(`SELECT s.* FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
                                  WHERE k.domain_id = ? ORDER BY s.keyword_id, s.checked_at`).all(d.id)) {
        const list = snaps.get(s.keyword_id) || snaps.set(s.keyword_id, []).get(s.keyword_id);
        list.push({ checked_at: s.checked_at, rank: s.rank, url: s.url, serp_features: parseJson(s.serp_features, []),
          owned_features: parseJson(s.owned_features, []), results: parseJson(s.results, []),
          above_the_fold: s.above_the_fold, pixels_from_top: s.pixels_from_top });
      }
      const { user_id, ...domain } = d;
      const backup = {
        format: 'ranklight-domain-backup', version: 1, exportedAt: new Date().toISOString(),
        domain,
        tags: db.prepare('SELECT name, color FROM tags WHERE domain_id = ? ORDER BY name').all(d.id),
        competitors: db.prepare('SELECT host, display_name, created_at FROM competitors WHERE domain_id = ? ORDER BY host').all(d.id),
        keywords: db.prepare('SELECT * FROM keywords WHERE domain_id = ? ORDER BY id').all(d.id).map(({ domain_id, ...k }) =>
          ({ ...k, tags: tags.get(k.id) || [], snapshots: snaps.get(k.id) || [] })),
      };
      send(res, 'application/json; charset=utf-8', `${fileStem(d)}-backup.json`, JSON.stringify(backup, null, 2));
    });

    r.post('/import', (req, res) => {
      const d = domainOf(req);
      const dryRun = ['1', 'true'].includes(String(req.query.dryRun ?? ''));
      const text = typeof req.body === 'string' ? req.body : req.body?.csv;
      if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Send CSV as a text/csv body or JSON {"csv": "..."}');
      let rows = parseCsv(text);
      if (!rows.length) throw httpError(400, 'CSV has no rows');

      // Header row is optional; without it columns are positional: keyword,device,country,location,tags.
      const COLS = ['keyword', 'device', 'country', 'location', 'tags'];
      const ALIAS = { phrase: 'keyword', keywords: 'keyword', tag: 'tags' };
      const head = rows[0].cells.map(c => { const n = c.trim().toLowerCase(); return ALIAS[n] || n; });
      let idx = Object.fromEntries(COLS.map((c, i) => [c, i]));
      if (head.includes('keyword')) {
        idx = Object.fromEntries(COLS.map(c => [c, head.indexOf(c)]));
        rows = rows.slice(1);
      } else if (COLS.slice(1).some(c => head.includes(c))) throw httpError(400, 'CSV header must include a "keyword" column');
      if (rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} rows per import`);

      const exists = db.prepare(`SELECT 1 FROM keywords WHERE domain_id = ? AND phrase = ? AND search_engine = 'google'
                                 AND device = ? AND country = ? AND location = ? AND language = ?`);
      const seen = new Set();
      const errors = [], preview = [], valid = [];
      for (const { line, cells } of rows) {
        const get = c => (idx[c] >= 0 ? unguard(String(cells[idx[c]] ?? '').trim()) : '');
        const phrase = normPhrase(get('keyword'));
        const device = (get('device') || 'desktop').toLowerCase();
        const country = (get('country') || d.default_country).toUpperCase();
        const location = get('location') || d.default_location;
        const tags = [...new Set(get('tags').split(/[;|,]/).map(normTag).filter(Boolean))];
        let error = null;
        if (!phrase) error = 'keyword is empty';
        else if (phrase.length > 200) error = 'keyword is longer than 200 characters';
        else if (!DEVICES.includes(device)) error = `device must be one of: ${DEVICES.join(', ')}`;
        else if (!/^[A-Z]{2}$/.test(country)) error = 'country must be a 2-letter code';
        else if (location.length > 200) error = 'location is longer than 200 characters';
        const key = JSON.stringify([phrase, device, country, location]);
        let status = 'add';
        if (error) { status = 'error'; errors.push({ line, error }); }
        else if (seen.has(key) || exists.get(d.id, phrase, device, country, location, d.default_language)) status = 'skip';
        else { seen.add(key); valid.push({ phrase, device, country, location, tags }); }
        if (dryRun) preview.push({ line, keyword: phrase, device, country, location, tags, status, ...(error && { error }) });
      }
      const skipped = rows.length - valid.length - errors.length;
      if (dryRun) return res.json({ dryRun: true, added: valid.length, skipped, errors, rows: preview });

      const keywordIds = tx(db, () => {
        const ins = db.prepare(`INSERT OR IGNORE INTO keywords(domain_id, phrase, device, country, location, language) VALUES (?,?,?,?,?,?)`);
        const addTag = db.prepare('INSERT OR IGNORE INTO tags(domain_id, name) VALUES (?,?)');
        const tagId = db.prepare('SELECT id FROM tags WHERE domain_id = ? AND name = ?');
        const link = db.prepare('INSERT OR IGNORE INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)');
        const ids = [];
        for (const k of valid) {
          const { changes, lastInsertRowid } = ins.run(d.id, k.phrase, k.device, k.country, k.location, d.default_language);
          if (!changes) continue;
          const id = Number(lastInsertRowid);
          ids.push(id);
          for (const t of k.tags) { addTag.run(d.id, t); link.run(id, tagId.get(d.id, t).id); }
        }
        if (ids.length) enforceKeywordQuota(ctx, req.user.id);
        return ids;
      });
      if (keywordIds.length) events.emit('keywords:added', { domainId: d.id, keywordIds });
      res.status(keywordIds.length ? 201 : 200).json({ added: keywordIds.length, skipped: rows.length - errors.length - keywordIds.length, errors, keywordIds });
    });
    return r;
  },
};
