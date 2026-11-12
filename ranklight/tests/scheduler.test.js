import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startTestServer } from './helpers.js';
import { refreshKeywords, runDue, analyzeSerp } from '../server/modules/scheduler.js';

process.env.RL_DISABLE_SCHEDULER = '1';

// Deterministic fake provider: example.com ranks 3 (plus owns a featured snippet at 1 for "seo tool"),
// "rank tracker" never ranks; records every call.
function fakeProvider({ fail = new Set() } = {}) {
  const calls = [], volumeCalls = [];
  return {
    calls, volumeCalls,
    async fetchSerp(opts) {
      calls.push(opts);
      if (fail.has(opts.phrase)) throw new Error('quota exceeded');
      const results = Array.from({ length: 10 }, (_, i) => ({ position: i + 1, url: `https://site${i + 1}.org/x`, host: `site${i + 1}.org`, title: 't', type: 'organic' }));
      if (opts.phrase === 'seo tool') {
        results[0] = { position: 1, url: 'https://blog.example.com/snippet', host: 'blog.example.com', title: 's', type: 'featured_snippet' };
        results[2] = { position: 3, url: 'https://www.example.com/seo', host: 'www.example.com', title: 'o', type: 'organic' };
      }
      return { results, features: ['featured_snippet', 'people_also_ask'], totalResults: 1000 };
    },
    async fetchVolume(phrases) {
      volumeCalls.push(phrases);
      return Object.fromEntries(phrases.map(p => [p, { volume: 1234, cpc: 2.5, competition: 0.4, trend: [] }]));
    },
  };
}

async function setup(provider = fakeProvider()) {
  const s = await startTestServer({ modules: ['scheduler'] });
  const { user } = await s.signup();
  const seeded = s.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker']);
  s.ctx.provider = provider;
  return { s, user, provider, ...seeded };
}
const snaps = (db, kw) => db.prepare('SELECT * FROM rank_snapshots WHERE keyword_id = ? ORDER BY checked_at').all(kw);

test('analyzeSerp: best matching position, owned features, fold heuristic', () => {
  const serp = { results: [
    { position: 1, url: 'https://a.org', host: 'a.org', type: 'organic' },
    { position: 2, url: 'https://shop.example.com/p', host: 'shop.example.com', type: 'local_pack' },
    { position: 40, url: 'https://example.com/z', host: 'example.com', type: 'organic' },
  ], features: ['local_pack'] };
  const a = analyzeSerp(serp, { host: 'example.com' });
  assert.equal(a.rank, 2);
  assert.deepEqual(a.owned, ['local_pack']);
  assert.equal(a.aboveFold, 1);
  assert.equal(analyzeSerp(serp, { host: 'example.com', ignoreLocalPack: true }).rank, 40);
  assert.equal(analyzeSerp(serp, { host: 'example.com', ignoreLocalPack: true }).aboveFold, 0);
  assert.equal(analyzeSerp(serp, { host: 'example.com', includeSubdomains: false }).rank, 40);
  const none = analyzeSerp({ results: [] }, { host: 'example.com' });
  assert.equal(none.rank, null); assert.equal(none.aboveFold, null);
});

