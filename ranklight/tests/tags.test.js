import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { compileRules, validateRules, statsFor } from '../server/modules/tags.js';

let t, user, token, domainId, kw;
const snap = (kid, iso, rank, url = null) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url) VALUES (?,?,?,?)').run(kid, iso, rank, url);
const q = (path = '', d = domainId) => `/api/tags${path}?domainId=${d}`;
const members = tagId => t.ctx.db.prepare('SELECT keyword_id FROM keyword_tags WHERE tag_id = ? ORDER BY keyword_id').all(tagId).map(r => r.keyword_id);

before(async () => {
  t = await startTestServer({ modules: ['tags'] });
  ({ user, token } = await t.signup());
  const seeded = t.seedDomain(user.id, 'example.com', ['buy running shoes', 'running tips', 'best trail shoes', 'yoga mats']);
  domainId = seeded.domainId;
  kw = Object.fromEntries(['shoes', 'tips', 'trail', 'yoga'].map((k, i) => [k, seeded.keywordIds[i]]));
  const db = t.ctx.db;
  db.prepare("UPDATE keywords SET device = 'mobile', search_volume = 5000 WHERE id = ?").run(kw.shoes);
  db.prepare('UPDATE keywords SET search_volume = 800 WHERE id = ?').run(kw.tips);
  db.prepare("UPDATE keywords SET location = 'Denver' WHERE id = ?").run(kw.trail);
  snap(kw.shoes, '2026-01-01T00:00:00Z', 40);
  snap(kw.shoes, '2026-02-01T00:00:00Z', 2, 'https://example.com/shop/shoes');
  snap(kw.tips, '2026-02-01T00:00:00Z', 15, 'https://example.com/blog/tips');
  snap(kw.trail, '2026-02-01T00:00:00Z', 8, 'https://example.com/shop/trail');
  // yoga: never ranked
});
after(() => t.close());

test('rule validation and matching (pure)', () => {
  assert.throws(() => validateRules([]), /non-empty/);
  assert.throws(() => validateRules([{ field: 'title', op: 'contains', value: 'x' }]), /Rule 1: field/);
  assert.throws(() => validateRules([{ field: 'rank', op: 'contains', value: 'x' }]), /op for rank/);
  assert.throws(() => validateRules([{ field: 'rank', op: 'lt', value: 'abc' }]), /number/);
  assert.throws(() => validateRules([{ field: 'phrase', op: 'regex', value: '(' }]), /regular expression/);
  assert.throws(() => validateRules([{ field: 'phrase', op: 'contains', value: 'x' }], 'some'), /match/);
  assert.deepEqual(validateRules([{ field: 'rank', op: 'lt', value: '11' }]).rules, [{ field: 'rank', op: 'lt', value: 11 }]);

  const k = { phrase: 'Buy Running Shoes', url: null, device: 'mobile', location: '', rank: null, search_volume: null };
  assert.equal(compileRules([{ field: 'phrase', op: 'contains', value: 'running' }])(k), true);
  assert.equal(compileRules([{ field: 'phrase', op: 'starts_with', value: 'buy' }])(k), true);
  assert.equal(compileRules([{ field: 'phrase', op: 'regex', value: '^buy\\s' }])(k), true);
  assert.equal(compileRules([{ field: 'url', op: 'not_contains', value: '/blog' }])(k), true);
  assert.equal(compileRules([{ field: 'location', op: 'equals', value: '' }])(k), true);
  assert.equal(compileRules([{ field: 'rank', op: 'lt', value: 11 }])(k), false, 'unranked is not in top 10');
  assert.equal(compileRules([{ field: 'rank', op: 'gt', value: 10 }])(k), true, 'unranked counts as beyond 10');
  assert.equal(compileRules([{ field: 'search_volume', op: 'gt', value: 0 }])(k), false, 'unknown volume never matches');
  const both = [{ field: 'device', op: 'equals', value: 'desktop' }, { field: 'phrase', op: 'contains', value: 'shoes' }];
  assert.equal(compileRules(both, 'all')(k), false);
  assert.equal(compileRules(both, 'any')(k), true);

  const s = statsFor([{ rank: 1 }, { rank: 9 }, { rank: 30 }, { rank: null, search_volume: 10 }]);
  assert.deepEqual({ count: s.count, ranked: s.ranked, avgRank: s.avgRank, top3: s.top3, top10: s.top10, sv: s.searchVolume },
    { count: 4, ranked: 3, avgRank: 13.3, top3: 1, top10: 2, sv: 10 });
  assert.equal(s.distribution['21-50'], 1);
});

