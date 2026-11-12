// Cross-module integration: all modules loaded together.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t, user;
before(async () => {
  t = await startTestServer();
  ({ user } = await t.signup());
});
after(() => t.close());

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); }
  return null;
};

test('every module loads and the simulator provider is active', async () => {
  const mods = await t.api('GET', '/api/_meta/modules');
  assert.equal(mods.data.length, 25);
  const st = await t.api('GET', '/api/rank-provider/status');
  assert.equal(st.data.active, 'simulator');
});

test('adding keywords triggers a rank refresh and search volume fill', async () => {
  const d = await t.api('POST', '/api/domains', { host: 'example.com' });
  assert.equal(d.status, 201);
  const k = await t.api('POST', '/api/keywords', { domainId: d.data.id, phrases: ['trail running shoes', 'hiking boots'] });
  assert.equal(k.status, 201);
  const snaps = await waitFor(() => t.ctx.db.prepare(`SELECT COUNT(*) AS n FROM rank_snapshots WHERE keyword_id IN (${k.data.keywordIds.join(',')})`).get().n === 2);
  assert.ok(snaps, 'scheduler wrote a snapshot per new keyword');
  const vol = await waitFor(() => t.ctx.db.prepare(`SELECT COUNT(*) AS n FROM keywords WHERE search_volume IS NOT NULL AND id IN (${k.data.keywordIds.join(',')})`).get().n === 2);
  assert.ok(vol, 'search volume filled');
});

test('billing keyword quota is enforced on every keyword-creating route', async () => {
  const d = await t.api('POST', '/api/domains', { host: 'quota.example' });
  const domainId = d.data.id;
  // Fill up to the starter limit (1000) directly, leaving room for exactly one more keyword.
  const used = t.ctx.db.prepare('SELECT COUNT(*) AS n FROM keywords k JOIN domains d ON d.id = k.domain_id WHERE d.user_id = ?').get(user.id).n;
  const ins = t.ctx.db.prepare('INSERT INTO keywords(domain_id, phrase) VALUES (?,?)');
  for (let i = used; i < 999; i++) ins.run(domainId, `filler ${i}`);

  const over = await t.api('POST', '/api/keywords', { domainId, phrases: ['a one', 'a two'] });
  assert.equal(over.status, 402);
  assert.equal(t.ctx.db.prepare("SELECT COUNT(*) AS n FROM keywords WHERE phrase LIKE 'a %'").get().n, 0, 'rolled back');
  assert.equal((await t.api('POST', `/api/exports/import?domainId=${domainId}`, 'keyword\nb one\nb two')).status, 402);
  assert.equal((await t.api('POST', '/api/gsc-import/track', { domainId, queries: ['c one', 'c two'] })).status, 402);
  assert.equal((await t.api('POST', '/api/keyword-research/track', { domainId, phrases: ['d one', 'd two'] })).status, 402);
  const ok = await t.api('POST', '/api/keywords', { domainId, phrases: ['e one'] });
  assert.equal(ok.status, 201);

  // Domain quota: starter allows 5 domains.
  for (const h of ['c.example', 'd.example', 'e.example']) assert.equal((await t.api('POST', '/api/domains', { host: h })).status, 201);
  assert.equal((await t.api('POST', '/api/domains', { host: 'f.example' })).status, 402);
});
