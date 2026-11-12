import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { parseCsv, toCsv } from '../server/modules/exports.js';

let t, user, domainId, keywordIds;
const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const rowsOf = csv => parseCsv(csv).map(r => r.cells);

before(async () => {
  t = await startTestServer({ modules: ['exports'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank, "tracker"']));
  const db = t.ctx.db;
  const snap = db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, serp_features) VALUES (?,?,?,?,?)');
  snap.run(keywordIds[0], `${day(2)}T08:00:00Z`, 9, 'https://example.com/a', '[]');
  snap.run(keywordIds[0], `${day(1)}T08:00:00Z`, 7, 'https://example.com/a', '[]');
  snap.run(keywordIds[0], `${day(1)}T20:00:00Z`, 5, 'https://example.com/b', '["featured_snippet","people_also_ask"]');
  snap.run(keywordIds[1], `${day(1)}T08:00:00Z`, null, null, '[]');
  snap.run(keywordIds[1], `${day(90)}T08:00:00Z`, 40, 'https://example.com/old', '[]');
  db.prepare('UPDATE keywords SET search_volume = 1200 WHERE id = ?').run(keywordIds[0]);
  const tag = Number(db.prepare("INSERT INTO tags(domain_id, name) VALUES (?, 'brand')").run(domainId).lastInsertRowid);
  db.prepare('INSERT INTO keyword_tags VALUES (?,?)').run(keywordIds[0], tag);
});
after(() => t.close());

test('CSV helpers quote and parse round-trip', () => {
  const csv = toCsv(['a', 'b'], [['x, y', 'he said "hi"'], ['line\nbreak', '=SUM(A1)'], [null, 3]]);
  assert.deepEqual(rowsOf(csv), [['a', 'b'], ['x, y', 'he said "hi"'], ['line\nbreak', "'=SUM(A1)"], ['', '3']]);
});

test('keywords.csv exports latest rank, change vs previous day, tags, features', async () => {
  const r = await t.api('GET', `/api/exports/keywords.csv?domainId=${domainId}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /example\.com-keywords\.csv/);
  const [head, ...rows] = rowsOf(r.data);
  assert.deepEqual(head, ['phrase', 'device', 'country', 'location', 'tags', 'rank', 'change', 'url', 'volume', 'features']);
  const byPhrase = Object.fromEntries(rows.map(x => [x[0], x]));
  assert.deepEqual(byPhrase['seo tool'], ['seo tool', 'desktop', 'US', '', 'brand', '5', '4', 'https://example.com/b', '1200', 'featured_snippet;people_also_ask']);
  assert.equal(byPhrase['rank, "tracker"'][5], '');
  assert.equal(byPhrase['rank, "tracker"'][6], '-61');
});

test('history.csv is long format, last snapshot per day, limited by days', async () => {
  const r = await t.api('GET', `/api/exports/history.csv?domainId=${domainId}&days=30`);
  assert.equal(r.status, 200);
  const [head, ...rows] = rowsOf(r.data);
  assert.deepEqual(head, ['date', 'keyword', 'device', 'rank', 'url']);
  assert.deepEqual(rows, [
    [day(2), 'seo tool', 'desktop', '9', 'https://example.com/a'],
    [day(1), 'rank, "tracker"', 'desktop', '', ''],
    [day(1), 'seo tool', 'desktop', '5', 'https://example.com/b'],
  ]);
  const all = await t.api('GET', `/api/exports/history.csv?domainId=${domainId}&days=365`);
  assert.equal(rowsOf(all.data).length, 5);
  assert.equal((await t.api('GET', `/api/exports/history.csv?domainId=${domainId}&days=0`)).status, 400);
});

test('domain.json is a full backup', async () => {
  const r = await t.api('GET', `/api/exports/domain.json?domainId=${domainId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.domain.host, 'example.com');
  assert.equal(r.data.domain.user_id, undefined);
  assert.deepEqual(r.data.tags.map(x => x.name), ['brand']);
  const kw = r.data.keywords.find(k => k.phrase === 'seo tool');
  assert.deepEqual(kw.tags, ['brand']);
  assert.equal(kw.snapshots.length, 3);
  assert.deepEqual(kw.snapshots.at(-1).serp_features, ['featured_snippet', 'people_also_ask']);
});

test('import creates keywords and tags, skips duplicates, reports errors, emits event', async () => {
  const events = [];
  t.ctx.events.on('keywords:added', e => events.push(e));
  const csv = 'Keyword,DEVICE,Country,Location,Tags\r\n'
    + 'new phrase,mobile,gb,London,"brand;local"\r\n'
    + 'SEO Tool,,,,\r\n'                 // exists already (desktop/US)
    + 'new phrase,mobile,GB,London,\r\n' // duplicate within file
    + '"quoted, phrase",desktop,US,,\r\n'
    + ',desktop,US,,\r\n'                // empty keyword
    + 'bad device,tablet,US,,\r\n'
    + 'bad country,desktop,USA,,\r\n';
  const dry = await t.api('POST', `/api/exports/import?domainId=${domainId}&dryRun=1`, csv);
  assert.equal(dry.status, 200);
  assert.equal(dry.data.added, 2);
  assert.deepEqual(dry.data.rows.map(x => x.status), ['add', 'skip', 'skip', 'add', 'error', 'error', 'error']);
  assert.equal(events.length, 0);

  const r = await t.api('POST', `/api/exports/import?domainId=${domainId}`, csv);
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 2);
  assert.equal(r.data.skipped, 2);
  assert.deepEqual(r.data.errors.map(e => e.line), [6, 7, 8]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { domainId, keywordIds: r.data.keywordIds });
  const kw = t.ctx.db.prepare("SELECT * FROM keywords WHERE phrase = 'new phrase'").get();
  assert.equal(kw.device, 'mobile'); assert.equal(kw.country, 'GB'); assert.equal(kw.location, 'London');
  const tags = t.ctx.db.prepare('SELECT t.name FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id WHERE kt.keyword_id = ? ORDER BY t.name').all(kw.id).map(x => x.name);
  assert.deepEqual(tags, ['brand', 'local']);
  assert.ok(t.ctx.db.prepare("SELECT 1 FROM keywords WHERE phrase = 'quoted, phrase'").get());
});

test('import accepts JSON body and headerless single column', async () => {
  const r = await t.api('POST', `/api/exports/import?domainId=${domainId}`, { csv: 'alpha\nbeta\n' });
  assert.equal(r.status, 201);
  assert.equal(r.data.added, 2);
  const again = await t.api('POST', `/api/exports/import?domainId=${domainId}`, { csv: 'alpha\n' });
  assert.equal(again.status, 200);
  assert.deepEqual({ added: again.data.added, skipped: again.data.skipped }, { added: 0, skipped: 1 });
});

test('export -> import round trip keeps tricky phrases', async () => {
  const { domainId: other } = t.seedDomain(user.id, 'other.com', []);
  const exp = await t.api('GET', `/api/exports/keywords.csv?domainId=${domainId}`);
  const csv = rowsOf(exp.data).map(r => r.slice(0, 5)).map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n')
    .replace(/^phrase/, 'keyword');
  const r = await t.api('POST', `/api/exports/import?domainId=${other}`, csv);
  assert.equal(r.status, 201);
  assert.ok(t.ctx.db.prepare('SELECT 1 FROM keywords WHERE domain_id = ? AND phrase = ?').get(other, 'rank, "tracker"'));
});

test('validation and access control', async () => {
  assert.equal((await t.api('GET', '/api/exports/keywords.csv')).status, 400);
  assert.equal((await t.api('POST', `/api/exports/import?domainId=${domainId}`, { csv: '' })).status, 400);
  assert.equal((await t.api('POST', `/api/exports/import?domainId=${domainId}`, 'device,country\nmobile,US')).status, 400);
  assert.equal((await t.api('POST', `/api/exports/import?domainId=${domainId}`, 'keyword\n"open')).status, 400);
  await t.signup();
  assert.equal((await t.api('GET', `/api/exports/domain.json?domainId=${domainId}`)).status, 404);
  t.setToken(null);
  assert.equal((await t.api('GET', `/api/exports/keywords.csv?domainId=${domainId}`)).status, 401);
});