test('auth, validation and ownership', async () => {
  t.setToken(null);
  assert.equal((await t.api('GET', q())).status, 401);
  t.setToken(token);
  assert.equal((await t.api('GET', '/api/tags')).status, 400);
  assert.equal((await t.api('GET', '/api/tags?domainId=x')).status, 400);
  assert.equal((await t.api('GET', q('', 9999))).status, 404);
  assert.equal((await t.api('POST', q(), {})).status, 400);
  assert.equal((await t.api('POST', q(), { name: 'x'.repeat(51) })).status, 400);
  assert.equal((await t.api('POST', q(), { name: 'ok', color: 'red' })).status, 400);
  assert.equal((await t.api('GET', '/api/tags/abc')).status, 400);

  const other = t.ctx.db.prepare("INSERT INTO users(email, password_hash) VALUES ('tags-other@x.dev','x')").run();
  const od = Number(t.ctx.db.prepare("INSERT INTO domains(user_id, host) VALUES (?, 'theirs.com')").run(other.lastInsertRowid).lastInsertRowid);
  const ot = Number(t.ctx.db.prepare("INSERT INTO tags(domain_id, name) VALUES (?, 'secret')").run(od).lastInsertRowid);
  assert.equal((await t.api('GET', q('', od))).status, 404);
  assert.equal((await t.api('POST', q('', od), { name: 'mine' })).status, 404);
  for (const [m, p, b] of [['GET', ''], ['PATCH', '', { name: 'x' }], ['DELETE', ''], ['GET', '/stats'], ['POST', '/rules', { rules: [{ field: 'phrase', op: 'contains', value: 'a' }] }]]) {
    assert.equal((await t.api(m, `/api/tags/${ot}${p}`, b)).status, 404, `${m} ${p}`);
  }
  assert.ok(t.ctx.db.prepare('SELECT 1 FROM tags WHERE id = ?').get(ot), 'foreign tag untouched');
});

