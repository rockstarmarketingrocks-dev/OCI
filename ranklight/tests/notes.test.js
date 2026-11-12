import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { notesFor, parseDate } from '../server/modules/notes.js';

let t, user, token, domainId, kw;
const q = (path = '', d = domainId, extra = '') => `/api/notes${path}?domainId=${d}${extra}`;

before(async () => {
  t = await startTestServer({ modules: ['notes'] });
  ({ user, token } = await t.signup());
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker']));
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank) VALUES (?,?,?)').run(kw[0], '2026-03-01T00:00:00Z', 7);
});
after(() => t.close());

test('parseDate validates calendar dates', () => {
  assert.equal(parseDate('2026-02-28'), '2026-02-28');
  assert.equal(parseDate('2026-02-28T12:00:00Z'), '2026-02-28');
  assert.throws(() => parseDate('2026-02-30'), /valid date/);
  assert.throws(() => parseDate('yesterday'), /valid date/);
  assert.throws(() => parseDate(''), /required/);
  assert.equal(parseDate('', 'from', { required: false }), null);
});

test('create, list with range filters, get, update, delete', async () => {
  const events = [];
  t.ctx.events.on('notes:changed', e => events.push(e));

  const a = await t.api('POST', q(), { date: '2026-03-01', text: '  Site migration  ' });
  assert.equal(a.status, 201);
  assert.equal(a.data.text, 'Site migration');
  assert.equal(a.data.keywordId, null);
  assert.equal(a.data.createdBy, user.id);
  assert.equal(a.data.createdByName, 'Test');

  const b = await t.api('POST', '/api/notes', { domainId, date: '2026-03-10', text: 'New title tag', keywordId: kw[1] });
  assert.equal(b.status, 201);
  assert.equal(b.data.keyword, 'rank tracker');

  const all = await t.api('GET', q());
  assert.deepEqual(all.data.map(n => n.id), [b.data.id, a.data.id]);
  assert.deepEqual((await t.api('GET', q('', domainId, '&from=2026-03-05'))).data.map(n => n.id), [b.data.id]);
  assert.deepEqual((await t.api('GET', q('', domainId, '&to=2026-03-01'))).data.map(n => n.id), [a.data.id]);
  assert.deepEqual((await t.api('GET', q('', domainId, `&keywordId=${kw[1]}`))).data.map(n => n.id), [b.data.id]);

  assert.equal((await t.api('GET', `/api/notes/${a.data.id}`)).data.date, '2026-03-01');

  const up = await t.api('PATCH', `/api/notes/${a.data.id}`, { text: 'Migrated to https', keywordId: kw[0] });
  assert.equal(up.status, 200);
  assert.equal(up.data.text, 'Migrated to https');
  assert.equal(up.data.keyword, 'seo tool');
  assert.equal(up.data.date, '2026-03-01');
  assert.ok(up.data.updatedAt);
  const unlink = await t.api('PATCH', `/api/notes/${a.data.id}`, { keywordId: null });
  assert.equal(unlink.data.keywordId, null);

  assert.deepEqual(notesFor(t.ctx.db, domainId, { from: '2026-03-01', to: '2026-03-31' }).map(n => n.id), [b.data.id, a.data.id]);

  assert.deepEqual((await t.api('DELETE', `/api/notes/${b.data.id}`)).data, { ok: true });
  assert.equal((await t.api('GET', `/api/notes/${b.data.id}`)).status, 404);
  assert.deepEqual(events.map(e => e.action), ['created', 'created', 'updated', 'updated', 'deleted']);
  assert.equal(events[0].domainId, domainId);
});

test('keyword picker lists domain keywords', async () => {
  const r = await t.api('GET', q('/keywords'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map(k => k.phrase), ['rank tracker', 'seo tool']);
});

test('validation errors', async () => {
  const bad = async (method, url, body, re, status = 400) => {
    const r = await t.api(method, url, body);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.match(r.data.error, re);
  };
  await bad('GET', '/api/notes', undefined, /domainId/);
  await bad('GET', '/api/notes?domainId=abc', undefined, /domainId/);
  await bad('GET', q('', domainId, '&from=2026-13-01'), undefined, /from/);
  await bad('GET', q('', domainId, '&from=2026-03-10&to=2026-03-01'), undefined, /after/);
  await bad('POST', q(), { text: 'x' }, /date is required/);
  await bad('POST', q(), { date: '2026-03-01', text: '   ' }, /text is required/);
  await bad('POST', q(), { date: '2026-03-01', text: 'x'.repeat(2001) }, /at most/);
  await bad('POST', q(), { date: '2026-03-01', text: 'x', keywordId: 'abc' }, /keywordId/);
  const n = await t.api('POST', q(), { date: '2026-04-01', text: 'ok' });
  await bad('PATCH', `/api/notes/${n.data.id}`, {}, /Nothing to update/);
  await bad('PATCH', `/api/notes/${n.data.id}`, { date: 'nope' }, /date/);
  await bad('GET', '/api/notes/xyz', undefined, /id/);
});

test('keyword deletion keeps the note unlinked', async () => {
  const n = await t.api('POST', q(), { date: '2026-05-01', text: 'kw note', keywordId: kw[1] });
  t.ctx.db.prepare('DELETE FROM keywords WHERE id = ?').run(kw[1]);
  const r = await t.api('GET', `/api/notes/${n.data.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.keywordId, null);
});

test('notes are scoped to the owner', async () => {
  const mine = await t.api('POST', q(), { date: '2026-06-01', text: 'private' });
  const other = await t.signup();
  const { domainId: otherDomain, keywordIds: otherKw } = t.seedDomain(other.user.id, 'other.com', ['x']);
  assert.equal((await t.api('GET', q('', domainId))).status, 404);
  assert.equal((await t.api('GET', `/api/notes/${mine.data.id}`)).status, 404);
  assert.equal((await t.api('PATCH', `/api/notes/${mine.data.id}`, { text: 'hacked' })).status, 404);
  assert.equal((await t.api('DELETE', `/api/notes/${mine.data.id}`)).status, 404);
  assert.equal((await t.api('POST', q('', domainId), { date: '2026-06-01', text: 'x' })).status, 404);
  // Cannot link a keyword from another account's domain.
  t.setToken(other.token);
  const cross = await t.api('POST', q('', otherDomain), { date: '2026-06-01', text: 'x', keywordId: kw[0] });
  assert.equal(cross.status, 400);
  assert.equal((await t.api('POST', q('', otherDomain), { date: '2026-06-01', text: 'x', keywordId: otherKw[0] })).status, 201);
  t.setToken(token);
  assert.equal((await t.api('GET', `/api/notes/${mine.data.id}`)).data.text, 'private');
  assert.equal((await t.api('GET', '/api/notes')).status, 400);
  t.setToken(null);
  assert.equal((await t.api('GET', q())).status, 401);
  t.setToken(token);
});
