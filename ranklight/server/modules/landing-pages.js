// Landing pages: how the tracked domain's ranking URLs perform, based on the latest snapshot per keyword.
// GET /api/landing-pages?domainId=                 -> { totals, pages: [{url, keywords, avgRank, bestRank, totalVolume, estimatedClicks, sov, share}] }
// GET /api/landing-pages/detail?domainId=&url=     -> { url, keywords: [{id, phrase, rank, previousRank, change, volume, estimatedClicks, preferredUrl, ...}] }
// GET /api/landing-pages/cannibalization?domainId=&days=30
//                                                  -> { keywords: [{id, phrase, currentUrl, switches, urls: [{url, snapshots, bestRank, firstSeen, lastSeen}]}] }
// GET /api/landing-pages/mismatches?domainId=      -> { keywords: [{id, phrase, preferredUrl, rankingUrl, rank, preferredPosition}] }
// sov   = the page's estimated clicks as % of the clicks every checked keyword would get at #1 (sums to the domain's SoV).
// share = the page's estimated clicks as % of the domain's total estimated clicks.
// URLs are compared normalized (scheme, www., trailing slash and fragment ignored); the first-seen spelling is displayed.
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { estimatedClicks, rankChange } from '../lib/metrics.js';

const DAY = 864e5;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (num, den) => (den ? round(num / den * 100) : 0);

