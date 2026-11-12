import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { normalizeHost } from '../server/modules/competitors.js';

let t, user, domainId, keywordIds, token;
const results = map => JSON.stringify(Object.entries(map).map(([host, position]) => ({ position, host, url: `https://${host}/p`, title: host, type: 'organic' })));
const snap = (kid, iso, rank, serp) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, results) VALUES (?,?,?,?)').run(kid, iso, rank, results(serp));
const url = (path = '', d = domainId) => `/api/competitors${path}${path.includes('?') ? '&' : '?'}domainId=${d}`;

before(async () => {
  t = await startTestServer({ modules: ['competitors'] });
  ({ user, token } = await t.signup());
  ({ domainId, keywordIds } = t.seedDomain(user.id, 'example.com', ['alpha', 'beta', 'gamma']));
  const [a, b] = keywordIds;
  // Old snapshot must be ignored in favour of the latest one.
  snap(a, '2026-01-01T00:00:00Z', 50, { 'rival.com': 90 });
  snap(a, '2026-02-01T00:00:00Z', 3, { 'big.org': 1, 'www.rival.com': 2, 'example.com': 3, 'blog.rival.com': 7, 'news.net': 9 });
  snap(b, '2026-02-01T00:00:00Z', null, { 'big.org': 2, 'rival.com': 5, 'news.net': 12, 'shop.example.com': 4 });
  // gamma never checked
});
after(() => t.close());

test('normalizeHost', () => {
  assert.equal(normalizeHost('https://WWW.Rival.com:8080/path?q=1'), 'rival.com');
  assert.equal(normalizeHost(' blog.rival.co.uk '), 'blog.rival.co.uk');
  assert.equal(normalizeHost('not a host'), null);
  assert.equal(normalizeHost('localhost'), null);
  assert.equal(normalizeHost(''), null);
});

test('requires auth and validates domain', async () => {
  t.setToken(null);
  assert.equal((await t.api('GET', url())).status, 401);
  t.setToken(token);
  assert.equal((await t.api('GET', '/api/competitors')).status, 400);
  assert.equal((await t.api('GET', '/api/competitors?domainId=abc')).status, 400);
  assert.equal((await t.api('GET', url('', 99999))).status, 404);
  const other = t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('comp-other@x.dev','x')").run();
  const od = Number(t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'theirs.com')").run(other.lastInsertRowid).lastInsertRowid);
  const oc = Number(t.ctx.db.prepare("INSERT INTO competitors(domain_id, host) VALUES (?, 'x.com')").run(od).lastInsertRowid);
  assert.equal((await t.api('GET', url('', od))).status, 404);
  assert.equal((await t.api('POST', url('', od), { host: 'y.com' })).status, 404);
  assert.equal((await t.api('DELETE', url(`/${oc}`))).status, 404);
});

test('add, list, validate and delete competitors', async () => {
  const events = [];
  t.ctx.events.on('competitors:changed', e => events.push(e));
  const add = await t.api('POST', url(), { host: 'https://www.Rival.com/some/page', displayName: 'Rival' });
  assert.equal(add.status, 201);
  assert.equal(add.data.host, 'rival.com');
  assert.equal(add.data.display_name, 'Rival');
  assert.deepEqual(events, [{ domainId, userId: user.id }]);

  assert.equal((await t.api('POST', url(), { host: 'rival.com' })).status, 409);
  assert.equal((await t.api('POST', url(), { host: 'nope' })).status, 400);
  assert.equal((await t.api('POST', url(), {})).status, 400);
  assert.equal((await t.api('POST', url(), { host: 'www.example.com' })).status, 400);
  assert.equal((await t.api('POST', url(), { host: 'shop.example.com' })).status, 400);
  assert.equal((await t.api('POST', url(), { host: 'ok.com', displayName: 5 })).status, 400);

  // domainId in body works too
  const viaBody = await t.api('POST', '/api/competitors', { domainId, host: 'temp.io' });
  assert.equal(viaBody.status, 201);
  const list = await t.api('GET', url());
  assert.deepEqual(list.data.map(c => c.host), ['rival.com', 'temp.io']);

  assert.equal((await t.api('DELETE', url('?host=TEMP.io'))).status, 200);
  assert.equal((await t.api('DELETE', url('?host=TEMP.io'))).status, 404);
  assert.equal((await t.api('DELETE', url())).status, 400);
  const tmp2 = (await t.api('POST', url(), { host: 'temp2.io' })).data;
  assert.equal((await t.api('DELETE', url(`/${tmp2.id}`))).status, 200);
  assert.equal((await t.api('DELETE', url('/abc'))).status, 400);
  assert.deepEqual((await t.api('GET', url())).data.map(c => c.host), ['rival.com']);
});

test('compare gives per-keyword ranks and head-to-head summary', async () => {
  await t.api('POST', url(), { host: 'big.org' });
  const { status, data } = await t.api('GET', url('/compare'));
  assert.equal(status, 200);
  assert.deepEqual(data.competitors.map(c => c.host), ['rival.com', 'big.org']);
  const by = Object.fromEntries(data.keywords.map(k => [k.phrase, k]));
  assert.deepEqual([by.alpha.you, by.alpha.ranks], [3, { 'rival.com': 2, 'big.org': 1 }]);
  assert.deepEqual([by.beta.you, by.beta.ranks], [null, { 'rival.com': 5, 'big.org': 2 }]);
  assert.deepEqual([by.gamma.you, by.gamma.checkedAt, by.gamma.ranks], [null, null, { 'rival.com': null, 'big.org': null }]);
  const rival = data.summary.find(s => s.host === 'rival.com');
  assert.deepEqual({ ...rival, id: undefined, displayName: undefined },
    { id: undefined, displayName: undefined, host: 'rival.com', wins: 0, losses: 2, ties: 0, ranked: 2, avgRank: 3.5, top10: 2 });
  assert.deepEqual(data.you, { ranked: 1, avgRank: 3, top10: 1, checked: 2 });
});

test('suggest lists top-10 hosts not yet competitors, excluding own domain', async () => {
  const { status, data } = await t.api('GET', url('/suggest'));
  assert.equal(status, 200);
  // big.org and rival.com (incl. blog.rival.com) are competitors; shop.example.com is own; news.net #12 on beta is outside top 10.
  assert.deepEqual(data, [{ host: 'news.net', keywords: 1, bestPosition: 9, avgPosition: 9 }]);
  await t.api('DELETE', url('?host=big.org'));
  const again = (await t.api('GET', url('/suggest?limit=1'))).data;
  assert.deepEqual(again, [{ host: 'big.org', keywords: 2, bestPosition: 1, avgPosition: 1.5 }]);
  assert.equal((await t.api('GET', url('/suggest?limit=0'))).status, 400);
});

test('empty domain', async () => {
  const { domainId: d } = t.seedDomain(user.id, 'empty.dev', []);
  const cmp = (await t.api('GET', url('/compare', d))).data;
  assert.deepEqual([cmp.keywords, cmp.summary, cmp.you.avgRank], [[], [], null]);
  assert.deepEqual((await t.api('GET', url('/suggest', d))).data, []);
});
