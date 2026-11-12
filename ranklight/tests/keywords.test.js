import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

const day = n => new Date(Date.UTC(2026, 10, 12, 8) - n * 864e5).toISOString();
function snap(db, keywordId, daysAgo, rank, extra = {}) {
  db.prepare(`INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, serp_features, owned_features) VALUES (?,?,?,?,?,?)`)
    .run(keywordId, day(daysAgo), rank, rank ? 'https://example.com/p' : null, JSON.stringify(extra.features || []), JSON.stringify(extra.owned || []));
}

async function setup() {
  const s = await startTestServer({ modules: ['keywords'] });
  const { user } = await s.signup();
  const seeded = s.seedDomain(user.id, 'example.com', ['alpha seo', 'beta tracker', 'gamma rank']);
  return { s, user, ...seeded };
}

test('requires auth and domain ownership', async () => {
  const { s, domainId } = await setup();
  try {
    await s.signup('intruder@test.dev');
    assert.equal((await s.api('GET', `/api/keywords?domainId=${domainId}`)).status, 404);
    s.setToken(null);
    assert.equal((await s.api('GET', `/api/keywords?domainId=${domainId}`)).status, 401);
  } finally { s.close(); }
});

test('grid returns ranks, changes, features, tags; filters, sorts and pages', async () => {
  const { s, domainId, keywordIds: [a, b, c] } = await setup();
  try {
    const db = s.ctx.db;
    snap(db, a, 30, 20); snap(db, a, 7, 10); snap(db, a, 1, 8); snap(db, a, 0, 5, { features: ['featured_snippet', 'video'], owned: ['featured_snippet'] });
    snap(db, b, 1, 3); snap(db, b, 0, null);
    db.prepare('UPDATE keywords SET search_volume = ? WHERE id = ?').run(900, a);
    await s.api('POST', '/api/keywords/bulk', { ids: [a], action: 'addTag', tag: 'Brand' });

    const r = await s.api('GET', `/api/keywords?domainId=${domainId}&sort=rank`);
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 3);
    const [ra, rb, rc] = r.data.rows;
    assert.deepEqual([ra.id, rb.id, rc.id], [a, b, c], 'ranked first, nulls last');
    assert.equal(ra.rank, 5); assert.equal(ra.prev_rank, 8); assert.equal(ra.change, 3);
    assert.equal(ra.change_7d, 5); assert.equal(ra.change_30d, 15);
    assert.deepEqual(ra.serp_features, ['featured_snippet', 'video']);
    assert.deepEqual(ra.owned_features, ['featured_snippet']);
    assert.equal(ra.search_volume, 900);
    assert.deepEqual(ra.tags.map(t => t.name), ['Brand']);
    assert.equal(rb.rank, null); assert.equal(rb.change, -98); assert.equal(rb.change_7d, null);
    assert.equal(rc.change, null); assert.equal(rc.checked_at, null);

    const desc = await s.api('GET', `/api/keywords?domainId=${domainId}&sort=change&order=desc`);
    assert.deepEqual(desc.data.rows.map(x => x.id), [a, b, c]);
    assert.deepEqual((await s.api('GET', `/api/keywords?domainId=${domainId}&q=beta`)).data.rows.map(x => x.id), [b]);
    assert.deepEqual((await s.api('GET', `/api/keywords?domainId=${domainId}&q=%25`)).data.rows, []);
    assert.deepEqual((await s.api('GET', `/api/keywords?domainId=${domainId}&tag=Brand`)).data.rows.map(x => x.id), [a]);
    assert.deepEqual((await s.api('GET', `/api/keywords?domainId=${domainId}&rankMin=1&rankMax=10`)).data.rows.map(x => x.id), [a]);
    assert.deepEqual((await s.api('GET', `/api/keywords?domainId=${domainId}&rankMin=11`)).data.rows.map(x => x.id), [b]);
    const paged = await s.api('GET', `/api/keywords?domainId=${domainId}&pageSize=2&page=2`);
    assert.equal(paged.data.total, 3); assert.equal(paged.data.rows.length, 1);
    assert.equal((await s.api('GET', `/api/keywords?domainId=${domainId}&sort=bogus`)).status, 400);
    assert.equal((await s.api('GET', `/api/keywords?domainId=${domainId}&device=tablet`)).status, 400);
    assert.equal((await s.api('GET', `/api/keywords?domainId=${domainId}&pageSize=0`)).status, 400);

    const tags = await s.api('GET', `/api/keywords/tags?domainId=${domainId}`);
    assert.deepEqual(tags.data.map(t => [t.name, t.count]), [['Brand', 1]]);
  } finally { s.close(); }
});

