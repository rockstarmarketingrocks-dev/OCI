import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { FEATURE_LABELS } from '../server/modules/serp-features.js';

let t, user, domainId, kw;
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();
const isoDay = n => daysAgo(n).slice(0, 10);
const snap = (kid, n, rank, serp, owned = []) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, serp_features, owned_features) VALUES (?,?,?,?,?)')
    .run(kid, daysAgo(n), rank, JSON.stringify(serp), JSON.stringify(owned));
const feat = (data, id) => data.features.find(f => f.feature === id);

before(async () => {
  t = await startTestServer({ modules: ['serp-features'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['alpha', 'beta', 'gamma', 'never']));
  const [a, b, c] = kw;
  t.ctx.db.prepare('UPDATE keywords SET search_volume = ? WHERE id = ?').run(500, b);
  // Baseline before the 30d window: alpha has a snippet (not owned).
  snap(a, 40, 5, ['featured_snippet']);
  // 10 days ago: alpha owns the snippet, beta has snippet + PAA.
  snap(a, 10, 1, ['featured_snippet', 'people_also_ask'], ['featured_snippet']);
  snap(b, 10, 4, ['featured_snippet', 'people_also_ask']);
  // 2 days ago: gamma has video (owned only listed), beta loses PAA, bad JSON is tolerated.
  snap(c, 2, 3, [], ['video']);
  snap(b, 2, 3, ['featured_snippet', 'custom_widget', 42]);
});
after(() => t.close());

test('exports labels for every documented feature id', () => {
  for (const id of ['featured_snippet', 'people_also_ask', 'local_pack', 'ai_overview', 'ads_top', 'related_searches'])
    assert.equal(typeof FEATURE_LABELS[id], 'string');
  assert.equal(Object.keys(FEATURE_LABELS).length, 16);
});

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/serp-features?domainId=${domainId}`)).status, 401);
  assert.equal((await t.api('GET', `/api/serp-features/keywords?domainId=${domainId}&feature=video`)).status, 401);
  t.setToken(token);
});

test('validates input and scopes to owner', async () => {
  assert.equal((await t.api('GET', '/api/serp-features')).status, 400);
  assert.equal((await t.api('GET', '/api/serp-features?domainId=abc')).status, 400);
  assert.equal((await t.api('GET', `/api/serp-features?domainId=${domainId}&days=0`)).status, 400);
  assert.equal((await t.api('GET', '/api/serp-features?domainId=999999')).status, 404);
  assert.equal((await t.api('GET', `/api/serp-features/keywords?domainId=${domainId}`)).status, 400);
  assert.equal((await t.api('GET', `/api/serp-features/keywords?domainId=${domainId}&feature=Bad-Id`)).status, 400);
  assert.equal((await t.api('GET', `/api/serp-features/keywords?domainId=${domainId}&feature=video&owned=maybe`)).status, 400);
  assert.equal((await t.api('GET', `/api/serp-features/keywords?domainId=${domainId}&feature=a&feature=b`)).status, 400);
  const other = t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('sf-other@x.dev','x')").run();
  const od = t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'other.com')").run(other.lastInsertRowid);
  assert.equal((await t.api('GET', `/api/serp-features?domainId=${od.lastInsertRowid}`)).status, 404);
  assert.equal((await t.api('GET', `/api/serp-features/keywords?domainId=${od.lastInsertRowid}&feature=video`)).status, 404);
});

test('current counts use the latest snapshot per keyword', async () => {
  const { status, data } = await t.api('GET', `/api/serp-features?domainId=${domainId}`);
  assert.equal(status, 200);
  assert.equal(data.totalKeywords, 4);
  assert.equal(data.checkedKeywords, 3);
  const fs = feat(data, 'featured_snippet');
  assert.deepEqual({ ...fs, trend: undefined }, { feature: 'featured_snippet', label: 'Featured snippet', keywordsWithFeature: 2, ownedCount: 1, ownedPct: 50, trend: undefined });
  assert.equal(feat(data, 'people_also_ask').keywordsWithFeature, 1);
  assert.deepEqual([feat(data, 'video').keywordsWithFeature, feat(data, 'video').ownedPct], [1, 100]);
  assert.equal(feat(data, 'custom_widget').label, 'Custom widget');
  assert.equal(feat(data, 'local_pack').keywordsWithFeature, 0);
  assert.equal(data.features[0].feature, 'featured_snippet'); // sorted by presence
  assert.ok(Object.keys(FEATURE_LABELS).every(id => feat(data, id)));
});

test('trend carries state forward from the period start', async () => {
  const { data } = await t.api('GET', `/api/serp-features?domainId=${domainId}&days=30`);
  assert.equal(data.from, isoDay(30));
  assert.deepEqual(feat(data, 'featured_snippet').trend, [
    { date: isoDay(30), present: 1, owned: 0 },
    { date: isoDay(10), present: 2, owned: 1 },
    { date: isoDay(2), present: 2, owned: 1 },
  ]);
  assert.deepEqual(feat(data, 'people_also_ask').trend.map(p => p.present), [0, 2, 1]);
  const short = await t.api('GET', `/api/serp-features?domainId=${domainId}&days=5`);
  assert.deepEqual(feat(short.data, 'featured_snippet').trend.map(p => p.date), [isoDay(5), isoDay(2)]);
});

test('keyword list filters by feature and ownership', async () => {
  const base = `/api/serp-features/keywords?domainId=${domainId}&feature=featured_snippet`;
  const all = await t.api('GET', base);
  assert.equal(all.status, 200);
  assert.equal(all.data.label, 'Featured snippet');
  assert.deepEqual(all.data.keywords.map(k => k.phrase), ['beta', 'alpha']); // volume desc
  assert.deepEqual(all.data.keywords[1], { ...all.data.keywords[1], id: kw[0], rank: 1, owned: true, device: 'desktop', country: 'US' });
  assert.deepEqual((await t.api('GET', `${base}&owned=true`)).data.keywords.map(k => k.phrase), ['alpha']);
  assert.deepEqual((await t.api('GET', `${base}&owned=false`)).data.keywords.map(k => k.phrase), ['beta']);
  assert.deepEqual((await t.api('GET', `/api/serp-features/keywords?domainId=${domainId}&feature=local_pack`)).data.keywords, []);
});

test('empty domain returns zero counts and no trend', async () => {
  const { domainId: d } = t.seedDomain(user.id, 'empty.dev', []);
  const { status, data } = await t.api('GET', `/api/serp-features?domainId=${d}`);
  assert.equal(status, 200);
  assert.equal(data.checkedKeywords, 0);
  assert.ok(data.features.every(f => f.keywordsWithFeature === 0 && f.ownedPct === 0 && f.trend.length === 0));
});
