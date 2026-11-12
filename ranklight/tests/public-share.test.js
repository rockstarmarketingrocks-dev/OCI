import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { dashboardData, avgRankSvg } from '../server/modules/public-share.js';

let t, user, token, domainId, kw;
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) + 'T08:00:00Z';
const viewPath = l => l.path;

before(async () => {
  t = await startTestServer({ modules: ['public-share'] });
  ({ user, token } = await t.signup());
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker', '<script>alert(1)</script>']));
  const ins = t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url) VALUES (?,?,?,?)');
  ins.run(kw[0], day(2), 8, 'https://example.com/a');
  ins.run(kw[1], day(2), 3, 'https://example.com/b');
  ins.run(kw[0], day(1), 5, 'https://example.com/a');
  ins.run(kw[1], day(1), 4, 'https://example.com/b');
  ins.run(kw[2], day(1), null, null);
});
after(() => t.close());

test('dashboardData computes KPIs, change and avg series', () => {
  const d = dashboardData(t.ctx.db, domainId, 30);
  assert.equal(d.kpis.total, 3);
  assert.equal(d.kpis.ranked, 2);
  assert.equal(d.kpis.avgRank, 4.5);
  assert.equal(d.kpis.top3, 0);
  assert.equal(d.kpis.top10, 2);
  assert.equal(d.kpis.improved, 1);
  assert.equal(d.kpis.declined, 1);
  assert.deepEqual(d.keywords.map(k => [k.phrase, k.rank, k.change]), [['rank tracker', 4, -1], ['seo tool', 5, 3], ['<script>alert(1)</script>', null, null]]);
  assert.deepEqual(d.series.map(p => p.avg), [5.5, 4.5]);
  assert.match(avgRankSvg(d.series), /<svg[^>]*>.*<path d="M/s);
  assert.match(avgRankSvg([]), /No ranking history/);
});

test('CRUD lifecycle and public view with view counting', async () => {
  const c = await t.api('POST', '/api/public-share', { domainId, name: 'Client report', expiresInDays: 30 });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.name, 'Client report');
  assert.equal(c.data.domain, 'example.com');
  assert.equal(c.data.hasPassword, false);
  assert.equal(c.data.expired, false);
  assert.equal(c.data.views, 0);
  assert.match(c.data.token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(new Date(c.data.expiresAt) > new Date(Date.now() + 29 * 864e5));

  t.setToken(null);
  const v = await t.api('GET', viewPath(c.data));
  t.setToken(token);
  assert.equal(v.status, 200);
  assert.match(v.headers.get('content-type'), /text\/html/);
  assert.match(v.headers.get('x-robots-tag'), /noindex/);
  assert.match(v.data, /Client report/);
  assert.match(v.data, /<svg/);
  assert.match(v.data, /rank tracker/);
  assert.match(v.data, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(v.data, /<script>alert/);
  assert.match(v.data, /▲ 3/);

  const list = await t.api('GET', `/api/public-share?domainId=${domainId}`);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].views, 1);
  assert.equal((await t.api('GET', '/api/public-share')).data.length, 1);

  const up = await t.api('PATCH', `/api/public-share/${c.data.id}`, { name: 'Renamed', expiresAt: null });
  assert.equal(up.status, 200);
  assert.equal(up.data.name, 'Renamed');
  assert.equal(up.data.expiresAt, null);
  assert.equal((await t.api('GET', `/api/public-share/${c.data.id}`)).data.views, 1);

  assert.deepEqual((await t.api('DELETE', `/api/public-share/${c.data.id}`)).data, { ok: true });
  assert.equal((await t.api('GET', `/api/public-share/${c.data.id}`)).status, 404);
  t.setToken(null);
  assert.equal((await t.api('GET', viewPath(c.data))).status, 404);
  t.setToken(token);
});

