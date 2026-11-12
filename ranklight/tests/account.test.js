import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { generateDemoData, DEMO_HOST } from '../server/modules/account.js';

let t;
before(async () => { t = await startTestServer({ modules: ['account'] }); });
after(() => t.close());

const login = async (email, password) => (await t.api('POST', '/api/auth/login', { email, password }));

test('requires auth', async () => {
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/account')).status, 401);
  assert.equal((await t.api('POST', '/api/account/demo')).status, 401);
});

test('profile update validates and enforces unique email', async () => {
  await t.signup('taken@test.dev');
  const { user } = await t.signup('prof@test.dev');
  let r = await t.api('PATCH', '/api/account/profile', { name: '  Ada  ', email: 'ADA@Test.dev' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.user.name, r.data.user.email, r.data.user.id], ['Ada', 'ada@test.dev', user.id]);
  assert.equal(r.data.user.password_hash, undefined);
  assert.equal((await t.api('PATCH', '/api/account/profile', { email: 'nope' })).status, 400);
  assert.equal((await t.api('PATCH', '/api/account/profile', { email: 'taken@test.dev' })).status, 409);
  assert.equal((await t.api('PATCH', '/api/account/profile', {})).status, 400);
  assert.equal((await t.api('PATCH', '/api/account/profile', { name: 'x'.repeat(101) })).status, 400);
  r = await t.api('GET', '/api/account');
  assert.equal(r.data.user.name, 'Ada');
  assert.deepEqual(r.data.stats, { domains: 0, keywords: 0 });
});