test('refreshKeywords stores snapshots, fills volume, emits ranks:updated, skips without provider', async () => {
  const { s, domainId, keywordIds: [a, b] } = await setup();
  try {
    const ev = once(s.ctx.events, 'ranks:updated');
    const r = await refreshKeywords(s.ctx, [a, b]);
    assert.equal(r.checked, 2);
    const [payload] = await ev;
    assert.equal(payload.domainId, domainId);
    assert.deepEqual(payload.keywordIds.sort(), [a, b].sort());
    const [sa] = snaps(s.ctx.db, a), [sb] = snaps(s.ctx.db, b);
    assert.equal(sa.rank, 1);                      // featured snippet on a subdomain counts as best position
    assert.equal(sa.url, 'https://blog.example.com/snippet');
    assert.deepEqual(JSON.parse(sa.owned_features), ['featured_snippet']);
    assert.deepEqual(JSON.parse(sa.serp_features), ['featured_snippet', 'people_also_ask']);
    assert.equal(JSON.parse(sa.results).length, 10);
    assert.equal(sa.above_the_fold, 1);
    assert.equal(sb.rank, null); assert.equal(sb.above_the_fold, null);
    assert.equal(s.ctx.db.prepare('SELECT search_volume FROM keywords WHERE id = ?').get(a).search_volume, 1234);

    // same-day refresh replaces the snapshot; volume is not fetched again
    await refreshKeywords(s.ctx, [a]);
    assert.equal(snaps(s.ctx.db, a).length, 1);
    assert.equal(s.ctx.provider.volumeCalls.length, 1);

    s.ctx.provider = null;
    const skipped = await refreshKeywords(s.ctx, [a, b]);
    assert.equal(skipped.skipped, 2); assert.equal(skipped.checked, 0); assert.ok(skipped.reason);
  } finally { s.close(); }
});

test('provider errors are recorded per keyword, not thrown', async () => {
  const { s, keywordIds: [a, b] } = await setup(fakeProvider({ fail: new Set(['rank tracker']) }));
  try {
    const r = await refreshKeywords(s.ctx, [a, b]);
    assert.equal(r.checked, 1); assert.equal(r.failed, 1);
    assert.equal(r.errors[0].keywordId, b);
  } finally { s.close(); }
});

test('POST /refresh validates, scopes to user and returns results; status shows last run', async () => {
  const { s, domainId, keywordIds: [a] } = await setup();
  try {
    assert.equal((await s.api('POST', '/api/scheduler/refresh', {})).status, 400);
    assert.equal((await s.api('POST', '/api/scheduler/refresh', { keywordIds: [] })).status, 400);
    assert.equal((await s.api('POST', '/api/scheduler/refresh', { keywordIds: ['x'] })).status, 400);
    assert.equal((await s.api('POST', '/api/scheduler/refresh', { keywordIds: [a, 99999] })).status, 404);

    const r = await s.api('POST', '/api/scheduler/refresh', { domainId });
    assert.equal(r.status, 200);
    assert.equal(r.data.checked, 2);
    const r2 = await s.api('POST', '/api/scheduler/refresh', { keywordIds: [a] });
    assert.equal(r2.data.checked, 1);

    const st = await s.api('GET', `/api/scheduler/status?domainId=${domainId}`);
    assert.equal(st.status, 200);
    assert.equal(st.data.lastRun.kind, 'manual');
    assert.equal(st.data.lastRun.checked, 1);
    assert.equal(st.data.recentRuns.length, 2);
    assert.equal(st.data.keywords, 2);
    assert.equal(st.data.dueKeywords, 0);
    assert.ok(st.data.lastCheckedAt);
    assert.deepEqual(st.data.queue, []);
    assert.equal(st.data.providerAvailable, true);
    assert.equal((await s.api('GET', '/api/scheduler/status')).status, 400);

    await s.signup('other-sched@test.dev');
    assert.equal((await s.api('POST', '/api/scheduler/refresh', { domainId })).status, 404);
    assert.equal((await s.api('POST', '/api/scheduler/refresh', { keywordIds: [a] })).status, 404);
    assert.equal((await s.api('GET', `/api/scheduler/status?domainId=${domainId}`)).status, 404);
    s.setToken(null);
    assert.equal((await s.api('GET', `/api/scheduler/status?domainId=${domainId}`)).status, 401);
  } finally { s.close(); }
});

test('refresh endpoints return 503 without a provider', async () => {
  const { s, domainId } = await setup(null);
  try {
    assert.equal((await s.api('POST', '/api/scheduler/refresh', { domainId })).status, 503);
    assert.equal((await s.api('POST', '/api/scheduler/backfill', { domainId, days: 3 })).status, 503);
    const st = await s.api('GET', `/api/scheduler/status?domainId=${domainId}`);
    assert.equal(st.data.providerAvailable, false);
  } finally { s.close(); }
});

