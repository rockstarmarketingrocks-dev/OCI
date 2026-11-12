// Keyword detail: rank history, SERP snapshot viewer and ranking-URL history for one keyword.
// GET /api/keyword-history/:keywordId?days=90           -> {keyword, history, bestRank, worstRank, firstSeen, ...}
// GET /api/keyword-history/:keywordId/serp?date=YYYY-MM-DD -> top-100 of the snapshot nearest to `date` (default latest)
// GET /api/keyword-history/:keywordId/url-history?days=  -> ranking URL changes over time
// Uses core tables only (keywords, domains, rank_snapshots, competitors).
import { httpError, requireAuth, loadOwnedKeyword, parseJson } from '../lib/http.js';
import { hostMatches, hostOf } from '../lib/metrics.js';

const DAY = 864e5;
const MAX_DAYS = 3650;

function parseId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, 'keywordId must be a positive integer');
  return n;
}
function parseDays(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw httpError(400, `days must be an integer between 1 and ${MAX_DAYS}`);
  return n;
}
function parseDate(v) {
  if (v === undefined || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s)
    throw httpError(400, 'date must be a valid YYYY-MM-DD date');
  return s;
}
const sinceIso = days => (days == null ? '0000' : new Date(Date.now() - days * DAY).toISOString().slice(0, 10));

function keywordInfo(db, kw) {
  const d = db.prepare('SELECT host, display_name, include_subdomains FROM domains WHERE id = ?').get(kw.domain_id);
  return {
    id: kw.id, domainId: kw.domain_id, domainHost: d.host, domainName: d.display_name || d.host,
    phrase: kw.phrase, searchEngine: kw.search_engine, device: kw.device, country: kw.country, location: kw.location,
    language: kw.language, preferredUrl: kw.preferred_url, searchVolume: kw.search_volume, cpc: kw.cpc,
    starred: !!kw.starred, createdAt: kw.created_at,
  };
}

// Last snapshot of each UTC day since `since`, ascending.
function dailySnapshots(db, keywordId, since) {
  return db.prepare(`SELECT * FROM (
      SELECT s.*, ROW_NUMBER() OVER (PARTITION BY substr(checked_at,1,10) ORDER BY checked_at DESC, id DESC) AS rn
      FROM rank_snapshots s WHERE keyword_id = ? AND checked_at >= ?)
    WHERE rn = 1 ORDER BY checked_at`).all(keywordId, since);
}

export function buildHistory(db, kw, days) {
  const rows = dailySnapshots(db, kw.id, sinceIso(days));
  const history = rows.map(s => ({
    date: s.checked_at.slice(0, 10), checkedAt: s.checked_at, rank: s.rank, url: s.url,
    serp_features: parseJson(s.serp_features, []), owned_features: parseJson(s.owned_features, []),
  }));
  const ranks = history.map(h => h.rank).filter(r => r != null);
  const first = db.prepare('SELECT MIN(checked_at) AS t FROM rank_snapshots WHERE keyword_id = ? AND rank IS NOT NULL').get(kw.id).t;
  const latest = history.at(-1) ?? null;
  return {
    keyword: keywordInfo(db, kw), days, history,
    currentRank: latest?.rank ?? null, lastChecked: latest?.checkedAt ?? null,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    worstRank: ranks.length ? Math.max(...ranks) : null,
    firstSeen: first ? first.slice(0, 10) : null,  // first day the domain ranked for this keyword (all time)
  };
}

export function buildSerp(db, kw, date) {
  const snap = date
    ? db.prepare(`SELECT * FROM rank_snapshots WHERE keyword_id = ?
        ORDER BY abs(julianday(checked_at) - julianday(?)), checked_at DESC, id DESC LIMIT 1`).get(kw.id, date + 'T12:00:00Z')
    : db.prepare('SELECT * FROM rank_snapshots WHERE keyword_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1').get(kw.id);
  if (!snap) throw httpError(404, 'No SERP snapshot recorded for this keyword yet');
  const domain = db.prepare('SELECT host, include_subdomains FROM domains WHERE id = ?').get(kw.domain_id);
  const competitors = db.prepare('SELECT id, host, display_name FROM competitors WHERE domain_id = ?').all(kw.domain_id);
  const raw = parseJson(snap.results, []);
  const results = (Array.isArray(raw) ? raw : []).map((r, i) => {
    const host = String(r.host || hostOf(r.url) || '').toLowerCase();
    const comp = competitors.find(c => hostMatches(host, c.host, true));
    return {
      position: r.position ?? i + 1, url: r.url ?? null, host, title: r.title ?? '', type: r.type || 'organic',
      isDomain: !!host && hostMatches(host, domain.host, !!domain.include_subdomains),
      competitor: comp ? { id: comp.id, host: comp.host, name: comp.display_name || comp.host } : null,
    };
  }).sort((a, b) => a.position - b.position);
  const availableDates = db.prepare('SELECT DISTINCT substr(checked_at,1,10) AS d FROM rank_snapshots WHERE keyword_id = ? ORDER BY d').all(kw.id).map(r => r.d);
  return {
    keyword: keywordInfo(db, kw), requestedDate: date, date: snap.checked_at.slice(0, 10), checkedAt: snap.checked_at,
    rank: snap.rank, url: snap.url, serp_features: parseJson(snap.serp_features, []), owned_features: parseJson(snap.owned_features, []),
    competitors: competitors.map(c => ({ id: c.id, host: c.host, name: c.display_name || c.host })),
    availableDates, results,
  };
}

// Collapses consecutive snapshots with the same ranking URL into periods; `changes` lists each switch.
export function buildUrlHistory(db, kw, days) {
  const snaps = db.prepare('SELECT checked_at, rank, url FROM rank_snapshots WHERE keyword_id = ? AND checked_at >= ? ORDER BY checked_at, id')
    .all(kw.id, sinceIso(days));
  const periods = [];
  for (const s of snaps) {
    const url = s.url || null, cur = periods.at(-1);
    if (cur && cur.url === url) {
      cur.to = s.checked_at.slice(0, 10); cur.checks++; cur.lastRank = s.rank;
      if (s.rank != null) cur.bestRank = cur.bestRank == null ? s.rank : Math.min(cur.bestRank, s.rank);
    } else {
      periods.push({ url, from: s.checked_at.slice(0, 10), to: s.checked_at.slice(0, 10), checks: 1, firstRank: s.rank, lastRank: s.rank, bestRank: s.rank });
    }
  }
  const changes = periods.slice(1).map((p, i) => ({ date: p.from, from: periods[i].url, to: p.url, rank: p.firstRank }));
  const pref = kw.preferred_url;
  return {
    keyword: keywordInfo(db, kw), days, currentUrl: periods.at(-1)?.url ?? null,
    distinctUrls: new Set(periods.map(p => p.url).filter(Boolean)).size,
    periods: periods.map(p => ({ ...p, isPreferred: pref ? p.url === pref : null })),
    changes,
  };
}

export default {
  name: 'keyword-history',
  router({ db, express }) {
    const r = express.Router();
    r.use(requireAuth);
    const load = req => loadOwnedKeyword(db, req, parseId(req.params.keywordId));
    r.get('/:keywordId', (req, res) => {
      const days = parseDays(req.query.days, 90);
      res.json(buildHistory(db, load(req), days));
    });
    r.get('/:keywordId/serp', (req, res) => {
      const date = parseDate(req.query.date);
      res.json(buildSerp(db, load(req), date));
    });
    r.get('/:keywordId/url-history', (req, res) => {
      const days = parseDays(req.query.days, null);
      res.json(buildUrlHistory(db, load(req), days));
    });
    return r;
  },
};
