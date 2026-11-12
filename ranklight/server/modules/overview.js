// Domain overview dashboard: KPIs, rank distribution / average rank history, winners and losers.
// GET /api/overview?domainId=&days=30
// The period baseline is each keyword's latest rank as of `days` days ago; keywords first checked
// inside the period use their first in-period rank as baseline. History carries ranks forward per day.
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';
import { latestRanks, estimatedClicks, ctrFor, rankChange } from '../lib/metrics.js';

const DAY = 864e5;
const BUCKETS = [['top3', 3], ['top4_10', 10], ['top11_20', 20], ['top21_50', 50], ['top51_100', 100]];
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
const isoDate = t => new Date(t).toISOString().slice(0, 10);

function parseIntParam(v, name, { min, max, def }) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}

// ranks: array of rank|null for keywords that have been checked.
function distribution(ranks) {
  const out = Object.fromEntries(BUCKETS.map(([k]) => [k, 0]));
  out.notRanked = 0;
  for (const r of ranks) {
    if (r == null) { out.notRanked++; continue; }
    out[BUCKETS.find(([, max]) => r <= max)[0]]++;
  }
  return out;
}
const avg = ranks => { const v = ranks.filter(r => r != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// Share of voice: estimated clicks as % of the clicks the keyword set would get if all ranked #1.
function sov(entries) {
  let clicks = 0, max = 0;
  for (const { rank, volume } of entries) { clicks += estimatedClicks(rank, volume); max += estimatedClicks(1, volume); }
  return { clicks, sov: max ? (clicks / max) * 100 : 0 };
}

export function buildOverview(db, domainId, days, now = Date.now()) {
  const baseDate = isoDate(now - days * DAY);
  const keywords = latestRanks(db, domainId, baseDate);
  const kw = new Map(keywords.map(k => [k.id, { phrase: k.phrase, volume: k.search_volume, device: k.device, country: k.country, location: k.location }]));
  const state = new Map();     // keyword_id -> {rank, url}
  const baseline = new Map();  // keyword_id -> rank|null
  for (const k of keywords) if (k.checked_at) { state.set(k.id, { rank: k.rank, url: k.url }); baseline.set(k.id, k.rank); }

  const rankDistributionHistory = [], avgRankHistory = [];
  const emit = date => {
    const ranks = [...state.values()].map(s => s.rank);
    rankDistributionHistory.push({ date, ...distribution(ranks) });
    avgRankHistory.push({ date, avgRank: round(avg(ranks), 2) });
    for (const [id, s] of state) if (!baseline.has(id)) baseline.set(id, s.rank);
  };
  if (state.size) emit(baseDate);

  const snaps = db.prepare(`SELECT s.keyword_id AS id, s.rank, s.url, substr(s.checked_at,1,10) AS day FROM rank_snapshots s
    JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ? AND s.checked_at > ? ORDER BY s.checked_at, s.id`).all(domainId, baseDate + 'T23:59:59Z');
  let day = null;
  for (const s of snaps) {
    if (day && s.day !== day) emit(day);
    day = s.day;
    state.set(s.id, { rank: s.rank, url: s.url });
  }
  if (day) emit(day);

  const rows = [...kw.entries()].map(([id, k]) => {
    const cur = state.get(id);
    const checked = !!cur;
    const rank = cur?.rank ?? null, prev = baseline.has(id) ? baseline.get(id) : null;
    return { id, phrase: k.phrase, device: k.device, country: k.country, location: k.location, searchVolume: k.volume,
      url: cur?.url ?? null, checked, rank, previousRank: prev, change: checked ? rankChange(prev, rank) : 0,
      estimatedClicks: round(estimatedClicks(rank, k.volume)), ctr: ctrFor(rank) };
  });
  const checked = rows.filter(r => r.checked);
  const curRanks = checked.map(r => r.rank), prevRanks = checked.map(r => r.previousRank);
  const curAvg = avg(curRanks), prevAvg = avg(prevRanks);
  const curSov = sov(checked.map(r => ({ rank: r.rank, volume: r.searchVolume })));
  const prevSov = sov(checked.map(r => ({ rank: r.previousRank, volume: r.searchVolume })));
  const dist = distribution(curRanks);
  const strip = ({ checked: _c, ...r }) => r;

  return {
    domainId, days, from: baseDate, to: isoDate(now),
    kpis: {
      keywords: rows.length,
      avgRank: round(curAvg, 2),
      avgRankChange: curAvg != null && prevAvg != null ? round(prevAvg - curAvg, 2) : null,
      top3: dist.top3, top10: dist.top3 + dist.top4_10,
      top100: curRanks.filter(r => r != null).length,
      notRanked: rows.length - curRanks.filter(r => r != null).length,
      up: checked.filter(r => r.change > 0).length,
      down: checked.filter(r => r.change < 0).length,
      unchanged: rows.length - checked.filter(r => r.change !== 0).length,
      shareOfVoice: round(curSov.sov, 2),
      sovChange: round(curSov.sov - prevSov.sov, 2),
      estimatedClicks: Math.round(curSov.clicks),
    },
    rankDistributionHistory,
    avgRankHistory,
    winners: checked.filter(r => r.change > 0).sort((a, b) => b.change - a.change || (a.rank ?? 101) - (b.rank ?? 101)).slice(0, 5).map(strip),
    losers: checked.filter(r => r.change < 0).sort((a, b) => a.change - b.change || (a.rank ?? 101) - (b.rank ?? 101)).slice(0, 5).map(strip),
  };
}

export default {
  name: 'overview',
  router({ db, express }) {
    const r = express.Router();
    r.use(requireAuth);
    r.get('/', (req, res) => {
      if (req.query.domainId === undefined || req.query.domainId === '') throw httpError(400, 'domainId is required');
      const domainId = parseIntParam(req.query.domainId, 'domainId', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const days = parseIntParam(req.query.days, 'days', { min: 1, max: 730, def: 30 });
      const domain = loadOwnedDomain(db, req, domainId);
      res.json(buildOverview(db, domain.id, days));
    });
    return r;
  },
};