test('POST /backfill writes one snapshot per past day, keeps existing days', async () => {
  const { s, domainId, provider, keywordIds: [a, b] } = await setup();
  try {
    assert.equal((await s.api('POST', '/api/scheduler/backfill', { domainId, days: 0 })).status, 400);
    assert.equal((await s.api('POST', '/api/scheduler/backfill', { domainId, days: 999 })).status, 400);
    assert.equal((await s.api('POST', '/api/scheduler/backfill', { days: 3 })).status, 400);

    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    s.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank) VALUES (?,?,?)').run(a, `${yesterday}T09:00:00.000Z`, 7);
    const ev = once(s.ctx.events, 'ranks:updated');
    const r = await s.api('POST', '/api/scheduler/backfill', { domainId, days: 5 });
    assert.equal(r.status, 200);
    assert.equal(r.data.checked, 9);
    assert.equal(r.data.skipped, 1);
    await ev;
    const days = snaps(s.ctx.db, a).map(x => x.checked_at.slice(0, 10));
    assert.equal(new Set(days).size, 5);
    assert.equal(snaps(s.ctx.db, a).find(x => x.checked_at.startsWith(yesterday)).rank, 7);
    assert.equal(snaps(s.ctx.db, b).length, 5);
    const dates = new Set(provider.calls.map(c => c.date));
    assert.equal(dates.size, 5);
    assert.ok(![...dates].includes(new Date().toISOString().slice(0, 10)));
    const st = await s.api('GET', `/api/scheduler/status?domainId=${domainId}`);
    assert.equal(st.data.lastRun.kind, 'backfill');
  } finally { s.close(); }
});

test('keywords:added triggers an async refresh', async () => {
  const { s, domainId, keywordIds: [a] } = await setup();
  try {
    const ev = once(s.ctx.events, 'ranks:updated');
    s.ctx.events.emit('keywords:added', { domainId, keywordIds: [a] });
    assert.equal(snaps(s.ctx.db, a).length, 0);    // non-blocking
    const [payload] = await ev;
    assert.deepEqual(payload.keywordIds, [a]);
    assert.equal(snaps(s.ctx.db, a).length, 1);
  } finally { s.close(); }
});

test('runDue runs registered jobs on their interval and refreshes due, non-paused domains', async () => {
  const { s, user, domainId, keywordIds: [a, b] } = await setup();
  try {
    const paused = s.seedDomain(user.id, 'paused.com', ['paused kw']);
    s.ctx.db.prepare('UPDATE domains SET paused = 1 WHERE id = ?').run(paused.domainId);
    let runs = 0;
    s.ctx.jobs.set('counter', { everyMinutes: 10, run: async () => { runs++; } });
    s.ctx.jobs.set('broken', { everyMinutes: 10, run: async () => { throw new Error('boom'); } });
    const t0 = new Date();
    const origErr = console.error; console.error = () => {};
    try {
      const r = await runDue(s.ctx, t0);
      assert.deepEqual(r.ran, ['counter']);
      assert.equal(r.refreshes.length, 1);
      assert.equal(r.refreshes[0].checked, 2);
      await runDue(s.ctx, new Date(t0.getTime() + 5 * 60_000));
      assert.equal(runs, 1);
      const r3 = await runDue(s.ctx, new Date(t0.getTime() + 11 * 60_000));
      assert.equal(runs, 2);
      assert.equal(r3.refreshes.length, 0);           // already refreshed today
    } finally { console.error = origErr; }
    assert.equal(snaps(s.ctx.db, a).length, 1);
    assert.equal(snaps(s.ctx.db, b).length, 1);
    assert.equal(snaps(s.ctx.db, paused.keywordIds[0]).length, 0);
    const st = await s.api('GET', `/api/scheduler/status?domainId=${domainId}`);
    assert.equal(st.data.lastRun.kind, 'daily');
    assert.equal(st.data.nextRun, null);              // timers disabled in tests
  } finally { s.close(); }
});
