// Google Search Console import (keyword discovery).
// Users upload a GSC "Queries" performance export (CSV); queries that the domain does not
// track yet are surfaced as opportunities and can be turned into tracked keywords.
//
// POST   /api/gsc-import/csv?domainId=            body: CSV text (text/csv) or JSON { csv }
// GET    /api/gsc-import/opportunities?domainId=  ?strikingOnly=1&limit=&q=
// POST   /api/gsc-import/track                    { domainId, queries: string[], device? }
// DELETE /api/gsc-import?domainId=                clears imported rows for the domain
// GET    /api/gsc-import/oauth/status             OAuth connector stub (see below)
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';
import { tx } from '../db.js';
import { enforceKeywordQuota } from '../lib/quota.js';

export const STRIKING_MIN = 8, STRIKING_MAX = 20;
const MAX_ROWS = 50000, MAX_TRACK = 1000, MAX_QUERY_LEN = 300;

const HEADERS = {
  query: ['top queries', 'query', 'queries', 'search query', 'top query', 'keyword'],
  page: ['page', 'top pages', 'landing page', 'url', 'address'],
  clicks: ['clicks', 'url clicks'],
  impressions: ['impressions'],
  ctr: ['ctr', 'url ctr', 'click-through rate'],
  position: ['position', 'average position', 'avg. position', 'avg position'],
};

export const normQuery = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// RFC 4180 style parser: quoted fields, escaped quotes, embedded delimiters/newlines, CRLF.
export function parseCsvRows(text, delim = ',') {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

const detectDelimiter = firstLine => {
  const counts = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
};

// Locale-tolerant number parsing: "1,234", "1 234", "12.5%", "8,3" (decimal comma).
export function parseNumber(raw) {
  let s = String(raw ?? '').replace(/[\s %]/g, '');
  if (!s || s === '-' || s === '–') return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Returns { rows: [{query, page, clicks, impressions, ctr, position}], skipped }.
export function parseGscCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!src.trim()) throw httpError(400, 'CSV is empty');
  const delim = detectDelimiter(src.split(/\r?\n/, 1)[0]);
  const [header, ...body] = parseCsvRows(src, delim);
  const names = header.map(h => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, alts]) => [k, names.findIndex(n => alts.includes(n))]));
  if (col.query < 0) throw httpError(400, 'CSV must have a "Top queries" or "Query" column');
  if (col.impressions < 0) throw httpError(400, 'CSV must have an "Impressions" column');
  if (body.length > MAX_ROWS) throw httpError(413, `CSV has too many rows (max ${MAX_ROWS})`);
  const rows = []; let skipped = 0;
  for (const r of body) {
    const query = normQuery(r[col.query]).slice(0, MAX_QUERY_LEN);
    const impressions = Math.round(parseNumber(r[col.impressions]) ?? NaN);
    if (!query || !Number.isFinite(impressions) || impressions < 0) { skipped++; continue; }
    const clicks = Math.max(0, Math.round(col.clicks >= 0 ? parseNumber(r[col.clicks]) ?? 0 : 0));
    let ctr = col.ctr >= 0 ? parseNumber(r[col.ctr]) : null;
    if (ctr != null && (String(r[col.ctr]).includes('%') || ctr > 1)) ctr /= 100;
    if (ctr == null) ctr = impressions ? clicks / impressions : 0;
    const position = col.position >= 0 ? parseNumber(r[col.position]) : null;
    const page = col.page >= 0 ? String(r[col.page] ?? '').trim() : '';
    rows.push({ query, page, clicks, impressions, ctr: Math.min(1, Math.max(0, ctr)), position: position > 0 ? position : null });
  }
  return { rows, skipped };
}

export const isStriking = pos => pos != null && pos >= STRIKING_MIN && pos <= STRIKING_MAX;

