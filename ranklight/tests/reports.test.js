import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startTestServer } from './helpers.js';
import { isDue, nextDueAt, parseRecipients, renderCsv, buildReport, runDueSchedules, buildMime } from '../server/modules/reports.js';

let t, user, domainId, kw, outbox;
const day = n => new Date(Date.now() - n * 864e5).toISOString();

before(async () => {
  outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-outbox-'));
  process.env.RL_OUTBOX_DIR = outbox;
  delete process.env.SMTP_HOST;
  t = await startTestServer({ modules: ['reports'] });
  ({ user } = await t.signup());
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker', '<b>evil</b>', '=cmd()']));
  const ins = t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url) VALUES (?,?,?,?)');
  // kw0 improves 12 -> 3, kw1 declines 4 -> 9, kw2 new (only recent), kw3 never ranked
  ins.run(kw[0], day(40), 12, 'https://example.com/a'); ins.run(kw[0], day(10), 6, 'https://example.com/a'); ins.run(kw[0], day(1), 3, 'https://example.com/a');
  ins.run(kw[1], day(40), 4, 'https://example.com/b'); ins.run(kw[1], day(1), 9, 'https://example.com/b');
  ins.run(kw[2], day(1), 50, 'https://example.com/"x"');
  t.ctx.db.prepare('UPDATE keywords SET search_volume = 1000 WHERE id = ?').run(kw[0]);
});
after(() => { t.close(); fs.rmSync(outbox, { recursive: true, force: true }); });

test('requires authentication', async () => {
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/reports/schedules')).status, 401);
  assert.equal((await t.api('GET', `/api/reports/generate?domainId=${domainId}`)).status, 401);
  await relogin();
});

test('buildReport computes KPIs, movers and chart', () => {
  const d = t.ctx.db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);
  const r = buildReport(t.ctx.db, d, { days: 30 });
  assert.equal(r.kpis.keywords, 4);
  assert.equal(r.kpis.ranked, 3);
  assert.equal(r.kpis.avgRank, (3 + 9 + 50) / 3);
  assert.equal(r.kpis.prevAvgRank, (12 + 4) / 2);
  assert.equal(r.kpis.top3, 1);
  assert.deepEqual(r.winners.map(x => [x.id, x.change]), [[kw[0], 9]]);
  assert.deepEqual(r.losers.map(x => [x.id, x.change]), [[kw[1], -5]]);
  assert.equal(r.rows.find(x => x.id === kw[2]).change, null);       // no start snapshot: "new", not a +51 jump
  assert.deepEqual(r.rows.map(x => x.rank), [3, 9, 50, null]);
  assert.equal(r.chart.length, 2);   // day 10 and day 1 fall inside the 30-day window
  assert.ok(r.kpis.clicks > 0 && r.kpis.prevClicks > 0);
  assert.deepEqual(buildReport(t.ctx.db, d, { days: 5 }).winners.map(x => x.change), [3]);   // start-of-period rank is 6 (day 10)
});