test('password change verifies current and revokes other sessions', async () => {
  await t.signup('pw@test.dev');
  const other = (await login('pw@test.dev', 'password123')).data.token;
  assert.equal((await t.api('POST', '/api/account/password', { current: 'wrong', next: 'newpassword1' })).status, 403);
  assert.equal((await t.api('POST', '/api/account/password', { current: 'password123', next: 'short' })).status, 400);
  const r = await t.api('POST', '/api/account/password', { current: 'password123', next: 'newpassword1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.revokedSessions, 1);
  assert.equal((await t.api('GET', '/api/auth/me')).status, 200, 'current session survives');
  const mine = (await t.api('GET', '/api/account/sessions')).data;
  assert.equal(mine.length, 1);
  assert.ok(!other.startsWith(mine[0].prefix), 'other session revoked');
  assert.equal((await login('pw@test.dev', 'password123')).status, 401);
  assert.equal((await login('pw@test.dev', 'newpassword1')).status, 200);
});

test('sessions list and revoke by prefix', async () => {
  await t.signup('sess@test.dev');
  const otherToken = (await login('sess@test.dev', 'password123')).data.token;
  const intruder = await t.signup('intruder@test.dev');
  const intruderToken = intruder.token;
  t.setToken(otherToken);
  let r = await t.api('GET', '/api/account/sessions');
  assert.equal(r.data.length, 2);
  assert.equal(r.data.filter(s => s.current).length, 1);
  assert.ok(r.data.every(s => s.prefix.length === 12 && !('token' in s)));
  const current = r.data.find(s => s.current), target = r.data.find(s => !s.current);
  assert.equal((await t.api('DELETE', `/api/account/sessions/${current.prefix}`)).status, 400);
  assert.equal((await t.api('DELETE', '/api/account/sessions/xyz')).status, 400);
  assert.equal((await t.api('DELETE', `/api/account/sessions/${intruderToken.slice(0, 12)}`)).status, 404, 'cannot revoke another user session');
  assert.equal((await t.api('DELETE', `/api/account/sessions/${target.prefix}`)).status, 200);
  r = await t.api('GET', '/api/account/sessions');
  assert.equal(r.data.length, 1);
  await login('sess@test.dev', 'password123');
  assert.equal((await t.api('DELETE', '/api/account/sessions')).data.revoked, 1);
});

test('demo data: domain, competitors, tags, keywords and 90 days of history', async () => {
  const { user } = await t.signup('demo@test.dev');
  const r = await t.api('POST', '/api/account/demo');
  assert.equal(r.status, 201);
  assert.equal(r.data.keywords, 40);
  assert.equal(r.data.snapshots, 40 * 90);
  const db = t.ctx.db, id = r.data.domainId;
  assert.equal(db.prepare('SELECT user_id, host FROM domains WHERE id = ?').get(id).user_id, user.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM competitors WHERE domain_id = ?').get(id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tags WHERE domain_id = ?').get(id).n, 4);
  const devices = db.prepare('SELECT device, COUNT(*) n FROM keywords WHERE domain_id = ? GROUP BY device').all(id).map(x => [x.device, x.n]);
  assert.deepEqual(devices, [['desktop', 20], ['mobile', 20]]);
  const days = db.prepare(`SELECT COUNT(DISTINCT substr(checked_at,1,10)) n FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ?`).get(id).n;
  assert.equal(days, 90);
  const snaps = db.prepare('SELECT s.* FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ?').all(id);
  const ranked = snaps.filter(s => s.rank != null);
  assert.ok(ranked.length > snaps.length * 0.7, 'most snapshots ranked');
  assert.ok(ranked.every(s => s.rank >= 1 && s.rank <= 100 && s.url.startsWith(`https://${DEMO_HOST}/`)));
  for (const s of ranked.slice(0, 200)) {
    const res = JSON.parse(s.results);
    assert.ok(res.length >= 20);
    assert.equal(res.find(x => x.host === DEMO_HOST)?.position, s.rank);
    assert.equal(new Set(res.map(x => x.position)).size, res.length, 'unique positions');
    assert.ok(Array.isArray(JSON.parse(s.serp_features)));
  }
  assert.ok(snaps.some(s => JSON.parse(s.results).some(x => x.host === 'trailpeak-gear.com')));
  assert.ok(snaps.some(s => JSON.parse(s.results).some(x => x.host === 'summitsupply.co')));

  assert.equal((await t.api('POST', '/api/account/demo')).status, 409);
  const again = await t.api('POST', '/api/account/demo', { replace: true });
  assert.equal(again.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM domains WHERE user_id = ? AND host = ?').get(user.id, DEMO_HOST).n, 1);
  assert.equal((await t.api('GET', '/api/account')).data.demoDomainId, again.data.domainId);
});

test('demo generator is deterministic and emits events', async () => {
  const db = t.ctx.db;
  const mk = email => Number(db.prepare("INSERT INTO users(email, password_hash) VALUES (?, 'x:y')").run(email).lastInsertRowid);
  const now = new Date('2026-01-31T12:00:00Z');
  const a = generateDemoData(db, mk('g1@test.dev'), { now, seed: 7 }), b = generateDemoData(db, mk('g2@test.dev'), { now, seed: 7 });
  const ranks = id => db.prepare('SELECT s.rank FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id WHERE k.domain_id = ? ORDER BY k.id, s.checked_at').all(id).map(x => x.rank);
  assert.deepEqual(ranks(a.domainId), ranks(b.domainId));
  assert.equal(a.checkedAt, '2026-01-31T06:00:00.000Z');

  const seen = [];
  t.ctx.events.once('ranks:updated', p => seen.push(p));
  t.ctx.events.once('domain:created', p => seen.push(p));
  await t.signup('ev@test.dev');
  await t.api('POST', '/api/account/demo');
  assert.equal(seen.length, 2);
  assert.equal(seen.find(p => p.keywordIds).keywordIds.length, 40);
  assert.ok(seen.some(p => p.userId && p.domainId));
});

test('delete account requires password and removes data', async () => {
  const { user } = await t.signup('del@test.dev');
  await t.api('POST', '/api/account/demo');
  assert.equal((await t.api('DELETE', '/api/account', {})).status, 400);
  assert.equal((await t.api('DELETE', '/api/account', { password: 'bad' })).status, 403);
  const r = await t.api('DELETE', '/api/account', { password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal(t.ctx.db.prepare('SELECT COUNT(*) n FROM domains WHERE user_id = ?').get(user.id).n, 0);
  assert.equal((await t.api('GET', '/api/auth/me')).status, 401);
  assert.equal((await login('del@test.dev', 'password123')).status, 401);
});
