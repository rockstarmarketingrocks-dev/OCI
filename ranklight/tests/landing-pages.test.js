import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { CTR_CURVE } from '../server/lib/metrics.js';
import { normalizeUrl } from '../server/modules/landing-pages.js';

let t, user, domainId, ids;
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();
const snap = (kid, n, rank, url, results = []) => t.ctx.db
  .prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, results) VALUES (?,?,?,?,?)')
  .run(kid, daysAgo(n), rank, url, JSON.stringify(results));
const A = 'https://example.com/a', B = 'https://example.com/b/';
const r2 = n => Math.round(n * 100) / 100;

before(async () => {
  t = await startTestServer({ modules: ['landing-pages'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds: ids } = t.seedDomain(user.id, 'example.com', ['alpha', 'beta', 'gamma', 'delta', 'epsilon']));
  const db = t.ctx.db, [a, b, c, d, e] = ids;
  [1000, 2000, 500, 300, 100].forEach((v, i) => db.prepare('UPDATE keywords SET search_volume = ? WHERE id = ?').run(v, ids[i]));
  db.prepare('UPDATE keywords SET preferred_url = ? WHERE id = ?').run('http://www.example.com/a', a); // matches A after normalization
  db.prepare('UPDATE keywords SET preferred_url = ? WHERE id = ?').run('https://example.com/b', c);   // ranks with A instead
  // alpha: /a #5 -> #2 (improved), stable URL
  snap(a, 3, 5, A); snap(a, 1, 2, A);
  // beta: switched from /a to /b within 30 days, plus an old switch outside the window
  snap(b, 60, 9, 'https://example.com/old'); snap(b, 10, 4, A); snap(b, 5, 6, B); snap(b, 1, 3, 'https://example.com/b');
  // gamma: ranks with /a (#8) while preferred is /b, which sits at #12 in the stored SERP
  snap(c, 1, 8, A, [{ position: 8, url: A, host: 'example.com', type: 'organic' }, { position: 12, url: 'https://example.com/b', host: 'example.com', type: 'organic' }]);
  // delta: unranked; epsilon: never checked
  snap(d, 1, null, null);
  void e;
});
after(() => t.close());

test('normalizeUrl ignores scheme, www, trailing slash and fragment', () => {
  assert.equal(normalizeUrl('http://WWW.Example.com/a/#top'), normalizeUrl('https://example.com/a'));
  assert.notEqual(normalizeUrl('https://example.com/a?x=1'), normalizeUrl('https://example.com/a'));
  assert.equal(normalizeUrl(''), '');
});

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/landing-pages?domainId=${domainId}`)).status, 401);
  t.setToken(token);
});

test('validates input and scopes to owner', async () => {
  assert.equal((await t.api('GET', '/api/landing-pages')).status, 400);
  assert.equal((await t.api('GET', '/api/landing-pages?domainId=abc')).status, 400);
  assert.equal((await t.api('GET', '/api/landing-pages?domainId=1&domainId=2')).status, 400);
  assert.equal((await t.api('GET', `/api/landing-pages/detail?domainId=${domainId}`)).status, 400);
  assert.equal((await t.api('GET', `/api/landing-pages/cannibalization?domainId=${domainId}&days=0`)).status, 400);
  assert.equal((await t.api('GET', `/api/landing-pages/cannibalization?domainId=${domainId}&days=400`)).status, 400);
  assert.equal((await t.api('GET', '/api/landing-pages/mismatches?domainId=999999')).status, 404);
  const other = Number(t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('lp-other@x.dev','x')").run().lastInsertRowid);
  const foreign = Number(t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'foreign.com')").run(other).lastInsertRowid);
  for (const p of ['', '/detail', '/cannibalization', '/mismatches'])
    assert.equal((await t.api('GET', `/api/landing-pages${p}?domainId=${foreign}&url=x`)).status, 404, p);
});

test('groups latest snapshots by ranking URL', async () => {
  const { status, data } = await t.api('GET', `/api/landing-pages?domainId=${domainId}`);
  assert.equal(status, 200);
  const max = (1000 + 2000 + 500 + 300) * CTR_CURVE[1];
  const clicksA = 1000 * CTR_CURVE[2] + 500 * CTR_CURVE[8], clicksB = 2000 * CTR_CURVE[3];
  assert.equal(data.pages.length, 2);
  const [p1, p2] = data.pages;
  // More clicks first; displayed spelling is the one from the latest snapshot.
  assert.deepEqual({ ...p1, estimatedClicks: undefined }, {
    url: 'https://example.com/b', keywords: 1, avgRank: 3, bestRank: 3, totalVolume: 2000, estimatedClicks: undefined,
    sov: r2(clicksB / max * 100), share: r2(clicksB / (clicksA + clicksB) * 100),
  });
  assert.equal(p2.url, A);
  assert.equal(p2.keywords, 2);
  assert.equal(p2.avgRank, 5);
  assert.equal(p2.bestRank, 2);
  assert.equal(p2.totalVolume, 1500);
  assert.equal(p2.estimatedClicks, Math.round(clicksA * 10) / 10);
  assert.deepEqual(data.totals, {
    pages: 2, rankedKeywords: 3, unrankedKeywords: 1,
    estimatedClicks: Math.round((clicksA + clicksB) * 10) / 10, sov: r2((clicksA + clicksB) / max * 100),
  });
});

test('detail lists keywords for a URL with rank change', async () => {
  const { status, data } = await t.api('GET', `/api/landing-pages/detail?domainId=${domainId}&url=${encodeURIComponent('example.com/a/')}`);
  assert.equal(status, 200);
  assert.equal(data.url, A);
  assert.deepEqual(data.keywords.map(k => [k.phrase, k.rank, k.previousRank, k.change, k.preferredMatch]),
    [['alpha', 2, 5, 3, true], ['gamma', 8, null, null, false]]);
  const empty = await t.api('GET', `/api/landing-pages/detail?domainId=${domainId}&url=${encodeURIComponent('https://example.com/none')}`);
  assert.deepEqual(empty.data.keywords, []);
});

test('cannibalization finds keywords whose ranking URL changed in the window', async () => {
  const { status, data } = await t.api('GET', `/api/landing-pages/cannibalization?domainId=${domainId}`);
  assert.equal(status, 200);
  assert.equal(data.days, 30);
  assert.equal(data.keywords.length, 1);
  const [k] = data.keywords;
  assert.equal(k.phrase, 'beta');
  assert.equal(k.switches, 1);
  assert.equal(k.currentRank, 3);
  assert.deepEqual(k.urls.map(u => [u.url, u.snapshots, u.bestRank]), [[B, 2, 3], [A, 1, 4]]);
  // A 90-day window also picks up the older URL.
  const wide = await t.api('GET', `/api/landing-pages/cannibalization?domainId=${domainId}&days=90`);
  assert.equal(wide.data.keywords[0].urls.length, 3);
  assert.equal(wide.data.keywords[0].switches, 2);
  // A 2-day window has only one URL per keyword.
  assert.deepEqual((await t.api('GET', `/api/landing-pages/cannibalization?domainId=${domainId}&days=2`)).data.keywords, []);
});

test('mismatches lists keywords ranking with a non-preferred URL', async () => {
  const { status, data } = await t.api('GET', `/api/landing-pages/mismatches?domainId=${domainId}`);
  assert.equal(status, 200);
  assert.equal(data.keywordsWithPreferredUrl, 2);
  assert.equal(data.keywords.length, 1);
  assert.deepEqual((({ phrase, rankingUrl, preferredUrl, rank, preferredPosition }) => ({ phrase, rankingUrl, preferredUrl, rank, preferredPosition }))(data.keywords[0]),
    { phrase: 'gamma', rankingUrl: A, preferredUrl: 'https://example.com/b', rank: 8, preferredPosition: 12 });
});

test('empty domain returns empty collections', async () => {
  const d = Number(t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'empty.com')").run(user.id).lastInsertRowid);
  const lp = await t.api('GET', `/api/landing-pages?domainId=${d}`);
  assert.deepEqual(lp.data.pages, []);
  assert.equal(lp.data.totals.sov, 0);
  assert.deepEqual((await t.api('GET', `/api/landing-pages/cannibalization?domainId=${d}`)).data.keywords, []);
  assert.deepEqual((await t.api('GET', `/api/landing-pages/mismatches?domainId=${d}`)).data.keywords, []);
});