test('static tag CRUD with counts and stats', async () => {
  const c = await t.api('POST', q(), { name: '  Brand  ', color: '#AA00ff' });
  assert.equal(c.status, 201);
  assert.equal(c.data.name, 'Brand');
  assert.equal(c.data.color, '#aa00ff');
  assert.equal(c.data.dynamic, false);
  assert.equal((await t.api('POST', q(), { name: 'brand' })).status, 409);
  const def = await t.api('POST', q(), { name: 'Plain' });
  assert.equal(def.data.color, '#6b7280');

  const db = t.ctx.db;
  for (const k of [kw.shoes, kw.tips, kw.yoga]) db.prepare('INSERT INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(k, c.data.id);
  const list = await t.api('GET', q());
  assert.equal(list.status, 200);
  const brand = list.data.find(x => x.id === c.data.id);
  assert.deepEqual([brand.keywordCount, brand.avgRank, brand.top10], [3, 8.5, 1]);

  const st = await t.api('GET', `/api/tags/${c.data.id}/stats`);
  assert.equal(st.status, 200);
  assert.deepEqual([st.data.count, st.data.ranked, st.data.unranked, st.data.avgRank, st.data.top3, st.data.top10, st.data.searchVolume], [3, 2, 1, 8.5, 1, 1, 5800]);

  const one = await t.api('GET', `/api/tags/${c.data.id}`);
  assert.deepEqual(one.data.keywords.map(k => k.id), [kw.shoes, kw.tips, kw.yoga], 'sorted by rank, unranked last');

  assert.equal((await t.api('PATCH', `/api/tags/${c.data.id}`, {})).status, 400);
  assert.equal((await t.api('PATCH', `/api/tags/${c.data.id}`, { name: 'plain' })).status, 409);
  const p = await t.api('PATCH', `/api/tags/${c.data.id}`, { name: 'Brand terms', color: '#123456' });
  assert.equal(p.status, 200);
  assert.deepEqual([p.data.name, p.data.color, p.data.keywordCount], ['Brand terms', '#123456', 3]);

  assert.equal((await t.api('DELETE', `/api/tags/${def.data.id}`)).status, 200);
  assert.equal((await t.api('GET', `/api/tags/${def.data.id}`)).status, 404);
  assert.equal((await t.api('DELETE', `/api/tags/${c.data.id}`)).status, 200);
  assert.deepEqual(members(c.data.id), []);
});

test('dynamic rules: save, apply, preview, removal and re-application', async () => {
  const applied = [];
  t.ctx.events.on('tags:applied', e => applied.push(e));
  const tag = (await t.api('POST', q(), { name: 'Shop top 10', color: '#2f5bea' })).data;
  assert.equal((await t.api('POST', `/api/tags/${tag.id}/rules`, { rules: [] })).status, 400);
  assert.equal((await t.api('POST', `/api/tags/${tag.id}/rules`, { rules: [{ field: 'url', op: 'nope', value: 'x' }] })).status, 400);

  // A manual (non-matching) member must be removed once the tag becomes dynamic.
  t.ctx.db.prepare('INSERT INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(kw.yoga, tag.id);
  const rules = [{ field: 'url', op: 'contains', value: '/shop/' }, { field: 'rank', op: 'lt', value: 11 }];
  const prev = await t.api('POST', q('/preview'), { rules, match: 'all' });
  assert.equal(prev.status, 200);
  assert.deepEqual(prev.data.keywords.map(k => k.id).sort(), [kw.shoes, kw.trail].sort());

  const res = await t.api('POST', `/api/tags/${tag.id}/rules`, { rules, match: 'all' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.added, res.data.removed], [2, 1]);
  assert.equal(res.data.tag.dynamic, true);
  assert.deepEqual(res.data.tag.rules, rules);
  assert.equal(res.data.tag.keywordCount, 2);
  assert.ok(res.data.tag.appliedAt);
  assert.deepEqual(members(tag.id), [kw.shoes, kw.trail].sort((a, b) => a - b));
  assert.deepEqual(applied.at(-1), { domainId, added: 2, removed: 1 });

  // Creating a tag with rules applies immediately; 'any' semantics.
  const any = await t.api('POST', q(), { name: 'Mobile or Denver', rules: [{ field: 'device', op: 'equals', value: 'mobile' }, { field: 'location', op: 'equals', value: 'denver' }], match: 'any' });
  assert.equal(any.status, 201);
  assert.deepEqual(members(any.data.id), [kw.shoes, kw.trail].sort((a, b) => a - b));

  // ranks:updated: trail drops out of top 10 -> removed from dynamic tag.
  snap(kw.trail, '2026-03-01T00:00:00Z', 25, 'https://example.com/shop/trail');
  t.ctx.events.emit('ranks:updated', { domainId, keywordIds: [kw.trail], checkedAt: '2026-03-01T00:00:00Z' });
  assert.deepEqual(members(tag.id), [kw.shoes]);

  // keywords:added: new matching keyword joins.
  const nk = Number(t.ctx.db.prepare("INSERT INTO keywords(domain_id, phrase, device) VALUES (?, 'new shoe', 'mobile')").run(domainId).lastInsertRowid);
  t.ctx.events.emit('keywords:added', { domainId, keywordIds: [nk] });
  assert.ok(members(any.data.id).includes(nk));

  // Manual apply is idempotent.
  const ap = await t.api('POST', q('/apply'));
  assert.equal(ap.status, 200);
  assert.deepEqual([ap.data.added, ap.data.removed], [0, 0]);
  assert.equal(ap.data.tags.length, 2);

  // Removing rules makes the tag static and keeps its members.
  const st = await t.api('DELETE', `/api/tags/${tag.id}/rules`);
  assert.equal(st.data.dynamic, false);
  assert.deepEqual(members(tag.id), [kw.shoes]);
  t.ctx.db.prepare('INSERT INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(kw.yoga, tag.id);
  await t.api('POST', q('/apply'));
  assert.ok(members(tag.id).includes(kw.yoga), 'static tags are not touched by apply');
});