test('generate returns a standalone branded HTML report', async () => {
  const r = await t.api('GET', `/api/reports/generate?domainId=${domainId}&days=30`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  for (const s of ['<!doctype html>', 'Ranklight', 'example.com', '<svg', 'Top movers', 'Winners', 'Losers', 'seo tool', 'All keywords (4)'])
    assert.ok(r.data.includes(s), `missing ${s}`);
  assert.ok(!r.data.includes('<b>evil</b>') && r.data.includes('&lt;b&gt;evil&lt;/b&gt;'));
  assert.ok(!r.data.includes('window.print') && !/setTimeout\(print/.test(r.data));
  const p = await t.api('GET', `/api/reports/generate?domainId=${domainId}&format=pdf-html&sections=kpis,chart`);
  assert.match(p.data, /setTimeout\(print/);
  assert.ok(!p.data.includes('All keywords') && !p.data.includes('Top movers') && p.data.includes('<svg'));
});

test('generate returns CSV with a formula guard', async () => {
  const r = await t.api('GET', `/api/reports/generate?domainId=${domainId}&format=csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="example-com-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = r.data.trim().split('\r\n');
  assert.equal(lines[0], 'keyword,search_engine,device,country,location,rank,start_rank,change,search_volume,est_clicks,url,checked_at');
  assert.equal(lines.length, 5);
  assert.match(lines[1], /^seo tool,google,desktop,US,,3,12,9,1000,110,https:\/\/example.com\/a,/);
  assert.ok(lines.some(l => l.startsWith("'=cmd()")));
  assert.ok(lines.some(l => l.includes('"https://example.com/""x"""')));
  assert.equal(renderCsv({ rows: [] }).trim().split('\r\n').length, 1);
});

test('generate validates input and ownership', async () => {
  assert.equal((await t.api('GET', '/api/reports/generate')).status, 400);
  assert.equal((await t.api('GET', `/api/reports/generate?domainId=${domainId}&format=pdf`)).status, 400);
  assert.equal((await t.api('GET', `/api/reports/generate?domainId=${domainId}&days=0`)).status, 400);
  assert.equal((await t.api('GET', `/api/reports/generate?domainId=${domainId}&days=400`)).status, 400);
  assert.equal((await t.api('GET', `/api/reports/generate?domainId=${domainId}&sections=kpis,nope`)).status, 400);
  assert.equal((await t.api('GET', '/api/reports/generate?domainId=abc')).status, 400);
  await t.signup('intruder@test.dev');
  assert.equal((await t.api('GET', `/api/reports/generate?domainId=${domainId}`)).status, 404);
  await relogin();
});

async function relogin() {
  const r = await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' });
  t.setToken(r.data.token);
}

test('schedule CRUD with validation and isolation', async () => {
  const bad = async (body, re) => { const r = await t.api('POST', '/api/reports/schedules', body); assert.equal(r.status, 400, JSON.stringify(r.data)); if (re) assert.match(r.data.error, re); };
  const base = { domainId, name: 'Weekly client report', recipients: 'a@x.com, B@x.com; a@x.com' };
  await bad({ ...base, domainId: undefined }, /domainId/);
  await bad({ ...base, name: '  ' }, /name/);
  await bad({ ...base, frequency: 'hourly' }, /frequency/);
  await bad({ ...base, format: 'pdf' }, /format/);
  await bad({ ...base, recipients: 'not-an-email' }, /Invalid email/);
  await bad({ ...base, recipients: [] }, /recipient/);
  await bad({ ...base, sections: ['kpis', 'x'] }, /section/);
  await bad({ ...base, days: 1000 }, /days/);

  const c = await t.api('POST', '/api/reports/schedules', { ...base, frequency: 'monthly', format: 'csv' });
  assert.equal(c.status, 201);
  assert.deepEqual(c.data.recipients, ['a@x.com', 'b@x.com']);
  assert.deepEqual(c.data.sections, ['kpis', 'chart', 'movers', 'keywords']);
  assert.equal(c.data.days, 90);
  assert.equal(c.data.enabled, true);
  assert.equal(c.data.domainName, 'example.com');
  assert.equal(c.data.lastSentAt, null);

  const id = c.data.id;
  assert.equal((await t.api('GET', `/api/reports/schedules/${id}`)).data.name, 'Weekly client report');
  const up = await t.api('PATCH', `/api/reports/schedules/${id}`, { name: 'Monthly', sections: 'movers,kpis', enabled: false });
  assert.equal(up.status, 200);
  assert.deepEqual(up.data.sections, ['kpis', 'movers']);
  assert.equal(up.data.enabled, false);
  assert.equal((await t.api('PATCH', `/api/reports/schedules/${id}`, {})).status, 400);
  assert.equal((await t.api('PATCH', `/api/reports/schedules/${id}`, { enabled: 'yes' })).status, 400);
  assert.equal((await t.api('PATCH', `/api/reports/schedules/${id}`, { domainId: domainId + 99 })).status, 400);
  assert.equal((await t.api('GET', `/api/reports/schedules?domainId=${domainId}`)).data.length, 1);
  assert.equal((await t.api('GET', '/api/reports/schedules/abc')).status, 400);

  await t.signup('stranger@test.dev');
  assert.equal((await t.api('GET', '/api/reports/schedules')).data.length, 0);
  assert.equal((await t.api('GET', `/api/reports/schedules/${id}`)).status, 404);
  assert.equal((await t.api('DELETE', `/api/reports/schedules/${id}`)).status, 404);
  assert.equal((await t.api('POST', '/api/reports/schedules', base)).status, 404);
  await relogin();

  assert.equal((await t.api('DELETE', `/api/reports/schedules/${id}`)).status, 200);
  assert.equal((await t.api('GET', `/api/reports/schedules/${id}`)).status, 404);
});

test('due logic', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  assert.equal(isDue({ enabled: 1, frequency: 'daily', last_sent_at: null }, now), true);
  assert.equal(isDue({ enabled: 0, frequency: 'daily', last_sent_at: null }, now), false);
  assert.equal(isDue({ enabled: 1, frequency: 'daily', last_sent_at: '2026-05-09T12:05:00Z' }, now), true);   // within grace
  assert.equal(isDue({ enabled: 1, frequency: 'daily', last_sent_at: '2026-05-10T06:00:00Z' }, now), false);
  assert.equal(isDue({ enabled: 1, frequency: 'weekly', last_sent_at: '2026-05-05T12:00:00Z' }, now), false);
  assert.equal(isDue({ enabled: 1, frequency: 'weekly', last_sent_at: '2026-05-03T12:00:00Z' }, now), true);
  assert.equal(nextDueAt({ frequency: 'monthly', last_sent_at: '2026-01-15T08:00:00Z' }), '2026-02-15T08:00:00.000Z');
  assert.equal(isDue({ enabled: 1, frequency: 'daily', last_sent_at: null, last_error: 'x', last_attempt_at: '2026-05-10T11:30:00Z' }, now), false);
  assert.throws(() => parseRecipients('a@b.com\r\nBcc: x@y.com'), /Invalid email/);
});

test('reports job writes due schedules to the outbox when SMTP is not configured', async () => {
  assert.equal(typeof t.ctx.jobs.get('reports')?.run, 'function');
  assert.equal((await t.api('GET', '/api/reports/transport')).data.mode, 'outbox');
  const sent = [];
  t.ctx.events.on('reports:sent', e => sent.push(e));
  const a = (await t.api('POST', '/api/reports/schedules', { domainId, name: 'Daily HTML', frequency: 'daily', recipients: ['team@x.com'] })).data;
  const b = (await t.api('POST', '/api/reports/schedules', { domainId, name: 'CSV weekly', frequency: 'weekly', format: 'csv', recipients: ['csv@x.com'] })).data;
  await t.api('POST', '/api/reports/schedules', { domainId, name: 'Off', recipients: ['off@x.com'], enabled: false });

  const log = console.log; console.log = () => {};
  let r;
  try { r = await t.ctx.jobs.get('reports').run(t.ctx); } finally { console.log = log; }
  assert.deepEqual(r.sent, [a.id, b.id]);
  const files = fs.readdirSync(outbox);
  const html = files.filter(f => f.endsWith('.html'));
  assert.equal(html.length, 2);
  assert.equal(files.filter(f => f.endsWith('.csv')).length, 1);
  const daily = fs.readFileSync(path.join(outbox, html.find(f => f.includes('daily-html'))), 'utf8');
  assert.match(daily, /To: team@x\.com/);
  assert.match(daily, /<svg/);
  assert.deepEqual(sent.map(e => e.scheduleId), [a.id, b.id]);
  assert.equal(sent[0].transport, 'outbox');
  const after = (await t.api('GET', `/api/reports/schedules/${a.id}`)).data;
  assert.ok(after.lastSentAt && after.nextDueAt > after.lastSentAt);

  // Not due again until the period has passed.
  assert.deepEqual((await runDueSchedules(t.ctx)).sent, []);
  console.log = () => {};
  try { assert.deepEqual((await runDueSchedules(t.ctx, new Date(Date.now() + 864e5 + 1000))).sent, [a.id]); } finally { console.log = log; }
});

test('send now delivers over SMTP when configured', async () => {
  const got = { rcpt: [], data: '', auth: '' };
  const srv = net.createServer(sock => {
    let inData = false, buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', d => {
      buf += d;
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else got.data += line + '\n'; continue; }
        if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) { got.auth = line; sock.write('235 ok\r\n'); }
        else if (/^RCPT TO/.test(line)) { got.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.end('221 bye\r\n'); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(srv.address().port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'Ranklight <rl@x.com>' });
  try {
    assert.equal((await t.api('GET', '/api/reports/transport')).data.mode, 'smtp');
    const s = (await t.api('POST', '/api/reports/schedules', { domainId, name: 'Printable', format: 'pdf-html', recipients: ['x@y.com', 'z@y.com'] })).data;
    const r = await t.api('POST', `/api/reports/schedules/${s.id}/send`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.transport, 'smtp');
    assert.deepEqual(got.rcpt, ['RCPT TO:<x@y.com>', 'RCPT TO:<z@y.com>']);
    assert.equal(got.auth, `AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`);
    assert.match(got.data, /Subject: Printable: example\.com/);
    assert.match(got.data, /multipart\/mixed/);
    assert.match(got.data, /filename="example-com-\d{4}-\d{2}-\d{2}\.html"/);
    assert.ok(r.data.schedule.lastSentAt);

    process.env.SMTP_PORT = '1';   // connection refused -> 502 and lastError recorded
    const err = console.error; console.error = () => {};
    const f = await t.api('POST', `/api/reports/schedules/${s.id}/send`).finally(() => { console.error = err; });
    assert.equal(f.status, 502);
    assert.ok((await t.api('GET', `/api/reports/schedules/${s.id}`)).data.lastError);
  } finally {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k];
    srv.close();
  }
});

test('buildMime encodes non-ASCII subjects and strips header newlines', () => {
  const m = buildMime({ from: 'a@b.c', to: ['x@y.z'], subject: 'Rapport för\r\nBcc: evil@x.com', html: '<p>hi</p>' });
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.ok(!/^Bcc:/m.test(m));
});
