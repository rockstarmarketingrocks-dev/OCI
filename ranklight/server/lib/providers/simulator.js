// Deterministic offline rank data simulator.
// Every SERP is a pure function of (engine, phrase, device, country, location, date) plus the set of
// tracked hosts (domains + competitors that track the phrase), so re-checking a day reproduces it exactly
// while consecutive days drift like a random walk.

const DAY_MS = 86400000;

// ---- Seeded randomness ----
export function hash(str) {
  // cyrb53: fast, well-distributed 53-bit string hash.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const unit = (...parts) => hash(parts.join('\u0001')) / 2 ** 53;   // [0,1)
export function rng(seed) {
  let a = hash(String(seed)) >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Smooth 1-D value noise in [-1,1]: random anchors every `period` days, smoothstep-interpolated.
function noise(key, day, period) {
  const i = Math.floor(day / period), f = day / period - i, s = f * f * (3 - 2 * f);
  const a = unit(key, period, i) * 2 - 1, b = unit(key, period, i + 1) * 2 - 1;
  return a + (b - a) * s;
}

export const dayIndex = date => Math.floor(Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') / DAY_MS);
export const isoDay = date => (date ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10));

// ---- Static vocabularies ----
const BIG_HOSTS = [
  ['wikipedia.org', 0.55], ['reddit.com', 0.6], ['youtube.com', 0.5], ['amazon.com', 0.3], ['quora.com', 0.35],
  ['medium.com', 0.3], ['forbes.com', 0.25], ['nytimes.com', 0.15], ['pinterest.com', 0.25], ['linkedin.com', 0.2],
  ['github.com', 0.15], ['stackexchange.com', 0.12], ['investopedia.com', 0.12], ['healthline.com', 0.1],
  ['theverge.com', 0.1], ['wired.com', 0.1], ['businessinsider.com', 0.15], ['yelp.com', 0.12], ['tripadvisor.com', 0.08],
  ['nerdwallet.com', 0.1], ['cnet.com', 0.12], ['techradar.com', 0.1], ['hubspot.com', 0.12], ['wikihow.com', 0.15],
];
const PREFIXES = ['best', 'the', 'my', 'top', 'get', 'go', 'pro', 'smart', 'easy', 'daily', 'true', 'pure'];
const SUFFIXES = ['hub', 'lab', 'guide', 'hq', 'pro', 'zone', 'insider', 'review', 'daily', 'base', 'works', 'spot', 'central', 'world', 'expert', 'point'];
const TLDS = ['com', 'com', 'com', 'net', 'org', 'io', 'co'];
const TITLE_TEMPLATES = [
  (p, b) => `${p}: The Complete Guide | ${b}`, (p, b) => `${p} - ${b}`, (p, b) => `What Is ${p}? Everything You Need to Know`,
  (p, b) => `10 Best ${p} Options (Updated) - ${b}`, (p, b) => `${p} Explained | ${b}`, (p, b) => `How to Choose ${p} | ${b}`,
  (p, b) => `${p} Reviews and Comparison - ${b}`, (p, b) => `${b}: ${p} Tips and Ideas`,
];
const FEATURE_ODDS = {
  related_searches: 0.8, people_also_ask: 0.6, ads_top: 0.35, featured_snippet: 0.3, ai_overview: 0.3, image_pack: 0.3,
  video: 0.3, sitelinks: 0.25, knowledge_panel: 0.15, top_stories: 0.12, reviews: 0.15, faq: 0.12, ads_bottom: 0.2,
  twitter: 0.05, local_pack: 0.08, shopping: 0.08,
};

const titleCase = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
const brand = host => titleCase(host.split('.')[0].replace(/-/g, ' '));
const normHost = h => String(h || '').trim().toLowerCase().replace(/^www\./, '');

function nicheHosts(phrase, count, seed) {
  const words = phrase.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const pool = words.length ? words : ['topic'];
  const r = rng(seed), out = new Set();
  for (let guard = 0; out.size < count && guard < count * 20; guard++) {
    const w = pool[Math.floor(r() * pool.length)], w2 = pool[Math.floor(r() * pool.length)];
    const pick = a => a[Math.floor(r() * a.length)];
    const kind = r();
    const name = kind < 0.35 ? `${w}${pick(SUFFIXES)}` : kind < 0.65 ? `${pick(PREFIXES)}${w}` : kind < 0.85 && w !== w2 ? `${w}-${w2}` : `${w}${pick(SUFFIXES)}${Math.floor(r() * 90) + 10}`;
    out.add(`${name}.${pick(TLDS)}`);
  }
  return [...out];
}

// Position of a tracked host for a phrase/variant on a given day, or null when it does not rank.
export function trackedPosition(host, variantKey, day) {
  const key = `${host}|${variantKey}`;
  const q = unit('q', key);
  if (q < 0.12) return null;                                   // never ranks for this keyword
  const baseline = 1 + Math.pow((q - 0.12) / 0.88, 1.5) * 85;  // skewed toward page one/two
  const amp = Math.max(2, baseline * 0.35);
  const pos = baseline + amp * (0.65 * noise(key, day, 23) + 0.35 * noise(key, day, 6)) + (unit('j', key, day) - 0.5) * 2;
  const p = Math.max(1, Math.round(pos));
  return p > 100 ? null : p;
}

export function createSimulator({ db } = {}) {
  // Hosts (tracked domains and their competitors) that track this phrase; empty when no DB is given.
  const trackedStmt = db?.prepare(`
    SELECT d.host AS host FROM keywords k JOIN domains d ON d.id = k.domain_id WHERE lower(k.phrase) = lower(?)
    UNION SELECT c.host FROM competitors c WHERE c.domain_id IN (SELECT domain_id FROM keywords WHERE lower(phrase) = lower(?))`);
  const trackedHosts = phrase => (trackedStmt ? trackedStmt.all(phrase, phrase).map(r => normHost(r.host)) : []);

  function fetchSerp({ phrase, searchEngine = 'google', device = 'desktop', country = 'US', location = '', language = 'en', date, hosts = [] } = {}) {
    phrase = String(phrase ?? '').replace(/\s+/g, ' ').trim();
    if (!phrase) throw new Error('fetchSerp: phrase is required');
    const day = isoDay(date), dIdx = dayIndex(day);
    if (!Number.isFinite(dIdx)) throw new Error('fetchSerp: invalid date');
    const variant = [searchEngine, phrase.toLowerCase(), device, String(country).toUpperCase(), String(location).toLowerCase(), language].join('|');
    const tracked = [...new Set([...trackedHosts(phrase), ...hosts.map(normHost)].filter(Boolean))].sort();
    const isTracked = h => tracked.some(t => h === t || h.endsWith('.' + t));

    // Stable candidate pool for the variant, reordered a little each day.
    const big = BIG_HOSTS.filter(([h, p]) => unit('big', variant, h) < p).map(([h]) => ({ host: h, base: unit('bb', variant, h) * 30 }));
    const niche = nicheHosts(phrase, 120, 'niche|' + variant).map((h, i) => ({ host: h, base: 5 + i * 0.9 + unit('nb', variant, h) * 25 }));
    const fillers = [...big, ...niche].filter(c => !isTracked(c.host))
      .map(c => ({ ...c, score: c.base + noise(`f|${variant}|${c.host}`, dIdx, 9) * 6 + (unit('fd', variant, c.host, dIdx) - 0.5) * 3 }))
      .sort((a, b) => a.score - b.score || (a.host < b.host ? -1 : 1));

    // Tracked hosts claim their drifted positions first; collisions slide to the next free slot.
    const slots = new Array(101).fill(null);
    for (const host of tracked) {
      let p = trackedPosition(host, variant, dIdx);
      if (p == null) continue;
      while (p <= 100 && slots[p]) p++;
      if (p <= 100) slots[p] = { host, tracked: true };
    }
    let fi = 0;
    for (let p = 1; p <= 100; p++) if (!slots[p]) slots[p] = fillers[fi++] || { host: `result${p}.example` };

    // SERP features: stable per variant with occasional day-to-day flips.
    const lower = phrase.toLowerCase();
    const features = Object.keys(FEATURE_ODDS).filter(f => {
      let odds = FEATURE_ODDS[f];
      if (f === 'local_pack' && (location || /near me|\bin [a-z]/.test(lower))) odds = 0.85;
      if (f === 'shopping' && /\b(buy|price|cheap|deal|sale|shop)\b/.test(lower)) odds = 0.8;
      if (f === 'video' && (searchEngine === 'youtube' || /how to|tutorial/.test(lower))) odds = 0.85;
      const flip = unit('ff', variant, f, Math.floor(dIdx / 3)) < 0.1;
      return (unit('feat', variant, f) < odds) !== flip;
    });

    const pt = titleCase(phrase), page = slug(phrase);
    const results = slots.slice(1).map((s, i) => {
      const position = i + 1, host = s.host;
      let url, type = 'organic';
      if (host === 'youtube.com') { url = `https://youtube.com/watch?v=${hash(variant + position).toString(36).slice(0, 11)}`; if (features.includes('video')) type = 'video'; }
      else if (host === 'wikipedia.org') url = `https://en.wikipedia.org/wiki/${encodeURIComponent(pt.replace(/ /g, '_'))}`;
      else if (host === 'reddit.com') url = `https://reddit.com/r/${page.split('-')[0]}/comments/${hash(variant).toString(36).slice(0, 6)}/${page}/`;
      else if (s.tracked) url = `https://${host}/${unit('alt', host, variant, Math.floor(dIdx / 10)) < 0.15 ? 'blog/' : ''}${page}`;
      else url = `https://${host}/${unit('path', host, variant) < 0.5 ? page : `${['guides', 'blog', 'articles', 'learn'][hash(host) % 4]}/${page}`}`;
      if (position === 1 && features.includes('featured_snippet') && !s.tracked) type = 'featured_snippet';
      const title = host === 'wikipedia.org' ? `${pt} - Wikipedia` : TITLE_TEMPLATES[hash(host + variant) % TITLE_TEMPLATES.length](pt, brand(host));
      return { position, url, host: url.includes('wikipedia.org') ? 'en.wikipedia.org' : host, title, type };
    });
    const totalResults = Math.round(Math.pow(10, 5 + unit('total', variant) * 4) * (1 + (unit('td', variant, dIdx) - 0.5) * 0.04));
    return { results, features, totalResults };
  }

  function volumeFor(phrase, country = 'US', language = 'en') {
    const p = String(phrase).replace(/\s+/g, ' ').trim().toLowerCase(), key = `${p}|${String(country).toUpperCase()}|${language}`;
    const words = p.split(' ').length;
    const intent = /\b(buy|price|best|cheap|insurance|loan|lawyer|software|hosting|tool)\b/.test(p);
    const volume = Math.round(Math.pow(10, Math.max(1, 4.6 - words * 0.55 + unit('v', key) * 1.8)) / 10) * 10;
    const competition = Math.round(Math.min(1, unit('c', key) * 0.7 + (intent ? 0.3 : 0)) * 100) / 100;
    const cpc = Math.round((0.1 + unit('cpc', key) * 4 + (intent ? 3 + unit('cpi', key) * 9 : 0)) * 100) / 100;
    const peak = Math.floor(unit('peak', key) * 12), season = unit('season', key) * 0.5;
    const trend = Array.from({ length: 12 }, (_, m) => {
      const d = Math.min(Math.abs(m - peak), 12 - Math.abs(m - peak));
      return Math.max(0, Math.round(volume * (1 + season * Math.cos((d / 6) * Math.PI)) * (0.92 + unit('t', key, m) * 0.16) / 10) * 10);
    });
    return { volume, cpc, competition, trend };
  }

  async function fetchVolume(phrases = [], { country = 'US', language = 'en' } = {}) {
    const out = {};
    for (const ph of phrases) if (String(ph ?? '').trim()) out[ph] = volumeFor(ph, country, language);
    return out;
  }

  return { name: 'simulator', configured: true, fetchSerp: async opts => fetchSerp(opts), fetchVolume, volumeFor };
}
