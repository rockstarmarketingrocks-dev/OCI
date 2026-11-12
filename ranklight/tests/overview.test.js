import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t, user, domainId, keywordIds;
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();
const snap = (kid, n, rank, url = rank ? 'https://example.com/p' : null) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url) VALUES (?,?,?,?)').run(kid, daysAgo(n), rank, url);

before(async () => {
  t = await startTestServer({ modules: ['overview'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds } = t.seedDomain(user.id, 'example.com', ['alpha', 'beta', 'gamma', 'delta', 'epsilon']));
  const [a, b, c, d] = keywordIds; // epsilon is never checked
  t.ctx.db.prepare('UPDATE keywords SET search_volume = 1000 WHERE domain_id = ?').run(domainId);
  // alpha: 10 -> 2 (winner +8); beta: 5 -> 15 (loser -10); gamma: 40 -> 40; delta: unranked before window, new in window at 60 then 50
  snap(a, 40, 10); snap(a, 10, 5); snap(a, 1, 2);
  snap(b, 40, 5); snap(b, 1, 15);
  snap(c, 40, 40); snap(c, 1, 40);
  snap(d, 5, 60); snap(d, 1, 50);
});
after(() => t.close());

test('requires auth', async () => {
  const saved = (await t.api('GET', `/api/overview?domainId=${domainId}`));
  assert.equal(saved.status, 200);
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/overview?domainId=${domainId}`)).status, 401);
  t.setToken((await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token);
});

test('validates input and scopes to owner', async () => {
  assert.equal((await t.api('GET', '/api/overview')).status, 400);
  assert.equal((await t.api('GET', `/api/overview?domainId=abc`)).status, 400);
  assert.equal((await t.api('GET', `/api/overview?domainId=${domainId}&days=0`)).status, 400);
  assert.equal((await t.api('GET', `/api/overview?domainId=${domainId}&days=x`)).status, 400);
  assert.equal((await t.api('GET', '/api/overview?domainId=999999')).status, 404);
  const other = t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('o@x.dev','x')").run();
  const od = t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'other.com')").run(other.lastInsertRowid);
  assert.equal((await t.api('GET', `/api/overview?domainId=${od.lastInsertRowid}`)).status, 404);
});

test('computes KPIs for a 30 day period', async () => {
  const { status, data } = await t.api('GET', `/api/overview?domainId=${domainId}&days=30`);
  assert.equal(status, 200);
  const k = data.kpis;
  assert.equal(k.keywords, 5);
  assert.equal(k.top3, 1);
  assert.equal(k.top10, 1);
  assert.equal(k.top100, 4);
  assert.equal(k.notRanked, 1);
  assert.equal(k.up, 2);   // alpha, delta (+10 within period)
  assert.equal(k.down, 1); // beta
  assert.equal(k.unchanged, 2);
  assert.equal(k.avgRank, (2 + 15 + 40 + 50) / 4);
  assert.equal(k.avgRankChange, round2((10 + 5 + 40 + 60) / 4 - (2 + 15 + 40 + 50) / 4));
  assert.ok(k.shareOfVoice > 0 && k.shareOfVoice <= 100);
  assert.ok(k.sovChange > 0);
  assert.equal(k.estimatedClicks, Math.round(1000 * (0.157 + 0.008))); // rank 2 and rank 15
  assert.deepEqual(data.winners.map(w => w.phrase), ['delta', 'alpha']);
  assert.equal(data.winners[0].change, 10);
  assert.equal(data.winners[1].previousRank, 10);
  assert.deepEqual(data.losers.map(w => [w.phrase, w.change]), [['beta', -10]]);
});

test('builds daily history with carry-forward', async () => {
  const { data } = await t.api('GET', `/api/overview?domainId=${domainId}&days=30`);
  const h = data.rankDistributionHistory;
  assert.equal(h.length, 4); // baseline, -10d, -5d, -1d
  assert.equal(h[0].date, data.from);
  assert.deepEqual(h[0], { date: data.from, top3: 0, top4_10: 2, top11_20: 0, top21_50: 1, top51_100: 0, notRanked: 0 });
  assert.equal(h.at(-1).top3, 1);
  assert.equal(h.at(-1).top51_100, 0);
  assert.equal(h.at(-1).top21_50, 2);
  assert.equal(data.avgRankHistory.length, 4);
  assert.equal(data.avgRankHistory[1].avgRank, round2((5 + 5 + 40) / 3));
  for (let i = 1; i < h.length; i++) assert.ok(h[i].date > h[i - 1].date);
});

test('short period uses rank as of period start as baseline', async () => {
  const { data } = await t.api('GET', `/api/overview?domainId=${domainId}&days=7`);
  const alpha = data.winners.find(w => w.phrase === 'alpha');
  assert.equal(alpha.previousRank, 5);
  assert.equal(alpha.change, 3);
  assert.equal(data.kpis.top3, 1);
});

test('empty domain returns zeros', async () => {
  const { domainId: empty } = t.seedDomain(user.id, 'empty.com', []);
  const { status, data } = await t.api('GET', `/api/overview?domainId=${empty}`);
  assert.equal(status, 200);
  assert.equal(data.kpis.keywords, 0);
  assert.equal(data.kpis.avgRank, null);
  assert.equal(data.kpis.shareOfVoice, 0);
  assert.deepEqual(data.rankDistributionHistory, []);
  assert.deepEqual(data.winners, []);
});

function round2(n) { return Math.round(n * 100) / 100; }
