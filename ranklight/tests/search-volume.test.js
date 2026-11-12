import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { lastMonths } from '../server/modules/search-volume.js';

let t, user, domainId, ids;
const calls = [];
const trendOf = base => Array.from({ length: 12 }, (_, i) => base + i * 10);
const mockProvider = {
  async fetchVolume(phrases, opts) {
    calls.push({ phrases, opts });
    const out = {};
    for (const p of phrases) {
      if (p === 'unknown phrase') continue;
      if (p === 'boom') throw new Error('upstream down');
      const base = p.length * 100;
      out[p] = { volume: base, cpc: p.length / 10, competition: 0.5, trend: trendOf(base) };
    }
    return out;
  },
};
const tick = () => new Promise(r => setTimeout(r, 20));

before(async () => {
  t = await startTestServer({ modules: ['search-volume'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds: ids } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker', 'unknown phrase']));
  t.ctx.db.prepare("UPDATE keywords SET country = 'DE', language = 'de' WHERE id = ?").run(ids[1]);
  // A rank snapshot fixture; volume data must not depend on it.
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank) VALUES (?,?,?)').run(ids[0], new Date().toISOString(), 3);
});
after(() => t.close());

test('lastMonths returns 12 months ending with the current month', () => {
  const m = lastMonths(new Date('2026-02-15T00:00:00Z'));
  assert.equal(m.length, 12);
  assert.equal(m[0], '2025-03');
  assert.equal(m.at(-1), '2026-02');
});

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/search-volume?domainId=${domainId}`)).status, 401);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', { domainId })).status, 401);
  t.setToken(token);
});

test('returns 503 on refresh without a provider and lists keywords without volume', async () => {
  t.ctx.provider = null;
  const r = await t.api('POST', '/api/search-volume/refresh', { domainId });
  assert.equal(r.status, 503);
  const g = await t.api('GET', `/api/search-volume?domainId=${domainId}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.providerAvailable, false);
  assert.equal(g.data.keywords.length, 3);
  assert.ok(g.data.keywords.every(k => k.volume == null && k.trend.length === 12 && k.trend.every(v => v == null)));
  assert.equal(g.data.totals.volume, 0);
  assert.equal(g.data.totals.avgCpc, null);
});

test('validates input and scopes to owner', async () => {
  t.ctx.provider = mockProvider;
  assert.equal((await t.api('GET', '/api/search-volume')).status, 400);
  assert.equal((await t.api('GET', '/api/search-volume?domainId=abc')).status, 400);
  assert.equal((await t.api('GET', '/api/search-volume?domainId=999999')).status, 404);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', {})).status, 400);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', { domainId: 'x' })).status, 400);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', { domainId, keywordIds: 'a' })).status, 400);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', { domainId, keywordIds: [999999] })).status, 404);
  const other = Number(t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('sv-other@x.dev','x')").run().lastInsertRowid);
  const foreign = t.seedDomain(other, 'foreign.com', ['secret']);
  assert.equal((await t.api('GET', `/api/search-volume?domainId=${foreign.domainId}`)).status, 404);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', { domainId: foreign.domainId })).status, 404);
  assert.equal((await t.api('POST', '/api/search-volume/refresh', { domainId, keywordIds: foreign.keywordIds })).status, 404);
  assert.equal(calls.length, 0);
});

test('refresh enriches keywords grouped by country/language and stores history', async () => {
  t.ctx.provider = mockProvider;
  const r = await t.api('POST', '/api/search-volume/refresh', { domainId });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.requested, r.data.updated, r.data.missing], [3, 2, 1]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.opts.country).sort(), ['DE', 'US']);
  const kw = t.ctx.db.prepare('SELECT search_volume, cpc FROM keywords WHERE id = ?').get(ids[0]);
  assert.deepEqual({ ...kw }, { search_volume: 800, cpc: 0.8 });

  const { status, data } = await t.api('GET', `/api/search-volume?domainId=${domainId}`);
  assert.equal(status, 200);
  assert.equal(data.providerAvailable, true);
  assert.deepEqual(data.months, lastMonths());
  assert.deepEqual(data.keywords.map(k => k.phrase), ['rank tracker', 'seo tool', 'unknown phrase']);
  const [rt, seo, unk] = data.keywords;
  assert.deepEqual(rt.trend, trendOf(1200));
  assert.deepEqual(seo.trend, trendOf(800));
  assert.equal(seo.competition, 0.5);
  assert.equal(unk.volume, null);
  assert.deepEqual(data.totals.trend, trendOf(2000).map((v, i) => v + i * 10));
  assert.equal(data.totals.volume, 2000);
  assert.equal(data.totals.withVolume, 2);
  assert.equal(data.totals.keywords, 3);
  assert.equal(data.totals.avgCpc, 1);
  assert.equal(data.totals.avgCompetition, 0.5);
  assert.equal(data.totals.trafficValue, 800 * 0.8 + 1200 * 1.2);
  assert.ok(data.totals.lastUpdated);

  // Refreshing again upserts instead of duplicating history rows.
  await t.api('POST', '/api/search-volume/refresh', { domainId, keywordIds: [ids[0]] });
  assert.equal(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM keyword_volume_history WHERE keyword_id = ?').get(ids[0]).n, 12);
});

test('provider failure returns 502', async () => {
  t.ctx.provider = mockProvider;
  const kid = Number(t.ctx.db.prepare("INSERT INTO keywords(domain_id, phrase) VALUES (?, 'boom')").run(domainId).lastInsertRowid);
  const r = await t.api('POST', '/api/search-volume/refresh', { domainId, keywordIds: [kid] });
  assert.equal(r.status, 502);
  t.ctx.db.prepare('DELETE FROM keywords WHERE id = ?').run(kid);
});

test('keywords:added enriches new keywords when a provider is present', async () => {
  t.ctx.provider = mockProvider;
  let emitted = null;
  t.ctx.events.once('search-volume:updated', p => { emitted = p; });
  const kid = Number(t.ctx.db.prepare("INSERT INTO keywords(domain_id, phrase) VALUES (?, 'new keyword')").run(domainId).lastInsertRowid);
  t.ctx.events.emit('keywords:added', { domainId, keywordIds: [kid] });
  await tick();
  assert.equal(t.ctx.db.prepare('SELECT search_volume FROM keywords WHERE id = ?').get(kid).search_volume, 1100);
  assert.deepEqual(emitted, { domainId, keywordIds: [kid] });

  t.ctx.provider = null;
  const k2 = Number(t.ctx.db.prepare("INSERT INTO keywords(domain_id, phrase) VALUES (?, 'no provider')").run(domainId).lastInsertRowid);
  t.ctx.events.emit('keywords:added', { domainId, keywordIds: [k2] });
  await tick();
  assert.equal(t.ctx.db.prepare('SELECT search_volume FROM keywords WHERE id = ?').get(k2).search_volume, null);
});
