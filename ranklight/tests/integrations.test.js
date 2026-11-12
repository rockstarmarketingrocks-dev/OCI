import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startTestServer } from './helpers.js';
import { outbox, settle } from '../server/modules/integrations.js';

process.env.NODE_ENV = 'test';
let t, user, token, domainId, kw, other;
const snap = (keywordId, checkedAt, rank, url = null) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url) VALUES (?,?,?,?)').run(keywordId, checkedAt, rank, url);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();

before(async () => {
  t = await startTestServer({ modules: ['integrations'] });
  ({ user, token } = await t.signup());
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['seo tool', '=cmd()', 'rank, "tracker"']));
  other = t.seedDomain(user.id, 'other.org', ['other kw']);
  snap(kw[0], daysAgo(2), 8, 'https://example.com/a');
  snap(kw[0], daysAgo(1), 3, 'https://example.com/a');
  snap(kw[1], daysAgo(1), 15, 'https://example.com/b');
  snap(other.keywordIds[0], daysAgo(1), 1, 'https://other.org/');
});
after(() => t.close());

test('CRUD with validation and user scoping', async () => {
  const bad = async (body, re) => { const r = await t.api('POST', '/api/integrations', body); assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await bad({ type: 'email', name: 'x' }, /type must be/);
  await bad({ type: 'webhook', name: ' ', config: { url: 'https://x.dev' } }, /name is required/);
  await bad({ type: 'webhook', name: 'W' }, /config.url is required/);
  await bad({ type: 'webhook', name: 'W', config: { url: 'ftp://x.dev' } }, /http or https/);
  await bad({ type: 'slack', name: 'S', config: { url: 'http://hooks.slack.test/x' } }, /must use https/);
  await bad({ type: 'webhook', name: 'W', config: { url: 'https://x.dev', events: ['nope'] } }, /config.events/);
  await bad({ type: 'webhook', name: 'W', config: [] }, /config must be an object/);

  const c = await t.api('POST', '/api/integrations', { type: 'webhook', name: ' Hook ', config: { url: 'https://hooks.example.dev/in', domainId, secret: 's3' } });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.deepEqual({ ...c.data, id: 0, createdAt: 0 }, { id: 0, type: 'webhook', name: 'Hook', enabled: true, lastStatus: null, lastSentAt: null, createdAt: 0, feedUrl: null,
    config: { domainId, url: 'https://hooks.example.dev/in', events: ['ranks:updated', 'alert:triggered'], secret: 's3' } });

  const p = await t.api('PATCH', `/api/integrations/${c.data.id}`, { enabled: false, config: { events: ['alert:triggered'] } });
  assert.equal(p.status, 200);
  assert.equal(p.data.enabled, false);
  assert.deepEqual(p.data.config.events, ['alert:triggered']);
  assert.equal(p.data.config.url, 'https://hooks.example.dev/in');
  assert.equal((await t.api('PATCH', `/api/integrations/${c.data.id}`, { type: 'slack' })).status, 400);
  assert.equal((await t.api('GET', '/api/integrations')).data.length, 1);
  assert.equal((await t.api('GET', '/api/integrations?type=slack')).data.length, 0);

  // Another user cannot see, edit or attach foreign domains.
  await t.signup();
  assert.equal((await t.api('GET', `/api/integrations/${c.data.id}`)).status, 404);
  assert.equal((await t.api('DELETE', `/api/integrations/${c.data.id}`)).status, 404);
  assert.equal((await t.api('GET', '/api/integrations')).data.length, 0);
  assert.equal((await t.api('POST', '/api/integrations', { type: 'looker_csv', name: 'F', config: { domainId } })).status, 404);
  t.setToken(token);

  assert.equal((await t.api('DELETE', `/api/integrations/${c.data.id}`)).status, 200);
  assert.equal((await t.api('GET', `/api/integrations/${c.data.id}`)).status, 404);
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/integrations')).status, 401);
  t.setToken(token);
});

test('ranks:updated and alert:triggered are delivered to matching integrations', async () => {
  const hook = (await t.api('POST', '/api/integrations', { type: 'webhook', name: 'All', config: { url: 'https://hooks.example.dev/all', secret: 'k' } })).data;
  const slack = (await t.api('POST', '/api/integrations', { type: 'slack', name: 'Slack', config: { url: 'https://hooks.slack.test/services/x', events: ['alert:triggered'] } })).data;
  const scoped = (await t.api('POST', '/api/integrations', { type: 'webhook', name: 'Other only', config: { url: 'https://hooks.example.dev/o', domainId: other.domainId } })).data;
  await t.api('POST', '/api/integrations', { type: 'webhook', name: 'Off', enabled: false, config: { url: 'https://hooks.example.dev/off' } });
  outbox.length = 0;

  t.ctx.events.emit('ranks:updated', { domainId, keywordIds: kw, checkedAt: daysAgo(1) });
  await settle();
  assert.deepEqual(outbox.map(o => o.integrationId), [hook.id]);
  const { body, headers } = outbox[0];
  assert.equal(body.event, 'ranks:updated');
  assert.equal(body.domain.host, 'example.com');
  assert.deepEqual({ ...body.summary }, { keywords: 3, ranked: 2, improved: 1, declined: 0, top3: 1, top10: 1, averageRank: 9 });
  assert.deepEqual(body.keywords.find(k => k.id === kw[0]), { id: kw[0], keyword: 'seo tool', searchEngine: 'google', device: 'desktop', country: 'US', location: '',
    searchVolume: null, rank: 3, previousRank: 8, change: 5, url: 'https://example.com/a', checkedAt: body.keywords[0].checkedAt });
  assert.equal(headers['x-ranklight-signature'], 'sha256=' + crypto.createHmac('sha256', 'k').update(JSON.stringify(body)).digest('hex'));
  assert.match((await t.api('GET', `/api/integrations/${hook.id}`)).data.lastStatus, /^ranks:updated: skipped: test mode/);

  outbox.length = 0;
  t.ctx.events.emit('alert:triggered', { userId: user.id, domain: { id: domainId, host: 'example.com' }, rule: { id: 9, name: 'Drops <3>', type: 'rank_drop', threshold: 3 },
    notification: { id: 1, domainId, keywordId: kw[0], keyword: 'seo tool', type: 'rank_drop', message: '"seo tool" dropped 5 positions', details: {}, createdAt: daysAgo(0) } });
  await settle();
  assert.deepEqual(outbox.map(o => o.integrationId).sort(), [hook.id, slack.id].sort());
  const s = outbox.find(o => o.integrationId === slack.id).body;
  assert.deepEqual(Object.keys(s), ['text']);
  assert.match(s.text, /Drops &lt;3&gt;\* on example.com\n"seo tool" dropped 5 positions/);
  assert.equal(outbox.find(o => o.integrationId === hook.id).body.alert.keyword, 'seo tool');
  assert.ok(!outbox.some(o => o.integrationId === scoped.id));

  // Bad payloads never throw.
  t.ctx.events.emit('ranks:updated', { domainId: 99999 });
  t.ctx.events.emit('alert:triggered', null);
  await settle();

  const test = await t.api('POST', `/api/integrations/${slack.id}/test`);
  assert.equal(test.status, 200);
  assert.equal(test.data.ok, true);
  assert.match(outbox.at(-1).body.text, /test message/);
  assert.match(test.data.integration.lastStatus, /^test: skipped/);
});

test('real delivery records HTTP status and network errors without crashing', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c));
    req.on('end', () => { got.push({ path: req.url, event: req.headers['x-ranklight-event'], body: JSON.parse(b) }); res.statusCode = req.url === '/fail' ? 500 : 204; res.end(); });
  });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mk = async (name, url) => (await t.api('POST', '/api/integrations', { type: 'webhook', name, config: { url } })).data;
  const ok = await mk('Local ok', `${base}/ok`), fail = await mk('Local fail', `${base}/fail`), dead = await mk('Dead', 'http://127.0.0.1:1/x');
  process.env.NODE_ENV = 'production';
  try {
    const r1 = await t.api('POST', `/api/integrations/${ok.id}/test`);
    assert.deepEqual([r1.data.ok, r1.data.status, r1.data.lastStatus], [true, 204, 'ok: HTTP 204']);
    assert.equal(got[0].event, 'test');
    assert.equal(got[0].body.test, true);
    const r2 = await t.api('POST', `/api/integrations/${fail.id}/test`);
    assert.deepEqual([r2.data.ok, r2.data.integration.lastStatus], [false, 'test: error: HTTP 500']);
    const r3 = await t.api('POST', `/api/integrations/${dead.id}/test`);
    assert.equal(r3.data.ok, false);
    assert.match(r3.data.lastStatus, /^error: /);
  } finally {
    process.env.NODE_ENV = 'test';
    srv.close();
    for (const i of [ok, fail, dead]) await t.api('DELETE', `/api/integrations/${i.id}`);
  }
});

