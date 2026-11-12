// Keyword research: idea generation around a seed phrase, competitor keyword gaps and one-click tracking.
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { hostMatches, hostOf } from '../lib/metrics.js';
import { tx } from '../db.js';

const MAX_IDEAS = 200;
const MAX_TRACK = 500;
const DEVICES = ['desktop', 'mobile'];

// Modifier templates: `{s}` is replaced by the seed. Order is the relevance order of the output.
const MODIFIERS = [
  'best {s}', 'top {s}', '{s} review', '{s} reviews', '{s} alternatives', 'free {s}', 'cheap {s}', '{s} near me',
  '{s} for beginners', '{s} price', 'buy {s}', '{s} online', '{s} guide', '{s} tips', '{s} examples', '{s} comparison',
  '{s} tools', '{s} software', '{s} ideas', '{s} login',
];
const QUESTIONS = [
  'what is {s}', 'how to {s}', 'how does {s} work', 'why {s}', 'is {s} worth it', 'where to buy {s}',
  'which {s} is best', 'when to use {s}', 'can {s}', 'who uses {s}',
];
// Rough authority of very large sites, 0-100. Unknown hosts get a stable pseudo-random 15-60 score.
const AUTHORITY = {
  'wikipedia.org': 96, 'youtube.com': 96, 'amazon.com': 95, 'reddit.com': 92, 'linkedin.com': 92, 'pinterest.com': 90,
  'github.com': 92, 'quora.com': 88, 'medium.com': 90, 'forbes.com': 91, 'nytimes.com': 93, 'businessinsider.com': 89,
  'theverge.com': 88, 'wired.com': 89, 'cnet.com': 89, 'techradar.com': 85, 'hubspot.com': 87, 'investopedia.com': 87,
  'healthline.com': 86, 'yelp.com': 88, 'tripadvisor.com': 88, 'nerdwallet.com': 84, 'wikihow.com': 85,
  'stackexchange.com': 86, 'stackoverflow.com': 90, 'facebook.com': 96, 'twitter.com': 94, 'x.com': 94, 'instagram.com': 94,
  'apple.com': 95, 'microsoft.com': 95, 'google.com': 98, 'ebay.com': 92, 'walmart.com': 90, 'etsy.com': 89,
};
const INTENT_RULES = [
  ['transactional', /\b(buy|order|price|prices|pricing|cheap|deal|deals|discount|coupon|for sale|shop|purchase|hire|subscription|near me)\b/],
  ['navigational', /\b(login|log in|sign in|signup|sign up|account|website|official|app|download)\b|\.(com|net|org|io)\b/],
  ['commercial', /\b(best|top|review|reviews|vs|versus|compare|comparison|alternatives?|alternative to|rated)\b/],
];

const normPhrase = p => String(p ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const fill = (tpl, s) => tpl.replace('{s}', s);
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const bareHost = h => String(h || '').toLowerCase().replace(/^www\./, '');
function fnv(s) { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; }

export function classifyIntent(phrase) {
  const p = normPhrase(phrase);
  for (const [intent, re] of INTENT_RULES) if (re.test(p)) return intent;
  return 'informational';
}

export function hostAuthority(host) {
  const h = bareHost(host);
  if (/\.(gov|edu)(\.[a-z]{2})?$/.test(h)) return 88;
  const known = Object.keys(AUTHORITY).find(k => h === k || h.endsWith('.' + k));
  return known ? AUTHORITY[known] : 15 + (fnv(h) % 46);
}

// Difficulty 0-100 from the hosts of the top 10 results, weighted toward the top positions.
export function serpDifficulty(hosts) {
  const top = hosts.filter(Boolean).slice(0, 10);
  if (!top.length) return null;
  let sum = 0, wsum = 0;
  top.forEach((h, i) => { const w = 1 / (1 + i * 0.3); sum += hostAuthority(h) * w; wsum += w; });
  // Spread the averaged authority (typically 25-90) over the full 0-100 scale.
  return Math.round(clamp((sum / wsum - 20) * 1.35));
}

// Fallback when no SERP is known for an idea: derive from the seed, phrase length and paid competition.
function estimateDifficulty(phrase, { base, seedWords, competition }) {
  const words = phrase.split(' ').length;
  let d = (base ?? 40) - Math.max(0, words - seedWords) * 6;
  if (competition != null) d += (competition - 0.5) * 20;
  if (classifyIntent(phrase) === 'transactional') d += 4;
  return Math.round(clamp(d));
}

// Strings from provider related_searches / people_also_ask arrays, whichever shape they come in.
function relatedFromSerp(serp) {
  const out = [];
  for (const key of ['related_searches', 'relatedSearches', 'people_also_ask', 'peopleAlsoAsk']) {
    const list = serp?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const q = typeof item === 'string' ? item : item?.query ?? item?.question ?? item?.phrase ?? item?.title;
      if (q) out.push({ phrase: normPhrase(q), source: key.startsWith('related') ? 'related' : 'question' });
    }
  }
  return out;
}