export function normalizeUrl(u) {
  const s = String(u ?? '').trim();
  if (!s) return '';
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    const path = x.pathname.replace(/\/+$/, '');
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.port ? ':' + x.port : ''}${path}${x.search}`;
  } catch { return s.toLowerCase().replace(/#.*$/, '').replace(/\/+$/, ''); }
}

function intParam(v, name, { min = 1, max = Number.MAX_SAFE_INTEGER, def } = {}) {
  if (v === undefined || v === '') {
    if (def === undefined) throw httpError(400, `${name} is required`);
    return def;
  }
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}

// Latest and previous snapshot per keyword of a domain (keywords without snapshots have null snapshot fields).
function latestTwo(db, domainId) {
  return db.prepare(`
    WITH ranked AS (
      SELECT s.keyword_id, s.rank, s.url, s.results, s.checked_at,
             ROW_NUMBER() OVER (PARTITION BY s.keyword_id ORDER BY s.checked_at DESC, s.id DESC) AS rn
      FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ?)
    SELECT k.id, k.phrase, k.search_engine, k.device, k.country, k.location, k.preferred_url, k.search_volume,
           cur.rank, cur.url, cur.results, cur.checked_at, prev.rank AS prev_rank, prev.url AS prev_url,
           (cur.keyword_id IS NOT NULL) AS checked, (prev.keyword_id IS NOT NULL) AS has_prev
    FROM keywords k
    LEFT JOIN ranked cur ON cur.keyword_id = k.id AND cur.rn = 1
    LEFT JOIN ranked prev ON prev.keyword_id = k.id AND prev.rn = 2
    WHERE k.domain_id = ? ORDER BY k.id`).all(domainId, domainId);
}

export function buildLandingPages(db, domain) {
  const rows = latestTwo(db, domain.id).filter(r => r.checked);
  const maxClicks = rows.reduce((a, r) => a + estimatedClicks(1, r.search_volume), 0);
  const groups = new Map();
  let unranked = 0;
  for (const r of rows) {
    const key = normalizeUrl(r.url);
    if (r.rank == null || !key) { unranked++; continue; }
    const g = groups.get(key) || { url: r.url, ranks: [], totalVolume: 0, clicks: 0 };
    g.ranks.push(r.rank);
    g.totalVolume += r.search_volume || 0;
    g.clicks += estimatedClicks(r.rank, r.search_volume);
    groups.set(key, g);
  }
  const totalClicks = [...groups.values()].reduce((a, g) => a + g.clicks, 0);
  const pages = [...groups.values()].map(g => ({
    url: g.url,
    keywords: g.ranks.length,
    avgRank: round(g.ranks.reduce((a, b) => a + b, 0) / g.ranks.length, 1),
    bestRank: Math.min(...g.ranks),
    totalVolume: g.totalVolume,
    estimatedClicks: round(g.clicks, 1),
    sov: pct(g.clicks, maxClicks),
    share: pct(g.clicks, totalClicks),
  })).sort((a, b) => b.estimatedClicks - a.estimatedClicks || b.keywords - a.keywords || a.bestRank - b.bestRank || a.url.localeCompare(b.url));
  return {
    domainId: domain.id,
    totals: {
      pages: pages.length, rankedKeywords: rows.length - unranked, unrankedKeywords: unranked,
      estimatedClicks: round(totalClicks, 1), sov: pct(totalClicks, maxClicks),
    },
    pages,
  };
}

export function buildDetail(db, domain, url) {
  const key = normalizeUrl(url);
  const matching = latestTwo(db, domain.id).filter(r => r.checked && r.rank != null && normalizeUrl(r.url) === key);
  const keywords = matching.map(r => ({
      id: r.id, phrase: r.phrase, searchEngine: r.search_engine, device: r.device, country: r.country, location: r.location,
      rank: r.rank, previousRank: r.prev_rank, change: r.has_prev ? rankChange(r.prev_rank, r.rank) : null,
      previousUrl: r.prev_url && normalizeUrl(r.prev_url) !== key ? r.prev_url : null,
      volume: r.search_volume, estimatedClicks: round(estimatedClicks(r.rank, r.search_volume), 1),
      preferredUrl: r.preferred_url || null,
      preferredMatch: r.preferred_url ? normalizeUrl(r.preferred_url) === key : null,
      checkedAt: r.checked_at,
    }))
    .sort((a, b) => a.rank - b.rank || (b.volume || 0) - (a.volume || 0) || a.phrase.localeCompare(b.phrase));
  return { domainId: domain.id, url: matching[0]?.url ?? url, keywords };
}

export function buildCannibalization(db, domain, days, now = Date.now()) {
  const since = new Date(now - days * DAY).toISOString();
  const snaps = db.prepare(`SELECT s.keyword_id, s.rank, s.url, s.checked_at, k.phrase, k.search_volume, k.device, k.country, k.location
    FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
    WHERE k.domain_id = ? AND s.checked_at >= ? AND s.url IS NOT NULL AND s.url != '' AND s.rank IS NOT NULL
    ORDER BY s.keyword_id, s.checked_at, s.id`).all(domain.id, since);
  const byKw = new Map();
  for (const s of snaps) {
    let kw = byKw.get(s.keyword_id);
    if (!kw) byKw.set(s.keyword_id, kw = { s, urls: new Map(), switches: 0, lastKey: null, current: null });
    const key = normalizeUrl(s.url);
    if (kw.lastKey && kw.lastKey !== key) kw.switches++;
    kw.lastKey = key;
    kw.current = s;
    const u = kw.urls.get(key) || { url: s.url, snapshots: 0, bestRank: s.rank, firstSeen: s.checked_at, lastSeen: s.checked_at };
    u.snapshots++;
    u.bestRank = Math.min(u.bestRank, s.rank);
    u.lastSeen = s.checked_at;
    kw.urls.set(key, u);
  }
  const keywords = [...byKw.entries()].filter(([, kw]) => kw.urls.size >= 2).map(([id, kw]) => ({
    id, phrase: kw.s.phrase, device: kw.s.device, country: kw.s.country, location: kw.s.location, volume: kw.s.search_volume,
    currentUrl: kw.current.url, currentRank: kw.current.rank, switches: kw.switches,
    urls: [...kw.urls.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)),
  })).sort((a, b) => b.urls.length - a.urls.length || b.switches - a.switches || (b.volume || 0) - (a.volume || 0) || a.phrase.localeCompare(b.phrase));
  return { domainId: domain.id, days, since, keywords };
}

// Best organic position of the preferred URL in a stored SERP, or null.
function preferredPosition(resultsJson, preferredKey) {
  const list = parseJson(resultsJson, []);
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const r of list) {
    if (!r || (r.type && r.type !== 'organic') || normalizeUrl(r.url) !== preferredKey) continue;
    const p = Number(r.position);
    if (Number.isInteger(p) && p > 0 && (best == null || p < best)) best = p;
  }
  return best;
}

export function buildMismatches(db, domain) {
  const keywords = latestTwo(db, domain.id)
    .filter(r => r.checked && r.rank != null && r.url && r.preferred_url && normalizeUrl(r.preferred_url) !== normalizeUrl(r.url))
    .map(r => ({
      id: r.id, phrase: r.phrase, device: r.device, country: r.country, location: r.location, volume: r.search_volume,
      preferredUrl: r.preferred_url, rankingUrl: r.url, rank: r.rank,
      preferredPosition: preferredPosition(r.results, normalizeUrl(r.preferred_url)),
      estimatedClicks: round(estimatedClicks(r.rank, r.search_volume), 1), checkedAt: r.checked_at,
    }))
    .sort((a, b) => (b.volume || 0) - (a.volume || 0) || a.rank - b.rank || a.phrase.localeCompare(b.phrase));
  const withPreferred = db.prepare("SELECT COUNT(*) AS n FROM keywords WHERE domain_id = ? AND preferred_url IS NOT NULL AND preferred_url != ''").get(domain.id).n;
  return { domainId: domain.id, keywordsWithPreferredUrl: withPreferred, keywords };
}

export default {
  name: 'landing-pages',
  router({ db, express }) {
    const r = express.Router();
    r.use(requireAuth);
    const domainOf = req => loadOwnedDomain(db, req, intParam(req.query.domainId, 'domainId'));
    r.get('/', (req, res) => res.json(buildLandingPages(db, domainOf(req))));
    r.get('/detail', (req, res) => {
      const domain = domainOf(req);
      const { url } = req.query;
      if (typeof url !== 'string' || !url.trim()) throw httpError(400, 'url is required');
      if (url.length > 2048) throw httpError(400, 'url is too long');
      res.json(buildDetail(db, domain, url.trim()));
    });
    r.get('/cannibalization', (req, res) => {
      const domain = domainOf(req);
      res.json(buildCannibalization(db, domain, intParam(req.query.days, 'days', { max: 365, def: 30 })));
    });
    r.get('/mismatches', (req, res) => res.json(buildMismatches(db, domainOf(req))));
    return r;
  },
};
