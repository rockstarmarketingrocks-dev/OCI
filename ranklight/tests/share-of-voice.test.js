import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { CTR_CURVE } from '../server/lib/metrics.js';

let t, user, domainId, keywordIds;
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();
const isoDay = n => daysAgo(n).slice(0, 10);
const results = map => JSON.stringify(Object.entries(map).map(([host, position]) => ({ position, host, url: `https://${host}/p`, title: host, type: 'organic' })));
const snap = (kid, n, rank, serp) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, results) VALUES (?,?,?,?)').run(kid, daysAgo(n), rank, results(serp));
const pct = (num, den) => Math.round(num / den * 100 * 100) / 100;

before(async () => {
  t = await startTestServer({ modules: ['share-of-voice'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds } = t.seedDomain(user.id, 'example.com', ['alpha', 'beta', 'gamma']));
  const [a, b, c] = keywordIds;
  const db = t.ctx.db;
  db.prepare('UPDATE keywords SET search_volume = ? WHERE id = ?').run(1000, a);
  db.prepare('UPDATE keywords SET search_volume = ? WHERE id = ?').run(3000, b);
  db.prepare('UPDATE keywords SET search_volume = ? WHERE id = ?').run(500, c); // never checked
  db.prepare("INSERT INTO competitors(domain_id, host) VALUES (?, 'rival.com')").run(domainId);
  const tag = Number(db.prepare("INSERT INTO tags(domain_id, name) VALUES (?, 'Brand')").run(domainId).lastInsertRowid);
  db.prepare('INSERT INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(a, tag);
  // 40 days ago (baseline): alpha you #3 rival #1; beta you #10 rival #2
  snap(a, 40, 3, { 'example.com': 3, 'www.rival.com': 1, 'other.org': 2 });
  snap(b, 40, 10, { 'example.com': 10, 'rival.com': 2, 'blog.rival.com': 5 });
  // 5 days ago: alpha you #1, rival #2
  snap(a, 5, 1, { 'example.com': 1, 'rival.com': 2, 'other.org': 3 });
  // 1 day ago: beta you #2, rival gone
  snap(b, 1, 2, { 'other.org': 1, 'example.com': 2 });
});
after(() => t.close());

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/share-of-voice?domainId=${domainId}`)).status, 401);
  t.setToken(token);
});

test('validates input and scopes to owner', async () => {
  assert.equal((await t.api('GET', '/api/share-of-voice')).status, 400);
  assert.equal((await t.api('GET', '/api/share-of-voice?domainId=x')).status, 400);
  assert.equal((await t.api('GET', `/api/share-of-voice?domainId=${domainId}&days=0`)).status, 400);
  assert.equal((await t.api('GET', `/api/share-of-voice?domainId=${domainId}&tag=a&tag=b`)).status, 400);
  assert.equal((await t.api('GET', `/api/share-of-voice?domainId=${domainId}&tag=nope`)).status, 404);
  assert.equal((await t.api('GET', '/api/share-of-voice?domainId=999999')).status, 404);
  const other = t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('sov-other@x.dev','x')").run();
  const od = t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'other.com')").run(other.lastInsertRowid);
  assert.equal((await t.api('GET', `/api/share-of-voice?domainId=${od.lastInsertRowid}`)).status, 404);
});

test('computes current SoV for you and configured competitors', async () => {
  const { status, data } = await t.api('GET', `/api/share-of-voice?domainId=${domainId}&days=30`);
  assert.equal(status, 200);
  const max = 4000 * CTR_CURVE[1]; // gamma never checked -> excluded
  assert.equal(data.discovered, false);
  assert.equal(data.current.you, pct(1000 * CTR_CURVE[1] + 3000 * CTR_CURVE[2], max));
  // rival: alpha #2, beta absent now
  assert.deepEqual(data.current.competitors, [{ host: 'rival.com', sov: pct(1000 * CTR_CURVE[2], max) }]);
});

test('history carries ranks forward per day from the baseline', async () => {
  const { data } = await t.api('GET', `/api/share-of-voice?domainId=${domainId}&days=30`);
  const max = 4000 * CTR_CURVE[1];
  assert.deepEqual(data.history.map(h => h.date), [isoDay(30), isoDay(5), isoDay(1)]);
  assert.deepEqual(data.history[0], { date: isoDay(30), you: pct(1000 * CTR_CURVE[3] + 3000 * CTR_CURVE[10], max), 'rival.com': pct(1000 * CTR_CURVE[1] + 3000 * CTR_CURVE[2], max) });
  assert.equal(data.history[1].you, pct(1000 * CTR_CURVE[1] + 3000 * CTR_CURVE[10], max));
  assert.equal(data.history[2].you, data.current.you);
});

test('tag filter and tag breakdown', async () => {
  const { data } = await t.api('GET', `/api/share-of-voice?domainId=${domainId}&tag=brand`);
  assert.equal(data.current.you, 100);
  assert.equal(data.current.competitors[0].sov, pct(CTR_CURVE[2], CTR_CURVE[1]));
  assert.deepEqual(data.byTag, [{ tag: 'Brand', keywords: 1, sov: 100 }]);
});

test('discovers competitors when none are configured', async () => {
  const { domainId: d2, keywordIds: [k] } = t.seedDomain(user.id, 'mine.io', ['solo']);
  t.ctx.db.prepare('UPDATE keywords SET search_volume = 100 WHERE id = ?').run(k);
  snap(k, 2, 3, { 'a.com': 1, 'b.com': 2, 'mine.io': 3, 'sub.mine.io': 4 });
  const { data } = await t.api('GET', `/api/share-of-voice?domainId=${d2}&days=7`);
  assert.equal(data.discovered, true);
  assert.deepEqual(data.current.competitors.map(c => c.host), ['a.com', 'b.com']);
  assert.equal(data.current.competitors[0].sov, 100);
  assert.equal(data.history.length, 1);
});

test('empty domain returns zeros', async () => {
  const { domainId: d3 } = t.seedDomain(user.id, 'empty.dev', []);
  const { status, data } = await t.api('GET', `/api/share-of-voice?domainId=${d3}`);
  assert.equal(status, 200);
  assert.deepEqual(data.current, { you: 0, competitors: [] });
  assert.deepEqual(data.history, []);
  assert.deepEqual(data.byTag, []);
});
