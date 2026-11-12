// Search volume enrichment: pulls monthly volume, CPC, competition and a 12-month trend from ctx.provider.
// POST /api/search-volume/refresh {domainId, keywordIds?} -> { domainId, requested, updated, missing, updatedAt }
// GET  /api/search-volume?domainId=                      -> { domainId, providerAvailable, months[12], keywords: [...], totals }
// Listens to 'keywords:added' and enriches the new keywords when a provider is installed.
// Emits 'search-volume:updated' { domainId, keywordIds } after keywords were enriched.
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';
import { tx } from '../db.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const MAX_IDS = 5000;

// The 12 months ending with the month of `now`, oldest first, as YYYY-MM.
export function lastMonths(now = new Date(), n = 12) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - (n - 1) + i, 1)).toISOString().slice(0, 7));
}

function parseDomainId(v) {
  if (v === undefined || v === null || v === '') throw httpError(400, 'domainId is required');
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw httpError(400, 'domainId must be a positive integer');
  return n;
}

const num = (v, { int = false, min = 0, max = Infinity } = {}) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return null;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
};

// Fetch volumes for the given keyword rows (grouped by country/language) and persist them.
// Returns the ids that were updated.
export async function enrichKeywords(ctx, rows, now = new Date()) {
  const { db, provider } = ctx;
  if (!provider) throw httpError(503, 'No search volume provider is configured');
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.country}|${r.language}`;
    (groups.get(key) || groups.set(key, { country: r.country, language: r.language, rows: [] }).get(key)).rows.push(r);
  }
  const results = [];
  for (const g of groups.values()) {
    const phrases = [...new Set(g.rows.map(r => r.phrase))];
    let data;
    try { data = await provider.fetchVolume(phrases, { country: g.country, language: g.language }); }
    catch (e) { throw httpError(502, `Search volume provider failed: ${e.message}`); }
    for (const r of g.rows) { const v = data?.[r.phrase]; if (v) results.push([r, v]); }
  }
  const months = lastMonths(now), updatedAt = now.toISOString();
  const setKw = db.prepare('UPDATE keywords SET search_volume = ?, cpc = ? WHERE id = ?');
  const setMeta = db.prepare(`INSERT INTO keyword_volume_meta(keyword_id, competition, updated_at) VALUES (?,?,?)
    ON CONFLICT(keyword_id) DO UPDATE SET competition = excluded.competition, updated_at = excluded.updated_at`);
  const setHist = db.prepare(`INSERT INTO keyword_volume_history(keyword_id, month, volume) VALUES (?,?,?)
    ON CONFLICT(keyword_id, month) DO UPDATE SET volume = excluded.volume`);
  tx(db, () => {
    for (const [r, v] of results) {
      const volume = num(v.volume, { int: true });
      setKw.run(volume, num(v.cpc), r.id);
      setMeta.run(r.id, num(v.competition, { max: 1 }), updatedAt);
      const trend = Array.isArray(v.trend) ? v.trend.slice(-12) : [];
      const offset = months.length - trend.length;
      trend.forEach((t, i) => { const tv = num(t, { int: true }); if (tv != null) setHist.run(r.id, months[offset + i], tv); });
      if (!trend.length && volume != null) setHist.run(r.id, months.at(-1), volume);
    }
  });
  return results.map(([r]) => r.id);
}

export function buildReport(db, domainId, providerAvailable, now = new Date()) {
  const months = lastMonths(now);
  const rows = db.prepare(`SELECT k.id, k.phrase, k.search_engine, k.device, k.country, k.location, k.language,
      k.search_volume, k.cpc, m.competition, m.updated_at
    FROM keywords k LEFT JOIN keyword_volume_meta m ON m.keyword_id = k.id
    WHERE k.domain_id = ? ORDER BY k.search_volume IS NULL, k.search_volume DESC, k.phrase`).all(domainId);
  const hist = new Map();
  for (const h of db.prepare(`SELECT h.keyword_id, h.month, h.volume FROM keyword_volume_history h JOIN keywords k ON k.id = h.keyword_id
      WHERE k.domain_id = ? AND h.month >= ? AND h.month <= ?`).all(domainId, months[0], months.at(-1)))
    (hist.get(h.keyword_id) || hist.set(h.keyword_id, new Map()).get(h.keyword_id)).set(h.month, h.volume);
  const totalTrend = months.map(() => null);
  const keywords = rows.map(r => {
    const hm = hist.get(r.id);
    const trend = months.map((m, i) => {
      const v = hm?.get(m) ?? null;
      if (v != null) totalTrend[i] = (totalTrend[i] ?? 0) + v;
      return v;
    });
    return {
      id: r.id, phrase: r.phrase, searchEngine: r.search_engine, device: r.device, country: r.country, location: r.location, language: r.language,
      volume: r.search_volume, cpc: r.cpc, competition: r.competition, trend, updatedAt: r.updated_at,
    };
  });
  const withVol = keywords.filter(k => k.volume != null), withCpc = keywords.filter(k => k.cpc != null), withComp = keywords.filter(k => k.competition != null);
  const avg = (list, f) => (list.length ? round(list.reduce((a, k) => a + f(k), 0) / list.length) : null);
  return {
    domainId, providerAvailable, months, keywords,
    totals: {
      keywords: keywords.length,
      withVolume: withVol.length,
      volume: withVol.reduce((a, k) => a + k.volume, 0),
      avgCpc: avg(withCpc, k => k.cpc),
      avgCompetition: avg(withComp, k => k.competition),
      // Monthly value if every keyword's volume were bought as clicks at its CPC.
      trafficValue: round(keywords.reduce((a, k) => a + (k.volume || 0) * (k.cpc || 0), 0)),
      trend: totalTrend,
      lastUpdated: keywords.reduce((a, k) => (k.updatedAt && (!a || k.updatedAt > a) ? k.updatedAt : a), null),
    },
  };
}

export default {
  name: 'search-volume',
  setup(ctx) {
    ctx.events.on('keywords:added', async ({ domainId, keywordIds } = {}) => {
      if (!ctx.provider || !Array.isArray(keywordIds) || !keywordIds.length) return;
      try {
        const ids = keywordIds.map(Number).filter(Number.isSafeInteger).slice(0, MAX_IDS);
        const rows = ctx.db.prepare(`SELECT id, phrase, country, language FROM keywords WHERE domain_id = ? AND id IN (SELECT value FROM json_each(?))`)
          .all(Number(domainId), JSON.stringify(ids));
        const updated = rows.length ? await enrichKeywords(ctx, rows) : [];
        if (updated.length) ctx.events.emit('search-volume:updated', { domainId: Number(domainId), keywordIds: updated });
      } catch (e) { console.warn(`[search-volume] enrichment of new keywords failed: ${e.message}`); }
    });
  },
  router(ctx) {
    const { db, express } = ctx;
    const r = express.Router();
    r.use(requireAuth);
    r.get('/', (req, res) => {
      const domain = loadOwnedDomain(db, req, parseDomainId(req.query.domainId));
      res.json(buildReport(db, domain.id, Boolean(ctx.provider)));
    });
    r.post('/refresh', async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const domain = loadOwnedDomain(db, req, parseDomainId(body.domainId));
      let ids = null;
      if (body.keywordIds !== undefined) {
        if (!Array.isArray(body.keywordIds) || !body.keywordIds.length || body.keywordIds.length > MAX_IDS || !body.keywordIds.every(x => Number.isSafeInteger(x) && x > 0))
          throw httpError(400, `keywordIds must be a non-empty array of up to ${MAX_IDS} positive integers`);
        ids = body.keywordIds;
      }
      if (!ctx.provider) throw httpError(503, 'No search volume provider is configured');
      const rows = ids
        ? db.prepare('SELECT id, phrase, country, language FROM keywords WHERE domain_id = ? AND id IN (SELECT value FROM json_each(?))').all(domain.id, JSON.stringify(ids))
        : db.prepare('SELECT id, phrase, country, language FROM keywords WHERE domain_id = ?').all(domain.id);
      if (ids && rows.length !== new Set(ids).size) throw httpError(404, 'One or more keywords were not found in this domain');
      const now = new Date();
      const updated = rows.length ? await enrichKeywords(ctx, rows, now) : [];
      if (updated.length) ctx.events.emit('search-volume:updated', { domainId: domain.id, keywordIds: updated });
      res.json({ domainId: domain.id, requested: rows.length, updated: updated.length, missing: rows.length - updated.length, updatedAt: now.toISOString() });
    });
    return r;
  },
};
