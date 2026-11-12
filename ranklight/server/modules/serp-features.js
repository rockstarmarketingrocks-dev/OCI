// SERP features insight: which SERP features appear for the domain's keywords and how many the domain owns.
// GET /api/serp-features?domainId=&days=30
//   -> { domainId, days, from, totalKeywords, checkedKeywords,
//        features: [{ feature, label, keywordsWithFeature, ownedCount, ownedPct, trend: [{date, present, owned}] }] }
//   Current counts use each keyword's latest snapshot. Trend carries each keyword's latest state forward per snapshot day,
//   starting from the state as of the period start. Every known feature is listed (plus unknown ids seen in data).
// GET /api/serp-features/keywords?domainId=&feature=&owned=true|false
//   -> { feature, label, owned, keywords: [{ id, phrase, device, country, location, searchVolume, rank, url, owned, checkedAt }] }
// Uses only core tables (keywords, rank_snapshots).
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { latestRanks } from '../lib/metrics.js';

export const FEATURE_LABELS = Object.freeze({
  featured_snippet: 'Featured snippet', people_also_ask: 'People also ask', local_pack: 'Local pack', knowledge_panel: 'Knowledge panel',
  image_pack: 'Image pack', video: 'Video', top_stories: 'Top stories', shopping: 'Shopping', sitelinks: 'Sitelinks', reviews: 'Reviews',
  faq: 'FAQ', twitter: 'Social posts', ads_top: 'Ads (top)', ads_bottom: 'Ads (bottom)', related_searches: 'Related searches', ai_overview: 'AI overview',
});

const DAY = 864e5;
const FEATURE_RE = /^[a-z0-9_]{1,40}$/;
const isoDate = t => new Date(t).toISOString().slice(0, 10);
const labelOf = id => FEATURE_LABELS[id] || id.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const round1 = n => Math.round(n * 10) / 10;

function intParam(v, name, { min, max, def }) {
  if (v === undefined || v === '') {
    if (def === undefined) throw httpError(400, `${name} is required`);
    return def;
  }
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}

const featureList = json => {
  const a = parseJson(json, []);
  return Array.isArray(a) ? a.filter(f => typeof f === 'string' && FEATURE_RE.test(f)) : [];
};
// Owned implies present, even if a provider only listed it as owned.
function featureState(serpJson, ownedJson) {
  const owned = new Set(featureList(ownedJson));
  return { present: new Set([...featureList(serpJson), ...owned]), owned };
}

export function buildSerpFeatures(db, domainId, { days = 30 } = {}, now = Date.now()) {
  const from = isoDate(now - days * DAY), cutoff = from + 'T23:59:59Z';
  const latest = latestRanks(db, domainId);
  const current = latest.filter(k => k.checked_at).map(k => featureState(k.serp_features, k.owned_features));

  // Baseline (state as of period start) + every snapshot after it, in time order.
  const baseline = db.prepare(`SELECT s.keyword_id AS id, s.serp_features, s.owned_features, ? AS day FROM keywords k
    JOIN rank_snapshots s ON s.id = (SELECT id FROM rank_snapshots WHERE keyword_id = k.id AND checked_at <= ? ORDER BY checked_at DESC, id DESC LIMIT 1)
    WHERE k.domain_id = ?`).all(from, cutoff, domainId);
  const inPeriod = db.prepare(`SELECT s.keyword_id AS id, s.serp_features, s.owned_features, substr(s.checked_at,1,10) AS day FROM rank_snapshots s
    JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ? AND s.checked_at > ? ORDER BY s.checked_at, s.id`).all(domainId, cutoff);

  const ids = new Set(Object.keys(FEATURE_LABELS));
  for (const s of current) for (const f of s.present) ids.add(f);

  const state = new Map(), trend = new Map([...ids].map(f => [f, []]));
  const emit = date => {
    const counts = new Map([...ids].map(f => [f, { present: 0, owned: 0 }]));
    for (const st of state.values()) {
      for (const f of st.present) if (counts.has(f)) counts.get(f).present++;
      for (const f of st.owned) if (counts.has(f)) counts.get(f).owned++;
    }
    for (const [f, c] of counts) trend.get(f).push({ date, ...c });
  };
  let day = null;
  for (const s of [...baseline, ...inPeriod]) {
    if (day && s.day !== day) emit(day);
    day = s.day;
    state.set(s.id, featureState(s.serp_features, s.owned_features));
  }
  if (day) emit(day);

  const features = [...ids].map((feature, order) => {
    const keywordsWithFeature = current.filter(s => s.present.has(feature)).length;
    const ownedCount = current.filter(s => s.owned.has(feature)).length;
    return { feature, label: labelOf(feature), keywordsWithFeature, ownedCount,
      ownedPct: keywordsWithFeature ? round1(ownedCount / keywordsWithFeature * 100) : 0, trend: trend.get(feature), order };
  }).sort((a, b) => b.keywordsWithFeature - a.keywordsWithFeature || b.ownedCount - a.ownedCount || a.order - b.order)
    .map(({ order, ...f }) => f);

  return { domainId, days, from, totalKeywords: latest.length, checkedKeywords: current.length, features };
}

export function featureKeywords(db, domainId, feature, owned = null) {
  const keywords = [];
  for (const k of latestRanks(db, domainId)) {
    if (!k.checked_at) continue;
    const st = featureState(k.serp_features, k.owned_features);
    if (!st.present.has(feature)) continue;
    const isOwned = st.owned.has(feature);
    if (owned != null && owned !== isOwned) continue;
    keywords.push({ id: k.id, phrase: k.phrase, device: k.device, country: k.country, location: k.location, searchVolume: k.search_volume,
      rank: k.rank, url: k.url, owned: isOwned, checkedAt: k.checked_at });
  }
  keywords.sort((a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1) || a.phrase.localeCompare(b.phrase));
  return { feature, label: labelOf(feature), owned, keywords };
}

function parseOwned(v) {
  if (v === undefined || v === '') return null;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw httpError(400, 'owned must be true or false');
}

export default {
  name: 'serp-features',
  router({ db, express }) {
    const r = express.Router();
    r.use(requireAuth);
    const domainOf = req => loadOwnedDomain(db, req, intParam(req.query.domainId, 'domainId', { min: 1, max: Number.MAX_SAFE_INTEGER }));
    r.get('/', (req, res) => {
      const days = intParam(req.query.days, 'days', { min: 1, max: 730, def: 30 });
      const domain = domainOf(req);
      res.json(buildSerpFeatures(db, domain.id, { days }));
    });
    r.get('/keywords', (req, res) => {
      const { feature } = req.query;
      if (feature === undefined || feature === '') throw httpError(400, 'feature is required');
      if (typeof feature !== 'string' || !FEATURE_RE.test(feature)) throw httpError(400, 'feature must be a SERP feature id');
      const owned = parseOwned(req.query.owned);
      const domain = domainOf(req);
      res.json(featureKeywords(db, domain.id, feature, owned));
    });
    return r;
  },
};
