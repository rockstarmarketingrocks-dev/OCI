import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { PLANS, checkKeywordQuota, checkDomainQuota } from '../server/modules/billing.js';

let t, user, domainId, kw;

before(async () => {
  t = await startTestServer({ modules: ['billing'] });
  ({ user } = await t.signup());
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker', 'serp api']));
  const ins = t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank) VALUES (?,?,?)');
  const now = new Date().toISOString();
  ins.run(kw[0], now, 3); ins.run(kw[1], now, 9);
  ins.run(kw[0], '2020-01-15T00:00:00Z', 5); // previous month, not counted
});
after(() => t.close());

test('PLANS exposes the four tiers with limits', () => {
  assert.deepEqual(Object.keys(PLANS), ['starter', 'pro', 'agency', 'enterprise']);
  assert.deepEqual(Object.values(PLANS).map(p => p.keywords), [1000, 5000, 20000, 100000]);
  for (const p of Object.values(PLANS)) { assert.ok(p.domains > 0); assert.ok(p.refreshHours > 0); }
});

test('requires auth', async () => {
  const anon = await fetch(`${t.base}/api/billing`);
  assert.equal(anon.status, 401);
});

test('GET /api/billing reports default plan and usage', async () => {
  const r = await t.api('GET', '/api/billing');
  assert.equal(r.status, 200);
  assert.equal(r.data.plan.id, 'starter');
  assert.equal(r.data.status, 'trial');
  assert.equal(r.data.usage.keywords, 3);
  assert.equal(r.data.usage.domains, 1);
  assert.equal(r.data.usage.snapshotsThisMonth, 2);
  assert.equal(r.data.usage.percent, 0.3);
  assert.equal(r.data.usage.keywordLimit, 1000);
  assert.equal(r.data.plans.length, 4);
});

test('quota endpoint and helper', async () => {
  let r = await t.api('GET', '/api/billing/quota?adding=10');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.remaining, 997);
  r = await t.api('GET', '/api/billing/quota?adding=998');
  assert.equal(r.data.ok, false);
  assert.equal((await t.api('GET', '/api/billing/quota?adding=-1')).status, 400);
  assert.equal((await t.api('GET', '/api/billing/quota?adding=abc')).status, 400);
  assert.deepEqual(
    (({ ok, remaining }) => ({ ok, remaining }))(checkKeywordQuota(t.ctx.db, user.id, 997)),
    { ok: true, remaining: 997 });
  assert.equal(checkDomainQuota(t.ctx.db, user.id, 4).ok, true);
  assert.equal(checkDomainQuota(t.ctx.db, user.id, 5).ok, false);
});

test('switch plan, emit event, validate input, block downgrade below usage', async () => {
  const seen = [];
  t.ctx.events.on('billing:plan-changed', e => seen.push(e));
  assert.equal((await t.api('POST', '/api/billing/plan', { plan: 'platinum' })).status, 400);
  assert.equal((await t.api('POST', '/api/billing/plan', {})).status, 400);

  const r = await t.api('POST', '/api/billing/plan', { plan: 'Pro' });
  assert.equal(r.status, 200);
  assert.equal(r.data.plan.id, 'pro');
  assert.equal(r.data.status, 'active');
  assert.ok(Date.parse(r.data.renewsAt) > Date.now());
  assert.deepEqual(seen, [{ userId: user.id, plan: 'pro', previous: 'starter' }]);
  assert.equal(checkKeywordQuota(t.ctx.db, user.id, 4997).ok, true);

  // Exceed starter's domain limit, then try to downgrade.
  for (let i = 0; i < 6; i++) t.ctx.db.prepare('INSERT INTO domains(user_id, host) VALUES (?,?)').run(user.id, `d${i}.com`);
  const down = await t.api('POST', '/api/billing/plan', { plan: 'starter' });
  assert.equal(down.status, 409);
  assert.match(down.data.error, /exceeds the Starter plan/);
  assert.equal((await t.api('GET', '/api/billing')).data.plan.id, 'pro');
});

test('usage is scoped to the current user', async () => {
  await t.signup();
  const r = await t.api('GET', '/api/billing');
  assert.equal(r.data.usage.keywords, 0);
  assert.equal(r.data.usage.domains, 0);
  assert.equal(r.data.usage.snapshotsThisMonth, 0);
  assert.equal(r.data.plan.id, 'starter');
  assert.ok(domainId);
});
