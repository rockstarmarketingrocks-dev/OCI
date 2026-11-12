import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseGscCsv, parseCsvRows, parseNumber } from '../server/modules/gsc-import.js';

let t, user, ownerTok, domainId, trackedId;
const CSV = [
  'Top queries,Clicks,Impressions,CTR,Position',
  'rank tracker,120,"4,500",2.67%,3.2',
  '"best seo tool, free",10,9000,0.11%,12.4',
  'keyword position checker,3,1500,0.2%,18',
  '"serp ""checker""",0,200,0%,45.5',
  'SEO Tool,50,800,6.25%,5',
  ',5,10,50%,1',
  '',
].join('\r\n');

before(async () => {
  t = await startTestServer({ modules: ['gsc-import'] });
  ({ user, token: ownerTok } = await t.signup());
  ({ domainId, keywordIds: [trackedId] } = t.seedDomain(user.id, 'example.com', ['seo tool']));
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank) VALUES (?,?,?)').run(trackedId, '2026-01-01T00:00:00Z', 5);
});
after(() => t.close());

test('parser handles quotes, percent CTR, locales and alternate headers', () => {
  assert.deepEqual(parseCsvRows('a,"b,c","d ""e"""\r\n1,2,3\n'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
  assert.equal(parseNumber('1,234'), 1234);
  assert.equal(parseNumber('8,3'), 8.3);
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber('12.5%'), 12.5);
  assert.equal(parseNumber(''), null);
  const { rows, skipped } = parseGscCsv(CSV);
  assert.equal(skipped, 1);
  assert.equal(rows.length, 5);
  const best = rows.find(r => r.query === 'best seo tool, free');
  assert.equal(best.impressions, 9000);
  assert.ok(Math.abs(best.ctr - 0.0011) < 1e-9);
  assert.equal(rows.find(r => r.query.startsWith('serp')).query, 'serp "checker"');
  const alt = parseGscCsv('﻿Query;Clicks;Impressions;Position\nfoo bar;1;100;9,5\n').rows[0];
  assert.deepEqual({ ...alt }, { query: 'foo bar', page: '', clicks: 1, impressions: 100, ctr: 0.01, position: 9.5 });
  assert.throws(() => parseGscCsv('Clicks,Impressions\n1,2'), /Query/);
});

test('import requires auth, ownership and valid CSV', async () => {
  const anon = await fetch(`${t.base}/api/gsc-import/csv?domainId=${domainId}`, { method: 'POST', body: CSV, headers: { 'content-type': 'text/csv' } });
  assert.equal(anon.status, 401);
  assert.equal((await t.api('POST', '/api/gsc-import/csv', CSV)).status, 400);
  assert.equal((await t.api('POST', '/api/gsc-import/csv?domainId=9999', CSV)).status, 404);
  assert.equal((await t.api('POST', `/api/gsc-import/csv?domainId=${domainId}`, 'Foo,Bar\n1,2')).status, 400);
  assert.equal((await t.api('POST', `/api/gsc-import/csv?domainId=${domainId}`, { csv: 42 })).status, 400);
});

test('import, opportunities and striking distance', async () => {
  const r = await t.api('POST', `/api/gsc-import/csv?domainId=${domainId}`, CSV);
  assert.equal(r.status, 201);
  assert.equal(r.data.imported, 5);
  // Re-import (JSON body) upserts instead of duplicating.
  const again = await t.api('POST', '/api/gsc-import/csv', { domainId, csv: CSV });
  assert.equal(again.data.total, 5);

  const o = await t.api('GET', `/api/gsc-import/opportunities?domainId=${domainId}`);
  assert.equal(o.status, 200);
  const qs = o.data.opportunities.map(x => x.query);
  assert.deepEqual(qs, ['best seo tool, free', 'rank tracker', 'keyword position checker', 'serp "checker"']);
  assert.ok(!qs.includes('seo tool'), 'already-tracked keyword excluded');
  const byQ = Object.fromEntries(o.data.opportunities.map(x => [x.query, x]));
  assert.deepEqual(byQ['best seo tool, free'].flags, ['striking distance']);
  assert.deepEqual(byQ['keyword position checker'].flags, ['striking distance']);
  assert.deepEqual(byQ['rank tracker'].flags, []);
  assert.equal(byQ['serp "checker"'].strikingDistance, false);
  assert.equal(o.data.strikingDistance, 2);

  const s = await t.api('GET', `/api/gsc-import/opportunities?domainId=${domainId}&strikingOnly=1&limit=1`);
  assert.equal(s.data.total, 2);
  assert.deepEqual(s.data.opportunities.map(x => x.query), ['best seo tool, free']);
  assert.equal((await t.api('GET', `/api/gsc-import/opportunities?domainId=${domainId}&limit=0`)).status, 400);
});

test('track adds keywords, emits keywords:added and removes them from opportunities', async () => {
  const seen = [];
  t.ctx.events.on('keywords:added', p => seen.push(p));
  assert.equal((await t.api('POST', '/api/gsc-import/track', { domainId, queries: [] })).status, 400);
  assert.equal((await t.api('POST', '/api/gsc-import/track', { domainId, queries: [1] })).status, 400);
  const r = await t.api('POST', '/api/gsc-import/track', { domainId, queries: ['Rank  Tracker', 'rank tracker', 'seo tool'] });
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 1);
  assert.equal(r.data.skipped, 1);
  assert.deepEqual(seen, [{ domainId, keywordIds: r.data.keywordIds }]);
  const kw = t.ctx.db.prepare('SELECT phrase, country, language FROM keywords WHERE id = ?').get(r.data.keywordIds[0]);
  assert.deepEqual({ ...kw }, { phrase: 'rank tracker', country: 'US', language: 'en' });
  const o = await t.api('GET', `/api/gsc-import/opportunities?domainId=${domainId}`);
  assert.ok(!o.data.opportunities.some(x => x.query === 'rank tracker'));
});

test('data is scoped to the owner; owner can clear imports', async () => {
  await t.signup(`other${Date.now()}@test.dev`);
  assert.equal((await t.api('GET', `/api/gsc-import/opportunities?domainId=${domainId}`)).status, 404);
  assert.equal((await t.api('POST', '/api/gsc-import/track', { domainId, queries: ['x'] })).status, 404);
  assert.equal((await t.api('DELETE', `/api/gsc-import?domainId=${domainId}`)).status, 404);
  t.setToken(ownerTok);
  const d = await t.api('DELETE', `/api/gsc-import?domainId=${domainId}`);
  assert.equal(d.data.deleted, 5);
  assert.equal((await t.api('GET', `/api/gsc-import/opportunities?domainId=${domainId}`)).data.total, 0);
});

test('oauth status stub reflects GSC_CLIENT_ID', async () => {
  const prev = process.env.GSC_CLIENT_ID;
  delete process.env.GSC_CLIENT_ID;
  assert.equal((await t.api('GET', '/api/gsc-import/oauth/status')).data.configured, false);
  process.env.GSC_CLIENT_ID = 'abc';
  assert.equal((await t.api('GET', '/api/gsc-import/oauth/status')).data.configured, true);
  if (prev === undefined) delete process.env.GSC_CLIENT_ID; else process.env.GSC_CLIENT_ID = prev;
});
