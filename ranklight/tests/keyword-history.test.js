import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t, user, domainId, kw, emptyKw;
const isoDay = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const at = (n, time = '08:00:00') => `${isoDay(n)}T${time}Z`;
const results = (ours, extra = []) => [
  { position: 1, url: 'https://rival.io/a', host: 'rival.io', title: 'Rival <b>' },
  { position: 2, url: 'https://blog.rival.io/x', host: 'blog.rival.io', title: 'Rival blog' },
  { position: 3, url: 'https://other.org/', host: 'other.org', title: 'Other' },
  ...(ours ? [{ position: ours, url: 'https://www.example.com/p', host: 'www.example.com', title: 'Ours' }] : []),
  ...extra,
];
function snap(kid, checkedAt, rank, url, { features = [], res = results(rank) } = {}) {
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, serp_features, results) VALUES (?,?,?,?,?,?)')
    .run(kid, checkedAt, rank, url, JSON.stringify(features), JSON.stringify(res));
}

before(async () => {
  t = await startTestServer({ modules: ['keyword-history'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds: [kw, emptyKw] } = t.seedDomain(user.id, 'example.com', ['blue widgets', 'never checked']));
  t.ctx.db.prepare("UPDATE keywords SET device = 'mobile', location = 'Austin', preferred_url = 'https://www.example.com/p' WHERE id = ?").run(kw);
  t.ctx.db.prepare("INSERT INTO competitors(domain_id, host, display_name) VALUES (?, 'rival.io', 'Rival')").run(domainId);
  snap(kw, at(200), 30, 'https://www.example.com/old');      // outside 90d window
  snap(kw, at(20), null, null);
  snap(kw, at(10), 12, 'https://www.example.com/old', { features: ['featured_snippet'] });
  snap(kw, at(10, '20:00:00'), 9, 'https://www.example.com/old'); // same day, later wins
  snap(kw, at(5), 4, 'https://www.example.com/p', { features: ['people_also_ask', 'video'] });
  snap(kw, at(1), 6, 'https://www.example.com/p');
});
after(() => t.close());

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}`)).status, 401);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}/serp`)).status, 401);
  t.setToken(token);
});

test('validates input and scopes to owner', async () => {
  assert.equal((await t.api('GET', '/api/keyword-history/abc')).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-history/0')).status, 400);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}?days=0`)).status, 400);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}?days=1.5`)).status, 400);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}/serp?date=2024-02-30`)).status, 400);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}/serp?date=yesterday`)).status, 400);
  assert.equal((await t.api('GET', `/api/keyword-history/${kw}/url-history?days=-3`)).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-history/999999')).status, 404);
  const other = t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('kh-other@x.dev','x')").run();
  const od = t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'other.com')").run(other.lastInsertRowid);
  const ok = t.ctx.db.prepare("INSERT INTO keywords(domain_id, phrase) VALUES (?, 'secret')").run(od.lastInsertRowid);
  snap(Number(ok.lastInsertRowid), at(1), 1, 'https://other.com/');
  for (const p of ['', '/serp', '/url-history']) assert.equal((await t.api('GET', `/api/keyword-history/${ok.lastInsertRowid}${p}`)).status, 404);
});

test('returns daily history with best/worst rank and firstSeen', async () => {
  const { status, data } = await t.api('GET', `/api/keyword-history/${kw}`);
  assert.equal(status, 200);
  assert.equal(data.keyword.phrase, 'blue widgets');
  assert.equal(data.keyword.device, 'mobile');
  assert.equal(data.keyword.location, 'Austin');
  assert.equal(data.keyword.domainHost, 'example.com');
  assert.equal(data.days, 90);
  assert.deepEqual(data.history.map(h => h.rank), [null, 9, 4, 6]);
  assert.deepEqual(data.history.map(h => h.date), [isoDay(20), isoDay(10), isoDay(5), isoDay(1)]);
  assert.deepEqual(data.history[2].serp_features, ['people_also_ask', 'video']);
  assert.equal(data.history[1].url, 'https://www.example.com/old');
  assert.equal(data.bestRank, 4);
  assert.equal(data.worstRank, 9);
  assert.equal(data.currentRank, 6);
  assert.equal(data.firstSeen, isoDay(200));

  const all = (await t.api('GET', `/api/keyword-history/${kw}?days=365`)).data;
  assert.equal(all.history.length, 5);
  assert.equal(all.worstRank, 30);
});

test('empty keyword returns empty history', async () => {
  const { status, data } = await t.api('GET', `/api/keyword-history/${emptyKw}`);
  assert.equal(status, 200);
  assert.deepEqual(data.history, []);
  assert.equal(data.bestRank, null);
  assert.equal(data.firstSeen, null);
  assert.equal((await t.api('GET', `/api/keyword-history/${emptyKw}/serp`)).status, 404);
  assert.deepEqual((await t.api('GET', `/api/keyword-history/${emptyKw}/url-history`)).data.periods, []);
});

test('serp returns nearest snapshot with domain and competitors flagged', async () => {
  const latest = (await t.api('GET', `/api/keyword-history/${kw}/serp`)).data;
  assert.equal(latest.date, isoDay(1));
  assert.equal(latest.rank, 6);
  assert.equal(latest.requestedDate, null);
  assert.ok(latest.availableDates.includes(isoDay(200)));

  const { status, data } = await t.api('GET', `/api/keyword-history/${kw}/serp?date=${isoDay(6)}`);
  assert.equal(status, 200);
  assert.equal(data.date, isoDay(5));
  assert.equal(data.requestedDate, isoDay(6));
  assert.deepEqual(data.results.map(r => r.position), [1, 2, 3, 4]);
  const [r1, r2, r3, ours] = data.results;
  assert.deepEqual(r1.competitor, { id: r1.competitor.id, host: 'rival.io', name: 'Rival' });
  assert.equal(r2.competitor.host, 'rival.io'); // subdomain of competitor
  assert.equal(r3.competitor, null);
  assert.equal(r3.isDomain, false);
  assert.equal(ours.isDomain, true);
  assert.equal(r1.title, 'Rival <b>');
  assert.equal(r1.type, 'organic');

  const near10 = (await t.api('GET', `/api/keyword-history/${kw}/serp?date=${isoDay(10)}`)).data;
  assert.equal(near10.rank, 12); // 08:00 snapshot is nearer to midday than the 20:00 one
  assert.deepEqual(near10.serp_features, ['featured_snippet']);
});

test('url-history collapses runs and lists changes', async () => {
  const { status, data } = await t.api('GET', `/api/keyword-history/${kw}/url-history`);
  assert.equal(status, 200);
  assert.deepEqual(data.periods.map(p => [p.url, p.checks]), [
    ['https://www.example.com/old', 1], [null, 1], ['https://www.example.com/old', 2], ['https://www.example.com/p', 2]]);
  assert.equal(data.periods[2].bestRank, 9);
  assert.equal(data.periods[3].isPreferred, true);
  assert.equal(data.periods[0].isPreferred, false);
  assert.equal(data.currentUrl, 'https://www.example.com/p');
  assert.equal(data.distinctUrls, 2);
  assert.equal(data.changes.length, 3);
  assert.deepEqual(data.changes.at(-1), { date: isoDay(5), from: 'https://www.example.com/old', to: 'https://www.example.com/p', rank: 4 });
  const recent = (await t.api('GET', `/api/keyword-history/${kw}/url-history?days=7`)).data;
  assert.deepEqual(recent.periods.map(p => p.url), ['https://www.example.com/p']);
  assert.deepEqual(recent.changes, []);
});
