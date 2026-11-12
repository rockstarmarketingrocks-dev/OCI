import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { createSimulator } from '../server/lib/providers/simulator.js';
import { createProvider } from '../server/lib/providers/index.js';
import { mapSerp as mapDfs, mapVolume as mapDfsVolume, createDataForSeo } from '../server/lib/providers/dataforseo.js';
import { mapSerp as mapSerpApi, createSerpApi } from '../server/lib/providers/serpapi.js';
import { hostMatches } from '../server/lib/metrics.js';

const FEATURE_IDS = new Set(['featured_snippet', 'people_also_ask', 'local_pack', 'knowledge_panel', 'image_pack', 'video', 'top_stories',
  'shopping', 'sitelinks', 'reviews', 'faq', 'twitter', 'ads_top', 'ads_bottom', 'related_searches', 'ai_overview']);
const q = { phrase: 'running shoes', device: 'desktop', country: 'US', location: '', language: 'en', date: '2026-03-01' };
const rankOf = (serp, host) => serp.results.find(r => hostMatches(r.host, host))?.position ?? null;

test('simulator SERP is deterministic and well-formed', async () => {
  const sim = createSimulator();
  const a = await sim.fetchSerp(q), b = await sim.fetchSerp({ ...q });
  assert.deepEqual(a, b);
  assert.equal(a.results.length, 100);
  a.results.forEach((r, i) => {
    assert.equal(r.position, i + 1);
    assert.match(r.url, /^https:\/\//);
    assert.ok(r.host && r.title && (r.type === 'organic' || FEATURE_IDS.has(r.type)), JSON.stringify(r));
  });
  assert.equal(new Set(a.results.map(r => r.url)).size, 100, 'urls are unique');
  assert.ok(a.features.every(f => FEATURE_IDS.has(f)));
  assert.ok(Number.isInteger(a.totalResults) && a.totalResults > 0);
  // Realistic hosts show up across a handful of phrases
  const hosts = new Set();
  for (const phrase of ['running shoes', 'how to bake bread', 'best crm software', 'python tutorial']) (await sim.fetchSerp({ ...q, phrase })).results.forEach(r => hosts.add(r.host.replace(/^en\./, '')));
  for (const h of ['wikipedia.org', 'reddit.com', 'youtube.com']) assert.ok(hosts.has(h), h);
  // Variants and dates change the SERP
  assert.notDeepEqual((await sim.fetchSerp({ ...q, device: 'mobile' })).results, a.results);
  assert.notDeepEqual((await sim.fetchSerp({ ...q, date: '2026-03-02' })).results, a.results);
  await assert.rejects(sim.fetchSerp({ ...q, phrase: '  ' }));
});

test('tracked hosts drift day to day and some keywords are unranked', async () => {
  const sim = createSimulator();
  const ranks = [];
  for (let d = 1; d <= 60; d++) ranks.push(rankOf(await sim.fetchSerp({ ...q, hosts: ['acme-shoes.com'], date: new Date(Date.UTC(2026, 0, d)).toISOString() }), 'acme-shoes.com'));
  const ranked = ranks.filter(r => r != null);
  assert.ok(ranked.length > 30, 'mostly ranked across 60 days');
  assert.ok(new Set(ranked).size > 3, 'position moves over time');
  const steps = ranked.slice(1).map((r, i) => Math.abs(r - ranked[i]));
  assert.ok(Math.max(...steps) < 30, 'daily moves are a walk, not a jump: ' + steps);
  // Across many phrases a share is unranked for the same host
  let unranked = 0;
  for (let i = 0; i < 60; i++) if (rankOf(await sim.fetchSerp({ ...q, phrase: `widget idea ${i}`, hosts: ['acme-shoes.com'] }), 'acme-shoes.com') == null) unranked++;
  assert.ok(unranked > 0 && unranked < 40, `unranked=${unranked}`);
});

test('volume data is deterministic and shaped', async () => {
  const sim = createSimulator();
  const v = await sim.fetchVolume(['running shoes', 'buy cheap running shoes online', ''], { country: 'US' });
  assert.deepEqual(Object.keys(v), ['running shoes', 'buy cheap running shoes online']);
  assert.deepEqual(v, await sim.fetchVolume(['running shoes', 'buy cheap running shoes online'], { country: 'US' }));
  for (const x of Object.values(v)) {
    assert.ok(Number.isInteger(x.volume) && x.volume > 0);
    assert.ok(x.cpc > 0 && x.competition >= 0 && x.competition <= 1);
    assert.equal(x.trend.length, 12);
    assert.ok(x.trend.every(n => Number.isInteger(n) && n >= 0));
  }
  assert.ok(v['running shoes'].volume > 0);
});

test('module installs provider, reads tracked domains and competitors from DB, and reports status', async () => {
  const s = await startTestServer({ modules: ['rank-provider'] });
  try {
    assert.equal((await s.api('GET', '/api/rank-provider/status')).status, 401);
    const { user } = await s.signup();
    // Search many phrases so the tracked domain is guaranteed to rank in some of them
    const phrases = Array.from({ length: 12 }, (_, i) => `garden hose ${i}`);
    const { domainId } = s.seedDomain(user.id, 'hoseworld.com', phrases);
    s.ctx.db.prepare('INSERT INTO competitors(domain_id, host) VALUES (?,?)').run(domainId, 'www.rivalhose.net');
    let own = 0, rival = 0;
    for (const phrase of phrases) {
      const serp = await s.ctx.provider.fetchSerp({ ...q, phrase });
      if (rankOf(serp, 'hoseworld.com')) own++;
      if (rankOf(serp, 'rivalhose.net')) rival++;
    }
    assert.ok(own >= 6, `own ranked in ${own}`);
    assert.ok(rival >= 6, `rival ranked in ${rival}`);
    // Untracked phrase does not contain the domain
    assert.equal(rankOf(await s.ctx.provider.fetchSerp({ ...q, phrase: 'unrelated topic' }), 'hoseworld.com'), null);

    const r = await s.api('GET', '/api/rank-provider/status');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { provider: 'simulator', configured: true, active: 'simulator' });
  } finally { s.close(); }
});

