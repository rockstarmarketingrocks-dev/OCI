import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { checkRule, evaluateAlerts } from '../server/modules/alerts.js';

let t, user, token, domainId, kw;
const snap = (keywordId, checkedAt, rank, url = null, owned = []) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, owned_features) VALUES (?,?,?,?,?)')
    .run(keywordId, checkedAt, rank, url, JSON.stringify(owned));

before(async () => {
  t = await startTestServer({ modules: ['alerts'] });
  ({ user, token } = await t.signup());
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker', 'serp api']));
});
after(() => t.close());

test('checkRule covers each rule type', () => {
  const r = (type, threshold = null) => ({ type, threshold });
  const p = { rank: 4, url: 'https://example.com/a', owned_features: '["featured_snippet","sitelinks"]' };
  const c = { rank: 12, url: 'https://example.com/b', owned_features: '["sitelinks"]' };
  assert.match(checkRule(r('rank_drop', 3), 'kw', p, c).message, /dropped 8 positions \(#4 to #12\)/);
  assert.equal(checkRule(r('rank_drop', 9), 'kw', p, c), null);
  assert.equal(checkRule(r('rank_gain', 1), 'kw', p, c), null);
  assert.match(checkRule(r('rank_gain', 1), 'kw', c, p).message, /gained 8/);
  assert.match(checkRule(r('leaves_top', 10), 'kw', p, c).message, /left the top 10/);
  assert.match(checkRule(r('enters_top', 10), 'kw', c, p).message, /entered the top 10/);
  assert.equal(checkRule(r('enters_top', 3), 'kw', c, p), null);
  assert.match(checkRule(r('url_change'), 'kw', p, c).message, /changed from https:\/\/example.com\/a to https:\/\/example.com\/b/);
  const lost = checkRule(r('feature_lost'), 'kw', p, c);
  assert.deepEqual(lost.details.features, ['featured_snippet']);
  // Dropping out of the top 100 counts as falling to 101.
  assert.match(checkRule(r('rank_drop', 5), 'kw', { rank: 90 }, { rank: null }).message, /#90 to not ranked/);
});

test('rules CRUD with validation and defaults', async () => {
  const a = await t.api('POST', '/api/alerts/rules', { name: ' Big drops ', type: 'rank_drop', domainId });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.deepEqual({ ...a.data, id: 0, createdAt: 0 }, { id: 0, name: 'Big drops', type: 'rank_drop', threshold: 3, domainId, tagId: null, channels: ['inapp'], enabled: true, createdAt: 0 });

  const b = await t.api('POST', '/api/alerts/rules', { name: 'URL', type: 'url_change', threshold: 7, channels: ['inapp', 'webhook', 'webhook'] });
  assert.equal(b.data.threshold, null);
  assert.equal(b.data.domainId, null);
  assert.deepEqual(b.data.channels, ['inapp', 'webhook']);

  assert.equal((await t.api('GET', '/api/alerts/rules')).data.length, 2);
  assert.equal((await t.api('GET', `/api/alerts/rules?domainId=${domainId}`)).data.length, 2);
  assert.equal((await t.api('GET', `/api/alerts/rules/${a.data.id}`)).data.name, 'Big drops');

  const up = await t.api('PATCH', `/api/alerts/rules/${a.data.id}`, { threshold: 5, enabled: false });
  assert.equal(up.data.threshold, 5);
  assert.equal(up.data.enabled, false);
  const sw = await t.api('PATCH', `/api/alerts/rules/${a.data.id}`, { type: 'enters_top' });
  assert.equal(sw.data.threshold, 10);

  const bad = async (method, url, body, re) => {
    const r = await t.api(method, url, body);
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad('POST', '/api/alerts/rules', { type: 'rank_drop' }, /name/);
  await bad('POST', '/api/alerts/rules', { name: 'x', type: 'nope' }, /type must be/);
  await bad('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', threshold: 0 }, /threshold/);
  await bad('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', channels: ['sms'] }, /channels/);
  await bad('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', channels: [] }, /channels/);
  await bad('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', tagId: 1 }, /requires a domainId/);
  await bad('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', domainId, tagId: 999 }, /tagId/);
  await bad('PATCH', `/api/alerts/rules/${a.data.id}`, {}, /Nothing to update/);
  await bad('PATCH', `/api/alerts/rules/${a.data.id}`, { enabled: 'yes' }, /enabled/);
  await bad('GET', '/api/alerts/rules/abc', undefined, /id/);
  assert.equal((await t.api('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', domainId: 99999 })).status, 404);

  assert.deepEqual((await t.api('DELETE', `/api/alerts/rules/${a.data.id}`)).data, { ok: true });
  assert.deepEqual((await t.api('DELETE', `/api/alerts/rules/${b.data.id}`)).data, { ok: true });
  assert.equal((await t.api('GET', `/api/alerts/rules/${a.data.id}`)).status, 404);
});