test('bulk add creates phrase x device, skips duplicates, tags and emits', async () => {
  const { s, domainId } = await setup();
  try {
    const events = [];
    s.ctx.events.on('keywords:added', e => events.push(e));
    const r = await s.api('POST', '/api/keywords', { domainId, text: 'New  Phrase\nalpha seo\n\nnew phrase', devices: ['desktop', 'mobile'], tags: ['Q4', 'Q4 '] });
    assert.equal(r.status, 201);
    assert.equal(r.data.created, 3, 'new phrase x2 + alpha seo mobile');
    assert.equal(r.data.skipped, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { domainId, keywordIds: r.data.keywordIds });
    const mob = await s.api('GET', `/api/keywords?domainId=${domainId}&device=mobile&tag=Q4`);
    assert.deepEqual(mob.data.rows.map(x => x.phrase).sort(), ['alpha seo', 'new phrase']);

    const again = await s.api('POST', '/api/keywords', { domainId, phrases: ['new phrase'], devices: ['desktop'] });
    assert.equal(again.data.created, 0); assert.equal(events.length, 1);

    for (const bad of [{ domainId }, { domainId, phrases: [] }, { domainId, phrases: ['x'], devices: ['tablet'] },
      { domainId, phrases: ['x'], searchEngine: 'altavista' }, { domainId, phrases: ['x'], country: 'USA' }]) {
      assert.equal((await s.api('POST', '/api/keywords', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await s.api('POST', '/api/keywords', { domainId: 9999, phrases: ['x'] })).status, 404);
  } finally { s.close(); }
});

test('patch, delete and bulk actions', async () => {
  const { s, user, domainId, keywordIds: [a, b, c] } = await setup();
  try {
    let r = await s.api('PATCH', `/api/keywords/${a}`, { starred: true, preferred_url: 'https://example.com/x', ignore_local_pack: true, location: 'Austin' });
    assert.equal(r.status, 200);
    assert.equal(r.data.starred, true); assert.equal(r.data.preferred_url, 'https://example.com/x'); assert.equal(r.data.location, 'Austin');
    assert.equal((await s.api('PATCH', `/api/keywords/${a}`, { preferred_url: 'nope' })).status, 400);
    assert.equal((await s.api('PATCH', `/api/keywords/${a}`, {})).status, 400);
    assert.deepEqual((await s.api('GET', `/api/keywords?domainId=${domainId}&starred=1`)).data.rows.map(x => x.id), [a]);

    r = await s.api('POST', '/api/keywords/bulk', { ids: [b, c], action: 'star' });
    assert.equal(r.data.affected, 2);
    r = await s.api('POST', '/api/keywords/bulk', { ids: [a, b], action: 'addTag', tag: 'Core' });
    assert.equal(r.data.affected, 2);
    r = await s.api('POST', '/api/keywords/bulk', { ids: [b], action: 'removeTag', tag: 'Core' });
    assert.equal(r.data.affected, 1);
    assert.equal((await s.api('POST', '/api/keywords/bulk', { ids: [a], action: 'explode' })).status, 400);
    assert.equal((await s.api('POST', '/api/keywords/bulk', { ids: [a, 9999], action: 'star' })).status, 404);

    const d2 = Number(s.ctx.db.prepare('INSERT INTO domains(user_id, host) VALUES (?,?)').run(user.id, 'other.com').lastInsertRowid);
    r = await s.api('POST', '/api/keywords/bulk', { ids: [a], action: 'move', domainId: d2 });
    assert.equal(r.data.affected, 1);
    const moved = await s.api('GET', `/api/keywords?domainId=${d2}`);
    assert.deepEqual(moved.data.rows.map(x => [x.id, x.tags.map(t => t.name)]), [[a, ['Core']]]);

    assert.equal((await s.api('DELETE', `/api/keywords/${b}`)).status, 200);
    assert.equal((await s.api('DELETE', `/api/keywords/${b}`)).status, 404);
    r = await s.api('POST', '/api/keywords/bulk', { ids: [c], action: 'delete' });
    assert.equal(r.data.affected, 1);
    assert.equal((await s.api('GET', `/api/keywords?domainId=${domainId}`)).data.total, 0);
  } finally { s.close(); }
});