export default {
  name: 'gsc-import',
  router(ctx) {
    const { db, express, events } = ctx;
    const r = express.Router();
    r.use(requireAuth);
    const domainParam = v => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw httpError(400, 'domainId is required');
      return n;
    };

    // OAuth connector stub: live GSC API sync requires a Google OAuth client.
    // Set GSC_CLIENT_ID (and GSC_CLIENT_SECRET) to mark it configured; until then use CSV import.
    r.get('/oauth/status', (_req, res) => {
      const configured = Boolean(process.env.GSC_CLIENT_ID);
      res.json({ configured, connected: false, method: configured ? 'oauth' : 'csv',
        message: configured ? 'OAuth client configured. Live sync is not connected yet; CSV import remains available.'
          : 'Set GSC_CLIENT_ID to enable the Google Search Console OAuth connector. Use CSV import meanwhile.' });
    });

    r.post('/csv', (req, res) => {
      const domain = loadOwnedDomain(db, req, domainParam(req.query.domainId ?? req.body?.domainId));
      const text = typeof req.body === 'string' ? req.body : req.body?.csv;
      if (typeof text !== 'string') throw httpError(400, 'Send the CSV as text/csv or JSON { csv }');
      const { rows, skipped } = parseGscCsv(text);
      if (!rows.length) throw httpError(400, 'No valid query rows found in CSV');
      // Merge duplicate (query, page) rows within the file.
      const merged = new Map();
      for (const row of rows) {
        const k = `${row.query}\u0000${row.page}`, m = merged.get(k);
        if (!m) { merged.set(k, { ...row, posW: (row.position ?? 0) * row.impressions }); continue; }
        m.clicks += row.clicks; m.impressions += row.impressions; m.posW += (row.position ?? 0) * row.impressions;
        m.ctr = m.impressions ? m.clicks / m.impressions : 0;
        m.position = m.impressions ? m.posW / m.impressions : m.position ?? row.position;
      }
      const now = new Date().toISOString();
      const up = db.prepare(`INSERT INTO gsc_queries(domain_id, query, page, clicks, impressions, ctr, position, imported_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(domain_id, query, page) DO UPDATE SET clicks = excluded.clicks,
        impressions = excluded.impressions, ctr = excluded.ctr, position = excluded.position, imported_at = excluded.imported_at`);
      tx(db, () => { for (const m of merged.values()) up.run(domain.id, m.query, m.page, m.clicks, m.impressions, m.ctr, m.position == null ? null : Math.round(m.position * 100) / 100, now); });
      const total = db.prepare('SELECT COUNT(*) AS n FROM gsc_queries WHERE domain_id = ?').get(domain.id).n;
      res.status(201).json({ imported: merged.size, skipped, total, importedAt: now });
    });

    r.get('/opportunities', (req, res) => {
      const domain = loadOwnedDomain(db, req, domainParam(req.query.domainId));
      const limit = req.query.limit == null ? 500 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw httpError(400, 'limit must be an integer between 1 and 5000');
      const strikingOnly = ['1', 'true'].includes(String(req.query.strikingOnly));
      const search = normQuery(req.query.q);
      const rows = db.prepare(`
        SELECT g.query, SUM(g.clicks) AS clicks, SUM(g.impressions) AS impressions,
               SUM(g.position * g.impressions) / NULLIF(SUM(CASE WHEN g.position IS NOT NULL THEN g.impressions END), 0) AS position,
               AVG(g.position) AS avg_position, COUNT(*) AS pages, MAX(g.imported_at) AS imported_at,
               (SELECT page FROM gsc_queries p WHERE p.domain_id = g.domain_id AND p.query = g.query ORDER BY p.impressions DESC LIMIT 1) AS top_page
        FROM gsc_queries g
        WHERE g.domain_id = ? AND NOT EXISTS (SELECT 1 FROM keywords k WHERE k.domain_id = g.domain_id AND lower(trim(k.phrase)) = g.query)
          AND instr(g.query, ?) > 0
        GROUP BY g.query ORDER BY impressions DESC, clicks DESC, g.query`).all(domain.id, search);
      const all = rows.map(o => {
        const position = o.position ?? o.avg_position;
        const pos = position == null ? null : Math.round(position * 10) / 10;
        const striking = isStriking(pos);
        return { query: o.query, clicks: o.clicks, impressions: o.impressions, ctr: o.impressions ? o.clicks / o.impressions : 0,
          position: pos, page: o.top_page || null, pages: o.pages, importedAt: o.imported_at,
          strikingDistance: striking, flags: striking ? ['striking distance'] : [] };
      });
      const filtered = strikingOnly ? all.filter(o => o.strikingDistance) : all;
      const stats = db.prepare('SELECT COUNT(DISTINCT query) AS queries, MAX(imported_at) AS last FROM gsc_queries WHERE domain_id = ?').get(domain.id);
      res.json({ total: filtered.length, imported: stats.queries, lastImportedAt: stats.last,
        strikingDistance: all.filter(o => o.strikingDistance).length, opportunities: filtered.slice(0, limit) });
    });

    r.post('/track', (req, res) => {
      const { domainId, queries, device = 'desktop' } = req.body || {};
      const domain = loadOwnedDomain(db, req, domainParam(domainId));
      if (!Array.isArray(queries) || !queries.length) throw httpError(400, 'queries must be a non-empty array of strings');
      if (queries.length > MAX_TRACK) throw httpError(400, `At most ${MAX_TRACK} queries per request`);
      if (!['desktop', 'mobile'].includes(device)) throw httpError(400, 'device must be desktop or mobile');
      if (queries.some(q => typeof q !== 'string')) throw httpError(400, 'queries must be strings');
      const phrases = [...new Set(queries.map(normQuery).filter(Boolean))];
      if (!phrases.length) throw httpError(400, 'queries must contain at least one non-empty phrase');
      if (phrases.some(p => p.length > MAX_QUERY_LEN)) throw httpError(400, `queries must be at most ${MAX_QUERY_LEN} characters`);
      const ins = db.prepare(`INSERT OR IGNORE INTO keywords(domain_id, phrase, device, country, location, language) VALUES (?,?,?,?,?,?)`);
      const keywordIds = [];
      tx(db, () => {
        for (const p of phrases) {
          const { changes, lastInsertRowid } = ins.run(domain.id, p, device, domain.default_country, domain.default_location, domain.default_language);
          if (changes) keywordIds.push(Number(lastInsertRowid));
        }
        if (keywordIds.length) enforceKeywordQuota(ctx, req.user.id);
      });
      if (keywordIds.length) events.emit('keywords:added', { domainId: domain.id, keywordIds });
      res.status(201).json({ added: keywordIds.length, skipped: phrases.length - keywordIds.length, keywordIds });
    });

    r.delete('/', (req, res) => {
      const domain = loadOwnedDomain(db, req, domainParam(req.query.domainId));
      const { changes } = db.prepare('DELETE FROM gsc_queries WHERE domain_id = ?').run(domain.id);
      res.json({ deleted: Number(changes) });
    });
    return r;
  },
};