test('provider selection from env falls back to simulator without credentials', async () => {
  let p = createProvider({ env: { RANK_PROVIDER: 'dataforseo' } });
  assert.deepEqual([p.requested, p.configured, p.name], ['dataforseo', false, 'simulator']);
  assert.equal((await p.fetchSerp(q)).results.length, 100);
  p = createProvider({ env: { RANK_PROVIDER: 'serpapi', SERPAPI_KEY: 'k' }, fetchImpl: async () => new Response('{}') });
  assert.deepEqual([p.requested, p.configured, p.name], ['serpapi', true, 'serpapi']);
});

test('DataForSEO adapter maps SERP and volume responses', async () => {
  const serp = { tasks: [{ status_code: 20000, result: [{ se_results_count: 12345, item_types: ['paid', 'organic', 'people_also_ask', 'featured_snippet'], items: [
    { type: 'paid', rank_absolute: 1, url: 'https://ad.com' },
    { type: 'featured_snippet', rank_absolute: 2, url: 'https://x.com/a' },
    { type: 'organic', rank_group: 2, rank_absolute: 4, url: 'https://www.b.com/2', domain: 'www.b.com', title: 'B' },
    { type: 'organic', rank_group: 1, rank_absolute: 3, url: 'https://a.com/1', domain: 'a.com', title: 'A', links: [{}] },
  ] }] }] };
  const m = mapDfs(serp);
  assert.deepEqual(m.results, [
    { position: 1, url: 'https://a.com/1', host: 'a.com', title: 'A', type: 'organic' },
    { position: 2, url: 'https://www.b.com/2', host: 'b.com', title: 'B', type: 'organic' },
  ]);
  assert.deepEqual(m.features.sort(), ['ads_top', 'featured_snippet', 'people_also_ask', 'sitelinks']);
  assert.equal(m.totalResults, 12345);
  assert.throws(() => mapDfs({ tasks: [{ status_code: 40501, status_message: 'Invalid Field' }] }), /Invalid Field/);

  const vol = mapDfsVolume({ tasks: [{ status_code: 20000, result: [{ keyword: 'shoes', search_volume: 900, cpc: 1.5, competition_index: 40,
    monthly_searches: [{ year: 2026, month: 2, search_volume: 800 }, { year: 2026, month: 1, search_volume: 700 }] }] }] }, ['Shoes', 'missing']);
  assert.deepEqual(vol, { Shoes: { volume: 900, cpc: 1.5, competition: 0.4, trend: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 700, 800] } });

  let call;
  const dfs = createDataForSeo({ login: 'u', password: 'p', fetchImpl: async (url, init) => { call = { url, init }; return new Response(JSON.stringify(serp)); } });
  await dfs.fetchSerp({ ...q, device: 'mobile', location: 'Austin' });
  assert.equal(call.url, 'https://api.dataforseo.com/v3/serp/google/organic/live/advanced');
  assert.equal(call.init.headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.deepEqual(JSON.parse(call.init.body)[0], { keyword: 'running shoes', location_name: 'Austin,United States', language_code: 'en', device: 'mobile', depth: 100 });
  const bad = createDataForSeo({ login: 'u', password: 'p', fetchImpl: async () => new Response('{"status_message":"nope"}', { status: 401 }) });
  await assert.rejects(bad.fetchSerp(q), /401/);
});

test('SerpApi adapter maps SERP responses and uses volume fallback', async () => {
  const data = { search_information: { total_results: 999 }, answer_box: {}, related_questions: [{}], inline_images: [],
    ads: [{ block_position: 'bottom' }], organic_results: [
      { position: 2, link: 'https://b.com/x', title: 'B' }, { position: 1, link: 'https://www.a.com/y', title: 'A', sitelinks: {} }] };
  const m = mapSerpApi(data);
  assert.deepEqual(m.results.map(r => [r.position, r.host]), [[1, 'a.com'], [2, 'b.com']]);
  assert.deepEqual(m.features.sort(), ['ads_bottom', 'featured_snippet', 'people_also_ask', 'sitelinks']);
  assert.equal(m.totalResults, 999);
  assert.throws(() => mapSerpApi({ error: 'Invalid API key' }), /Invalid API key/);

  let url;
  const sim = createSimulator();
  const api = createSerpApi({ apiKey: 'KEY', volumeFallback: sim.fetchVolume, fetchImpl: async u => { url = new URL(u); return new Response(JSON.stringify(data)); } });
  await api.fetchSerp({ ...q, location: 'Austin, Texas' });
  assert.deepEqual(Object.fromEntries(['engine', 'q', 'gl', 'num', 'device', 'location', 'api_key'].map(k => [k, url.searchParams.get(k)])),
    { engine: 'google', q: 'running shoes', gl: 'us', num: '100', device: 'desktop', location: 'Austin, Texas', api_key: 'KEY' });
  assert.deepEqual(await api.fetchVolume(['shoes']), await sim.fetchVolume(['shoes']));
});