test('password-protected links', async () => {
  const c = await t.api('POST', '/api/public-share', { domainId, password: 'hunter22' });
  assert.equal(c.data.hasPassword, true);
  assert.equal(c.data.name, '');
  t.setToken(null);
  const none = await t.api('GET', viewPath(c.data));
  assert.equal(none.status, 401);
  assert.match(none.data, /name="password"/);
  const wrong = await t.api('GET', `${viewPath(c.data)}?password=nope`);
  assert.equal(wrong.status, 401);
  assert.match(wrong.data, /Incorrect password/);
  const ok = await t.api('GET', `${viewPath(c.data)}?password=hunter22`);
  assert.equal(ok.status, 200);
  assert.match(ok.data, /example\.com rankings/);
  t.setToken(token);
  assert.equal((await t.api('GET', `/api/public-share/${c.data.id}`)).data.views, 1);
  const cleared = await t.api('PATCH', `/api/public-share/${c.data.id}`, { password: '' });
  assert.equal(cleared.data.hasPassword, false);
  t.setToken(null);
  assert.equal((await t.api('GET', viewPath(c.data))).status, 200);
  t.setToken(token);
});

test('expired and unknown tokens return 404', async () => {
  const c = await t.api('POST', '/api/public-share', { domainId, expiresInDays: 1 });
  t.ctx.db.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), c.data.id);
  assert.equal((await t.api('GET', `/api/public-share/${c.data.id}`)).data.expired, true);
  t.setToken(null);
  const r = await t.api('GET', viewPath(c.data));
  assert.equal(r.status, 404);
  assert.match(r.data, /not available/);
  assert.equal((await t.api('GET', '/api/public-share/view/doesnotexistdoesnotexist')).status, 404);
  assert.equal((await t.api('GET', '/api/public-share/view/bad!')).status, 404);
  t.setToken(token);
  assert.equal((await t.api('GET', `/api/public-share/${c.data.id}`)).data.views, 0);
});

test('validation errors', async () => {
  const bad = async (method, url, body, re) => {
    const r = await t.api(method, url, body);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad('POST', '/api/public-share', {}, /domainId/);
  await bad('POST', '/api/public-share', { domainId: 'x' }, /domainId/);
  await bad('POST', '/api/public-share', { domainId, name: 'x'.repeat(121) }, /name/);
  await bad('POST', '/api/public-share', { domainId, name: 5 }, /name/);
  await bad('POST', '/api/public-share', { domainId, expiresInDays: 0 }, /expiresInDays/);
  await bad('POST', '/api/public-share', { domainId, expiresAt: 'soon' }, /expiresAt/);
  await bad('POST', '/api/public-share', { domainId, expiresAt: '2000-01-01' }, /future/);
  await bad('POST', '/api/public-share', { domainId, password: 'abc' }, /password/);
  const c = await t.api('POST', '/api/public-share', { domainId });
  assert.equal(c.data.expiresAt, null);
  await bad('PATCH', `/api/public-share/${c.data.id}`, {}, /Nothing to update/);
  await bad('GET', '/api/public-share/abc', undefined, /id/);
  await bad('GET', '/api/public-share?domainId=0', undefined, /domainId/);
});

test('links are scoped to the owner and require auth', async () => {
  const mine = await t.api('POST', '/api/public-share', { domainId, name: 'mine' });
  const other = await t.signup();
  const { domainId: otherDomain } = t.seedDomain(other.user.id, 'other.com', ['x']);
  assert.equal((await t.api('GET', '/api/public-share')).data.length, 0);
  assert.equal((await t.api('GET', `/api/public-share/${mine.data.id}`)).status, 404);
  assert.equal((await t.api('PATCH', `/api/public-share/${mine.data.id}`, { name: 'x' })).status, 404);
  assert.equal((await t.api('DELETE', `/api/public-share/${mine.data.id}`)).status, 404);
  assert.equal((await t.api('POST', '/api/public-share', { domainId })).status, 404);
  assert.equal((await t.api('GET', `/api/public-share?domainId=${domainId}`)).status, 404);
  assert.equal((await t.api('POST', '/api/public-share', { domainId: otherDomain })).status, 201);
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/public-share')).status, 401);
  assert.equal((await t.api('POST', '/api/public-share', { domainId })).status, 401);
  t.setToken(token);
  // Deleting the domain removes its links.
  t.ctx.db.prepare('DELETE FROM domains WHERE id = ?').run(otherDomain);
  assert.equal(t.ctx.db.prepare('SELECT COUNT(*) AS n FROM share_links WHERE domain_id = ?').get(otherDomain).n, 0);
});
