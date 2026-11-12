// Share of voice: estimated clicks as a % of the clicks the keyword set would get if every keyword ranked #1.
// GET /api/share-of-voice?domainId=&days=30&tag=
//   -> { current: {you, competitors:[{host, sov}]}, history: [{date, you, [host]: sov}], byTag: [{tag, sov, keywords}], ... }
// Competitor positions come from each snapshot's `results` JSON (best organic position of that host).
// Competitors are the domain's configured competitors; when none exist, the top hosts by current SoV are discovered.
// Only keywords with at least one snapshot (as of a given day) count toward the denominator.
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { estimatedClicks, hostMatches, hostOf } from '../lib/metrics.js';

const DAY = 864e5;
const DISCOVER_LIMIT = 5;
const round2 = n => Math.round(n * 100) / 100;
const isoDate = t => new Date(t).toISOString().slice(0, 10);
const normHost = h => String(h || '').toLowerCase().replace(/^www\./, '');

function parseIntParam(v, name, { min, max, def }) {
  if (v === undefined || v === '') {
    if (def === undefined) throw httpError(400, `${name} is required`);
    return def;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}

// host -> best organic position on one SERP.
function hostPositions(resultsJson) {
  const out = new Map();
  const list = parseJson(resultsJson, []);
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (!r || (r.type && r.type !== 'organic')) continue;
    const pos = Number(r.position), host = normHost(r.host || hostOf(r.url));
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

export function buildShareOfVoice(db, domain, { days = 30, tag = null } = {}, now = Date.now()) {
  const from = isoDate(now - days * DAY), cutoff = from + 'T23:59:59Z';
  const keywords = db.prepare('SELECT id, search_volume FROM keywords WHERE domain_id = ?').all(domain.id);
  const volume = new Map(keywords.map(k => [k.id, k.search_volume || 0]));
  const tags = db.prepare('SELECT id, name FROM tags WHERE domain_id = ? ORDER BY name COLLATE NOCASE').all(domain.id);
  const tagKeywords = new Map(tags.map(t => [t.id, new Set()]));
  for (const r of db.prepare(`SELECT kt.tag_id, kt.keyword_id FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id WHERE t.domain_id = ?`).all(domain.id))
    tagKeywords.get(r.tag_id).add(r.keyword_id);

  let scope = null;
  if (tag != null) {
    const t = tags.find(x => x.name.toLowerCase() === tag.toLowerCase()) || (/^\d+$/.test(tag) && tags.find(x => x.id === Number(tag)));
    if (!t) throw httpError(404, 'Tag not found');
    scope = tagKeywords.get(t.id);
  }

  // Baseline (latest snapshot per keyword as of period start) followed by every snapshot inside the period.
  const baseline = db.prepare(`SELECT s.keyword_id AS id, s.rank, s.results, ? AS day FROM keywords k
    JOIN rank_snapshots s ON s.id = (SELECT id FROM rank_snapshots WHERE keyword_id = k.id AND checked_at <= ? ORDER BY checked_at DESC, id DESC LIMIT 1)
    WHERE k.domain_id = ?`).all(from, cutoff, domain.id);
  const inPeriod = db.prepare(`SELECT s.keyword_id AS id, s.rank, s.results, substr(s.checked_at,1,10) AS day FROM rank_snapshots s
    JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ? AND s.checked_at > ? ORDER BY s.checked_at, s.id`).all(domain.id, cutoff);
  const snaps = [...baseline, ...inPeriod].map(s => ({ id: s.id, day: s.day, rank: s.rank, positions: hostPositions(s.results) }));

  const latest = new Map();
  for (const s of snaps) latest.set(s.id, s);
  const inScope = id => !scope || scope.has(id);
  const isOwn = h => hostMatches(h, domain.host, !!domain.include_subdomains);

  // Competitor hosts: configured, else discovered from the latest SERPs of in-scope keywords.
  const compRows = db.prepare('SELECT host, display_name FROM competitors WHERE domain_id = ? ORDER BY id').all(domain.id);
  const nameOf = new Map(compRows.map(r => [normHost(r.host), r.display_name || null]));
  let hosts = compRows.map(r => normHost(r.host)).filter(h => h && !isOwn(h));
  const discovered = !hosts.length;
  if (discovered) {
    const clicks = new Map();
    for (const s of latest.values()) {
      if (!inScope(s.id)) continue;
      for (const [h, p] of s.positions) if (!isOwn(h)) clicks.set(h, (clicks.get(h) || 0) + estimatedClicks(p, volume.get(s.id)));
    }
    hosts = [...clicks].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, DISCOVER_LIMIT).map(([h]) => h);
  }
  hosts = [...new Set(hosts)];

  // Per keyword state: { you: rank|null, comp: [pos|null per host] }
  const toState = s => ({ you: s.rank, comp: hosts.map(h => bestPosition(s.positions, h)) });
  const measure = (state, ids) => {
    let max = 0, you = 0;
    const comp = hosts.map(() => 0);
    for (const id of ids) {
      const st = state.get(id), vol = volume.get(id);
      if (!st || !vol) continue;
      max += estimatedClicks(1, vol);
      you += estimatedClicks(st.you, vol);
      st.comp.forEach((p, i) => { comp[i] += estimatedClicks(p, vol); });
    }
    const pct = c => (max ? round2(c / max * 100) : 0);
    return { you: pct(you), comp: comp.map(pct) };
  };
  const scopedIds = keywords.map(k => k.id).filter(inScope);

  const history = [], state = new Map();
  const emit = day => {
    const m = measure(state, scopedIds);
    history.push({ date: day, you: m.you, ...Object.fromEntries(hosts.map((h, i) => [h, m.comp[i]])) });
  };
  let day = null;
  for (const s of snaps) {
    if (day && s.day !== day && [...state.keys()].some(inScope)) emit(day);
    day = s.day;
    state.set(s.id, toState(s));
  }
  if (day && [...state.keys()].some(inScope)) emit(day);

  const cur = measure(state, scopedIds);
  const allIds = keywords.map(k => k.id);
  return {
    domainId: domain.id, days, from, to: isoDate(now), tag, discovered,
    current: {
      you: cur.you,
      competitors: hosts.map((host, i) => ({ host, displayName: nameOf.get(host) || null, sov: cur.comp[i] })).sort((a, b) => b.sov - a.sov || a.host.localeCompare(b.host)),
    },
    history,
    byTag: tags.map(t => {
      const ids = allIds.filter(id => tagKeywords.get(t.id).has(id));
      return { tag: t.name, keywords: ids.length, sov: measure(state, ids).you };
    }),
  };
}

export default {
  name: 'share-of-voice',
  router({ db, express }) {
    const r = express.Router();
    r.use(requireAuth);
    r.get('/', (req, res) => {
      const domainId = parseIntParam(req.query.domainId, 'domainId', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const days = parseIntParam(req.query.days, 'days', { min: 1, max: 730, def: 30 });
      const rawTag = req.query.tag;
      if (rawTag !== undefined && typeof rawTag !== 'string') throw httpError(400, 'tag must be a single string');
      const tag = rawTag?.trim() || null;
      if (tag && tag.length > 100) throw httpError(400, 'tag is too long');
      const domain = loadOwnedDomain(db, req, domainId);
      res.json(buildShareOfVoice(db, domain, { days, tag }));
    });
    return r;
  },
};