export function expandSeed(seed, related = []) {
  const ideas = new Map();
  const add = (phrase, source) => { const p = normPhrase(phrase); if (p && p.length <= 200 && !ideas.has(p)) ideas.set(p, source); };
  add(seed, 'seed');
  for (const r of related) add(r.phrase, r.source);
  for (const m of MODIFIERS) add(fill(m, seed), 'modifier');
  const rivals = related.map(r => r.phrase).filter(p => !p.includes(seed) && p.split(' ').length <= 3).slice(0, 2);
  for (const o of rivals.length ? rivals : ['competitors']) add(`${seed} vs ${o}`, 'modifier');
  for (const q of QUESTIONS) add(fill(q, seed), 'question');
  return [...ideas].map(([phrase, source]) => ({ phrase, source }));
}

export default {
  name: 'keyword-research',
  router(ctx) {
    const { db, express, events } = ctx;
    const r = express.Router();
    r.use(requireAuth);

    // Hosts of the latest stored SERP for a phrase among the user's own keywords.
    const storedHostsStmt = db.prepare(`
      SELECT s.results FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id JOIN domains d ON d.id = k.domain_id
      WHERE d.user_id = ? AND k.phrase = ? AND k.country = ? ORDER BY s.checked_at DESC LIMIT 1`);
    const storedHosts = (userId, phrase, country) => {
      const row = storedHostsStmt.get(userId, phrase, country);
      const results = row ? parseJson(row.results, []) || [] : [];
      return results.sort((a, b) => a.position - b.position).map(x => x.host || hostOf(x.url));
    };

    // GET /api/keyword-research/ideas?seed=&country=&language=&limit=
    r.get('/ideas', async (req, res) => {
      const seed = normPhrase(req.query.seed);
      if (seed.length < 2) throw httpError(400, 'seed must be at least 2 characters');
      if (seed.length > 80) throw httpError(400, 'seed must be at most 80 characters');
      const country = String(req.query.country || 'US').toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw httpError(400, 'country must be a 2-letter code');
      const language = String(req.query.language || 'en').toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(language)) throw httpError(400, 'language must be a language code like "en"');
      const limit = req.query.limit == null || req.query.limit === '' ? 100 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IDEAS) throw httpError(400, `limit must be an integer between 1 and ${MAX_IDEAS}`);

      const provider = ctx.provider;
      const warnings = [];
      let serp = null;
      if (provider?.fetchSerp) {
        try { serp = await provider.fetchSerp({ phrase: seed, searchEngine: 'google', device: 'desktop', country, location: '', language }); }
        catch (e) { warnings.push(`SERP lookup failed: ${e.message}`); }
      }
      const seedHosts = serp?.results?.length ? serp.results.map(x => x.host || hostOf(x.url)) : storedHosts(req.user.id, seed, country);
      const seedDifficulty = serpDifficulty(seedHosts);
      const candidates = expandSeed(seed, relatedFromSerp(serp)).slice(0, limit);

      let volumes = {};
      if (provider?.fetchVolume) {
        try { volumes = (await provider.fetchVolume(candidates.map(c => c.phrase), { country, language })) || {}; }
        catch (e) { warnings.push(`Volume lookup failed: ${e.message}`); }
      }
      const seedWords = seed.split(' ').length;
      const ideas = candidates.map(({ phrase, source }) => {
        const v = volumes[phrase] || null;
        const known = phrase === seed ? seedDifficulty : serpDifficulty(storedHosts(req.user.id, phrase, country));
        return {
          phrase, source,
          volume: v?.volume ?? null,
          cpc: v?.cpc ?? null,
          competition: v?.competition ?? null,
          difficulty: known ?? estimateDifficulty(phrase, { base: seedDifficulty, seedWords, competition: v?.competition }),
          intent: classifyIntent(phrase),
        };
      });
      const [first, ...rest] = ideas;
      rest.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
      res.json({ seed, country, language, providerAvailable: !!provider, warnings, ideas: [first, ...rest] });
    });

    // GET /api/keyword-research/gap?domainId=&maxRank=20
    // Phrases (from the user's stored SERPs) where a competitor ranks within maxRank but the domain does not.
    r.get('/gap', (req, res) => {
      const domain = loadOwnedDomain(db, req, Number(req.query.domainId) || 0);
      const maxRank = req.query.maxRank == null || req.query.maxRank === '' ? 20 : Number(req.query.maxRank);
      if (!Number.isInteger(maxRank) || maxRank < 1 || maxRank > 100) throw httpError(400, 'maxRank must be an integer between 1 and 100');
      const sub = !!domain.include_subdomains;
      const isOwn = h => hostMatches(h, domain.host, sub);

      // Latest snapshot per keyword across all of the user's domains.
      const rows = db.prepare(`
        SELECT k.id, k.domain_id, k.phrase, k.country, k.search_volume, s.rank, s.results, s.checked_at
        FROM keywords k JOIN domains d ON d.id = k.domain_id
        JOIN rank_snapshots s ON s.id = (SELECT id FROM rank_snapshots WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1)
        WHERE d.user_id = ?`).all(req.user.id).map(x => ({ ...x, results: (parseJson(x.results, []) || []).map(r => ({ ...r, host: bareHost(r.host || hostOf(r.url)) })) }));

      let competitors = db.prepare('SELECT host FROM competitors WHERE domain_id = ? ORDER BY host').all(domain.id).map(c => bareHost(c.host));
      let competitorsSource = 'configured';
      if (!competitors.length) {
        // No competitors configured: use the hosts that most often appear in the domain's own top results.
        const freq = new Map();
        for (const k of rows.filter(x => x.domain_id === domain.id)) {
          for (const r of k.results) if (r.position <= maxRank && r.host && !isOwn(r.host)) freq.set(r.host, (freq.get(r.host) || 0) + 1);
        }
        competitors = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([h]) => h);
        competitorsSource = 'detected';
      }

      const tracked = new Set(rows.filter(x => x.domain_id === domain.id).map(x => `${x.phrase}|${x.country}`));
      const byPhrase = new Map();
      for (const k of rows) {
        const key = `${k.phrase}|${k.country}`;
        const own = k.domain_id === domain.id;
        if (!own && tracked.has(key)) continue;                     // the domain's own snapshot is authoritative
        const ownBest = own ? k.rank : k.results.find(r => isOwn(r.host))?.position ?? null;
        if (ownBest != null && ownBest <= maxRank) continue;
        const hits = competitors.map(c => ({ host: c, rank: k.results.find(r => r.position <= maxRank && hostMatches(r.host, c, true))?.position ?? null }))
          .filter(x => x.rank != null);
        if (!hits.length) continue;
        const prev = byPhrase.get(key);
        if (prev && prev.checkedAt >= k.checked_at) continue;
        byPhrase.set(key, {
          phrase: k.phrase, country: k.country, tracked: tracked.has(key), keywordId: own ? k.id : null,
          yourRank: ownBest, volume: k.search_volume ?? null, checkedAt: k.checked_at,
          bestCompetitorRank: Math.min(...hits.map(x => x.rank)), competitors: hits.sort((a, b) => a.rank - b.rank),
          intent: classifyIntent(k.phrase),
        });
      }
      const gaps = [...byPhrase.values()].sort((a, b) => a.bestCompetitorRank - b.bestCompetitorRank || (b.volume ?? 0) - (a.volume ?? 0) || (a.phrase < b.phrase ? -1 : 1));
      res.json({ domainId: domain.id, maxRank, competitors, competitorsSource, gaps });
    });

    // POST /api/keyword-research/track { domainId, phrases[], country?, device?, language? }
    // Direct insert used when the keywords module is not installed.
    r.post('/track', (req, res) => {
      const b = req.body || {};
      const domain = loadOwnedDomain(db, req, Number(b.domainId) || 0);
      if (!Array.isArray(b.phrases)) throw httpError(400, 'phrases must be an array');
      const phrases = [...new Set(b.phrases.map(normPhrase).filter(Boolean))];
      if (!phrases.length) throw httpError(400, 'No keywords given');
      if (phrases.length > MAX_TRACK) throw httpError(400, `At most ${MAX_TRACK} phrases per request`);
      if (phrases.some(p => p.length > 200)) throw httpError(400, 'Keyword phrases must be at most 200 characters');
      const country = String(b.country || domain.default_country).toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw httpError(400, 'country must be a 2-letter code');
      const device = b.device ?? 'desktop';
      if (!DEVICES.includes(device)) throw httpError(400, `device must be one of: ${DEVICES.join(', ')}`);
      const language = String(b.language || domain.default_language).toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(language)) throw httpError(400, 'language must be a language code like "en"');

      const keywordIds = tx(db, () => {
        const ins = db.prepare(`INSERT OR IGNORE INTO keywords(domain_id, phrase, device, country, location, language) VALUES (?,?,?,?,?,?)`);
        return phrases.map(p => ins.run(domain.id, p, device, country, domain.default_location, language))
          .filter(x => x.changes).map(x => Number(x.lastInsertRowid));
      });
      if (keywordIds.length) events.emit('keywords:added', { domainId: domain.id, keywordIds });
      res.status(201).json({ created: keywordIds.length, skipped: phrases.length - keywordIds.length, keywordIds });
    });

    return r;
  },
};