test('ranks:updated evaluates rules, emits webhook events, feed + mark read', async () => {
  const db = t.ctx.db;
  const tag = Number(db.prepare('INSERT INTO tags(domain_id, name) VALUES (?,?)').run(domainId, 'money').lastInsertRowid);
  db.prepare('INSERT INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(kw[1], tag);
  const drop = (await t.api('POST', '/api/alerts/rules', { name: 'Drops', type: 'rank_drop', threshold: 3, domainId, channels: ['inapp', 'webhook'] })).data;
  const tagged = (await t.api('POST', '/api/alerts/rules', { name: 'Money gains', type: 'rank_gain', threshold: 1, domainId, tagId: tag })).data;
  await t.api('POST', '/api/alerts/rules', { name: 'Features', type: 'feature_lost' });
  await t.api('POST', '/api/alerts/rules', { name: 'Off', type: 'url_change', enabled: false });

  snap(kw[0], '2026-11-01T06:00:00Z', 3, 'https://example.com/a', ['featured_snippet']);
  snap(kw[0], '2026-11-02T06:00:00Z', 9, 'https://example.com/b', []);
  snap(kw[1], '2026-11-01T06:00:00Z', 20);
  snap(kw[1], '2026-11-02T06:00:00Z', 15);
  snap(kw[2], '2026-11-01T06:00:00Z', 15);
  snap(kw[2], '2026-11-02T06:00:00Z', 5); // gain, but not tagged

  const fired = [];
  t.ctx.events.on('alert:triggered', e => fired.push(e));
  t.ctx.events.emit('ranks:updated', { domainId, keywordIds: kw, checkedAt: '2026-11-02T06:00:00Z' });
  t.ctx.events.emit('ranks:updated', { domainId, keywordIds: kw, checkedAt: '2026-11-02T06:00:00Z' }); // no duplicates

  const feed = await t.api('GET', '/api/alerts/notifications');
  assert.equal(feed.status, 200);
  assert.equal(feed.data.unreadCount, 3);
  const byRule = Object.fromEntries(feed.data.items.map(n => [n.ruleId ?? 'x', n]));
  assert.match(byRule[drop.id].message, /"seo tool" dropped 6 positions/);
  assert.equal(byRule[drop.id].keyword, 'seo tool');
  assert.deepEqual(byRule[drop.id].details, { prevRank: 3, rank: 9, prevUrl: 'https://example.com/a', url: 'https://example.com/b' });
  assert.equal(byRule[tagged.id].keywordId, kw[1]);
  assert.ok(feed.data.items.some(n => n.type === 'feature_lost' && n.keywordId === kw[0]));
  assert.ok(!feed.data.items.some(n => n.type === 'url_change'));

  assert.equal(fired.length, 1);
  assert.equal(fired[0].notification.id, byRule[drop.id].id);
  assert.equal(fired[0].userId, user.id);

  const r1 = await t.api('POST', '/api/alerts/notifications/read', { ids: [byRule[drop.id].id] });
  assert.deepEqual(r1.data, { updated: 1, unreadCount: 2 });
  assert.equal((await t.api('GET', '/api/alerts/notifications?unread=1')).data.items.length, 2);
  assert.equal((await t.api('GET', `/api/alerts/notifications?domainId=${domainId}&limit=1`)).data.items.length, 1);
  assert.deepEqual((await t.api('POST', '/api/alerts/notifications/read', { all: true })).data, { updated: 2, unreadCount: 0 });
  assert.equal((await t.api('POST', '/api/alerts/notifications/read', {})).status, 400);
  assert.equal((await t.api('POST', '/api/alerts/notifications/read', { ids: ['x'] })).status, 400);
  assert.equal((await t.api('GET', '/api/alerts/notifications?limit=0')).status, 400);

  // Re-evaluating the same snapshots (all keywords) inserts nothing new.
  assert.deepEqual(evaluateAlerts(db, t.ctx.events, { domainId, keywordIds: [] }), []);
});

test('alerts are scoped to the owner', async () => {
  const mine = (await t.api('POST', '/api/alerts/rules', { name: 'Mine', type: 'rank_drop' })).data;
  const other = await t.signup();
  const { domainId: otherDomain, keywordIds: [ok] } = t.seedDomain(other.user.id, 'other.com', ['x']);
  assert.equal((await t.api('GET', `/api/alerts/rules/${mine.id}`)).status, 404);
  assert.equal((await t.api('PATCH', `/api/alerts/rules/${mine.id}`, { name: 'hacked' })).status, 404);
  assert.equal((await t.api('DELETE', `/api/alerts/rules/${mine.id}`)).status, 404);
  assert.equal((await t.api('POST', '/api/alerts/rules', { name: 'x', type: 'rank_drop', domainId })).status, 404);
  assert.deepEqual((await t.api('GET', '/api/alerts/rules')).data, []);
  const feed = await t.api('GET', '/api/alerts/notifications');
  assert.deepEqual(feed.data, { items: [], unreadCount: 0 });
  assert.deepEqual((await t.api('POST', '/api/alerts/notifications/read', { all: true })).data, { updated: 0, unreadCount: 0 });

  // The other user's ranks drop: first user's global rule must not fire on it.
  snap(ok, '2026-11-01T00:00:00Z', 1); snap(ok, '2026-11-02T00:00:00Z', 50);
  t.ctx.events.emit('ranks:updated', { domainId: otherDomain, keywordIds: [ok] });
  t.setToken(token);
  assert.ok(!(await t.api('GET', '/api/alerts/notifications')).data.items.some(n => n.domainId === otherDomain));
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/alerts/rules')).status, 401);
  t.setToken(token);
});
