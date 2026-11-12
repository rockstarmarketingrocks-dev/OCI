import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { normalizeHost } from '../server/modules/domains.js';

test('normalizeHost strips scheme, www, port, path and rejects junk', () => {
  assert.equal(normalizeHost('https://www.Example.com:8080/a/b?q=1'), 'example.com');
  assert.equal(normalizeHost('  shop.example.co.uk/path '), 'shop.example.co.uk');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  for (const bad of ['', 'localhost', 'not a host', 'http://', 'exa_mple.com', null]) assert.equal(normalizeHost(bad), '', String(bad));
});

test('domain CRUD, stats, pause/resume, events and scoping', async () => {
  const s = await startTestServer({ modules: ['domains'] });
  try {
    assert.equal((await s.api('GET', '/api/domains')).status, 401);
    const { user } = await s.signup('owner@test.dev');
    const created = [];
    s.ctx.events.on('domain:created', p => created.push(p));

    let r = await s.api('POST', '/api/domains', { host: 'https://www.Acme.io/blog', default_country: 'gb', default_language: 'EN', group_name: 'Clients', include_subdomains: false });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const d = r.data;
    assert.equal(d.host, 'acme.io');
    assert.equal(d.display_name, 'acme.io');
    assert.equal(d.default_country, 'GB');
    assert.equal(d.default_language, 'en');
    assert.equal(d.include_subdomains, false);
    assert.equal(d.keyword_count, 0);
    assert.equal(d.avg_rank, null);
    assert.deepEqual(created, [{ domainId: d.id, userId: user.id }]);

    // validation
    assert.equal((await s.api('POST', '/api/domains', { host: 'acme.io' })).status, 409);
    assert.equal((await s.api('POST', '/api/domains', { host: 'nope' })).status, 400);
    assert.equal((await s.api('POST', '/api/domains', { host: 'ok.com', default_country: 'USA' })).status, 400);
    assert.equal((await s.api('POST', '/api/domains', { host: 'ok.com', include_subdomains: 'yes' })).status, 400);
    assert.equal((await s.api('PATCH', `/api/domains/${d.id}`, {})).status, 400);

    // stats from latest snapshots per keyword
    const kw = ['a', 'b', 'c'].map(p => Number(s.ctx.db.prepare('INSERT INTO keywords(domain_id, phrase) VALUES (?,?)').run(d.id, p).lastInsertRowid));
    const snap = s.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank) VALUES (?,?,?)');
    snap.run(kw[0], '2026-01-01T00:00:00Z', 20);
    snap.run(kw[0], '2026-01-02T00:00:00Z', 4);
    snap.run(kw[1], '2026-01-02T00:00:00Z', 7);
    snap.run(kw[2], '2026-01-03T00:00:00Z', null);
    r = await s.api('GET', `/api/domains/${d.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.keyword_count, 3);
    assert.equal(r.data.ranked_count, 2);
    assert.equal(r.data.avg_rank, 5.5);
    assert.equal(r.data.last_checked_at, '2026-01-03T00:00:00Z');

    // list grouped/sorted, with stats
    await s.api('POST', '/api/domains', { host: 'beta.com' });
    r = await s.api('GET', '/api/domains');
    assert.deepEqual(r.data.map(x => [x.group_name, x.host, x.keyword_count]), [['Clients', 'acme.io', 3], ['Default', 'beta.com', 0]]);

    // patch
    r = await s.api('PATCH', `/api/domains/${d.id}`, { display_name: 'Acme', host: 'acme.com', default_location: 'London', include_subdomains: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.display_name, 'Acme');
    assert.equal(r.data.host, 'acme.com');
    assert.equal(r.data.default_location, 'London');
    assert.equal(r.data.include_subdomains, true);
    assert.equal(r.data.keyword_count, 3);
    assert.equal((await s.api('PATCH', `/api/domains/${d.id}`, { host: 'beta.com' })).status, 409);

    // pause / resume
    assert.equal((await s.api('POST', `/api/domains/${d.id}/pause`)).data.paused, true);
    assert.equal((await s.api('POST', `/api/domains/${d.id}/resume`)).data.paused, false);

    // another user cannot see or touch it, and can register the same host
    await s.signup('other@test.dev');
    assert.deepEqual((await s.api('GET', '/api/domains')).data, []);
    for (const [m, u] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/pause']]) {
      assert.equal((await s.api(m, `/api/domains/${d.id}${u}`, m === 'PATCH' ? { display_name: 'x' } : undefined)).status, 404, m + u);
    }
    assert.equal((await s.api('POST', '/api/domains', { host: 'acme.com' })).status, 201);
    assert.equal((await s.api('GET', '/api/domains/abc')).status, 404);

    // delete cascades keywords
    s.setToken(null);
    const login = await s.api('POST', '/api/auth/login', { email: 'owner@test.dev', password: 'password123' });
    s.setToken(login.data.token);
    assert.equal((await s.api('DELETE', `/api/domains/${d.id}`)).status, 200);
    assert.equal((await s.api('GET', `/api/domains/${d.id}`)).status, 404);
    assert.equal(s.ctx.db.prepare('SELECT COUNT(*) n FROM keywords WHERE domain_id = ?').get(d.id).n, 0);
  } finally { s.close(); }
});
