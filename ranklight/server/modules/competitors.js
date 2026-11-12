// Competitor management and head-to-head comparison. Uses the core `competitors` table only.
//   GET    /api/competitors?domainId=                 -> [{id, host, display_name, created_at}]
//   POST   /api/competitors?domainId=  {host, displayName?}  (domainId may also be in the body) -> 201 row
//   DELETE /api/competitors/:id?domainId=             -> {ok}
//   DELETE /api/competitors?domainId=&host=           -> {ok}
//   GET    /api/competitors/compare?domainId=         -> {competitors, keywords:[{..., you, ranks:{host:rank}}], summary:[...]}
//   GET    /api/competitors/suggest?domainId=&limit=  -> [{host, keywords, avgPosition, bestPosition}]
// Competitor positions come from the latest snapshot's `results` JSON (best organic position, subdomains included).
// Emits 'competitors:changed' {domainId, userId} after an add or delete.
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { hostMatches, hostOf, latestRanks } from '../lib/metrics.js';

const MAX_COMPETITORS = 25;
const UNRANKED = 101;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const round1 = n => Math.round(n * 10) / 10;

// Accepts "https://www.Example.com:443/path?q" or "example.com" and returns "example.com"; null if invalid.
export function normalizeHost(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return HOST_RE.test(host) ? host : null;
}

function parseId(v, name) {
  if (v === undefined || v === null || v === '') throw httpError(400, `${name} is required`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}

// host -> best organic position on one SERP.
function hostPositions(resultsJson) {
  const out = new Map();
  const list = parseJson(resultsJson, []);
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (!r || (r.type && r.type !== 'organic')) continue;
    const pos = Number(r.position), host = String(r.host || hostOf(r.url)).toLowerCase().replace(/^www\./, '');
    if (!host || !Number.isInteger(pos) || pos < 1) continue;
    if (!out.has(host) || pos < out.get(host)) out.set(host, pos);
  }
  return out;
}
function bestPosition(positions, host) {
  let best = null;
  for (const [h, p] of positions) if (hostMatches(h, host) && (best == null || p < best)) best = p;
  return best;
}

const listCompetitors = (db, domainId) =>
  db.prepare('SELECT id, host, display_name, created_at FROM competitors WHERE domain_id = ? ORDER BY id').all(domainId).map(r => ({ ...r }));

export function buildComparison(db, domain) {
  const competitors = listCompetitors(db, domain.id);
  const keywords = latestRanks(db, domain.id).sort((a, b) => a.phrase.localeCompare(b.phrase) || a.id - b.id).map(k => {
    const positions = hostPositions(k.results);
    return {
      id: k.id, phrase: k.phrase, searchEngine: k.search_engine, device: k.device, country: k.country, location: k.location,
      searchVolume: k.search_volume, checkedAt: k.checked_at, you: k.rank ?? null,
      ranks: Object.fromEntries(competitors.map(c => [c.host, k.checked_at ? bestPosition(positions, c.host) : null])),
    };
  });
  const checked = keywords.filter(k => k.checkedAt);
  const avg = xs => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const yourRanks = checked.map(k => k.you).filter(r => r != null);
  const summary = competitors.map(c => {
    let wins = 0, losses = 0, ties = 0;
    const theirs = [];
    for (const k of checked) {
      const r = k.ranks[c.host];
      if (r != null) theirs.push(r);
      if (k.you == null && r == null) continue;
      const mine = k.you ?? UNRANKED, other = r ?? UNRANKED;
      if (mine < other) wins++; else if (mine > other) losses++; else ties++;
    }
    return { id: c.id, host: c.host, displayName: c.display_name, wins, losses, ties, ranked: theirs.length,
      avgRank: avg(theirs), top10: theirs.filter(r => r <= 10).length };
  });
  return {
    domainId: domain.id, host: domain.host, competitors, keywords,
    you: { ranked: yourRanks.length, avgRank: avg(yourRanks), top10: yourRanks.filter(r => r <= 10).length, checked: checked.length },
    summary,
  };
}