test('tokenized CSV feed for BI tools', async () => {
  const f = await t.api('POST', '/api/integrations', { type: 'looker_csv', name: 'Looker', config: { domainId } });
  assert.equal(f.status, 201);
  assert.match(f.data.feedUrl, /^\/api\/integrations\/feed\/[\w-]{32}\.csv$/);

  t.setToken(null); // the feed is public, authorized only by its token
  const r = await t.api('GET', f.data.feedUrl);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const lines = r.data.trim().split('\r\n');
  assert.equal(lines[0], 'date,checked_at,domain,keyword,search_engine,device,country,location,language,rank,previous_rank,change,url,search_volume,cpc,starred');
  assert.equal(lines.length, 4); // header + 3 keywords of example.com only
  assert.ok(lines.some(l => l.includes(",'=cmd(),")), 'formula injection neutralized');
  assert.ok(lines.some(l => l.includes(',"rank, ""tracker""",')), 'quotes and commas escaped');
  const seo = lines.find(l => l.includes(',seo tool,')).split(',');
  assert.deepEqual([seo[9], seo[10], seo[11]], ['3', '8', '5']);

  const hist = await t.api('GET', `${f.data.feedUrl}?days=30`);
  assert.equal(hist.data.trim().split('\r\n').length, 4); // 3 snapshots over time
  assert.equal((await t.api('GET', `${f.data.feedUrl}?days=0`)).status, 400);
  assert.equal((await t.api('GET', '/api/integrations/feed/nope.csv')).status, 404);
  t.setToken(token);

  assert.match((await t.api('GET', `/api/integrations/${f.data.id}`)).data.lastStatus, /fetched 3 rows/);
  const tst = await t.api('POST', `/api/integrations/${f.data.id}/test`);
  assert.equal(tst.data.rows, 3);

  const rot = await t.api('POST', `/api/integrations/${f.data.id}/rotate-token`);
  assert.notEqual(rot.data.feedUrl, f.data.feedUrl);
  assert.equal((await t.api('GET', f.data.feedUrl)).status, 404);
  await t.api('PATCH', `/api/integrations/${f.data.id}`, { enabled: false });
  assert.equal((await t.api('GET', rot.data.feedUrl)).status, 404);

  const all = (await t.api('POST', '/api/integrations', { type: 'looker_csv', name: 'All domains' })).data;
  assert.equal((await t.api('GET', all.feedUrl)).data.trim().split('\r\n').length, 5);
  const hook = (await t.api('GET', '/api/integrations?type=webhook')).data[0];
  assert.equal((await t.api('POST', `/api/integrations/${hook.id}/rotate-token`)).status, 400);
});