export function buildSuggestions(db, domain, limit = 10) {
  const existing = listCompetitors(db, domain.id).map(c => c.host);
  const stats = new Map();
  for (const k of latestRanks(db, domain.id)) {
    if (!k.checked_at) continue;
    for (const [host, pos] of hostPositions(k.results)) {
      if (pos > 10 || hostMatches(host, domain.host, !!domain.include_subdomains) || existing.some(e => hostMatches(host, e))) continue;
      const s = stats.get(host) || { host, keywordIds: new Set(), positions: [] };
      if (!s.keywordIds.has(k.id)) { s.keywordIds.add(k.id); s.positions.push(pos); }
      stats.set(host, s);
    }
  }
  return [...stats.values()].map(s => ({
    host: s.host, keywords: s.keywordIds.size, bestPosition: Math.min(...s.positions),
    avgPosition: round1(s.positions.reduce((a, b) => a + b, 0) / s.positions.length),
  })).sort((a, b) => b.keywords - a.keywords || a.avgPosition - b.avgPosition || a.host.localeCompare(b.host)).slice(0, limit);
}

export default {
  name: 'competitors',
  router({ db, express, events }) {
    const r = express.Router();
    r.use(requireAuth);
    const domainFrom = (req, src = req.query) => loadOwnedDomain(db, req, parseId(src.domainId, 'domainId'));
    const changed = (domainId, req) => events?.emit('competitors:changed', { domainId, userId: req.user.id });

    r.get('/', (req, res) => res.json(listCompetitors(db, domainFrom(req).id)));

    r.post('/', (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const domain = domainFrom(req, req.query.domainId !== undefined ? req.query : body);
      if (typeof body.host !== 'string') throw httpError(400, 'host is required');
      const host = normalizeHost(body.host);
      if (!host) throw httpError(400, 'host must be a valid domain name, e.g. example.com');
      const displayName = body.displayName ?? body.display_name ?? '';
      if (typeof displayName !== 'string' || displayName.length > 100) throw httpError(400, 'displayName must be a string of at most 100 characters');
      if (hostMatches(host, domain.host, !!domain.include_subdomains)) throw httpError(400, 'A domain cannot be its own competitor');
      if (db.prepare('SELECT 1 FROM competitors WHERE domain_id = ? AND host = ?').get(domain.id, host)) throw httpError(409, 'Competitor already added');
      if (db.prepare('SELECT COUNT(*) AS n FROM competitors WHERE domain_id = ?').get(domain.id).n >= MAX_COMPETITORS)
        throw httpError(400, `At most ${MAX_COMPETITORS} competitors per domain`);
      const { lastInsertRowid } = db.prepare('INSERT INTO competitors(domain_id, host, display_name) VALUES (?,?,?)').run(domain.id, host, displayName.trim());
      changed(domain.id, req);
      res.status(201).json({ ...db.prepare('SELECT id, host, display_name, created_at FROM competitors WHERE id = ?').get(Number(lastInsertRowid)) });
    });

    const remove = (req, res, where, arg) => {
      const domain = domainFrom(req);
      const { changes } = db.prepare(`DELETE FROM competitors WHERE domain_id = ? AND ${where}`).run(domain.id, arg);
      if (!changes) throw httpError(404, 'Competitor not found');
      changed(domain.id, req);
      res.json({ ok: true });
    };
    r.delete('/', (req, res) => {
      const host = normalizeHost(typeof req.query.host === 'string' ? req.query.host : '');
      if (!host) throw httpError(400, 'host or a competitor id is required');
      remove(req, res, 'host = ?', host);
    });

    r.get('/compare', (req, res) => res.json(buildComparison(db, domainFrom(req))));

    r.get('/suggest', (req, res) => {
      const domain = domainFrom(req);
      let limit = 10;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw httpError(400, 'limit must be an integer between 1 and 50');
      }
      res.json(buildSuggestions(db, domain, limit));
    });

    r.delete('/:id', (req, res) => remove(req, res, 'id = ?', parseId(req.params.id, 'id')));
    return r;
  },
};
