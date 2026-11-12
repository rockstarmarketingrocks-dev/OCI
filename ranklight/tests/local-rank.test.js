import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { LOCATIONS, gridPoints, resolveLocation } from '../server/modules/local-rank.js';

let t, user, domainId, kw;
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();
const snap = (kid, n, rank, serp = [], owned = [], results = []) =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, serp_features, owned_features, results) VALUES (?,?,?,?,?,?)')
    .run(kid, daysAgo(n), rank, JSON.stringify(serp), JSON.stringify(owned), JSON.stringify(results));

before(async () => {
  t = await startTestServer({ modules: ['local-rank'] });
  user = (await t.signup()).user;
  ({ domainId, keywordIds: kw } = t.seedDomain(user.id, 'example.com', ['plumber', 'dentist', 'cafe', 'gym']));
  const set = t.ctx.db.prepare('UPDATE keywords SET country = ?, location = ? WHERE id = ?');
  set.run('US', 'Austin', kw[0]); set.run('US', 'Austin', kw[1]); set.run('GB', 'London', kw[2]);
  // plumber: owns local pack (2nd pack slot via sub.example.com). Older snapshot must be ignored.
  snap(kw[0], 5, 40, []);
  snap(kw[0], 1, 4, ['local_pack', 'people_also_ask'], [], [
    { position: 1, host: 'other.com', type: 'local_pack' }, { position: 1, host: 'sub.example.com', type: 'local_pack' },
    { position: 4, host: 'example.com', type: 'organic' }]);
  // dentist: local pack present, flagged owned without results, rank 12.
  snap(kw[1], 1, 12, ['local_pack'], ['local_pack']);
  // cafe: local pack not owned, rank 2. gym: unchecked.
  snap(kw[2], 1, 2, ['local_pack'], [], [{ position: 1, host: 'rival.co.uk', type: 'local_pack' }]);
});
after(() => t.close());

test('catalog has countries and cities with coordinates', () => {
  assert.ok(LOCATIONS.countries.length >= 35 && LOCATIONS.cities.length >= 140);
  const codes = new Set(LOCATIONS.countries.map(c => c.code));
  for (const c of LOCATIONS.cities) {
    assert.ok(codes.has(c.country), `${c.name} has known country`);
    assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180);
  }
  assert.deepEqual(resolveLocation('us', 'austin, tx').name, 'Austin');
  assert.equal(resolveLocation('DE', '').name, 'Germany');
  assert.equal(resolveLocation('ZZ', 'Nowhere'), null);
});

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/local-rank/locations?q=lon')).status, 401);
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0] })).status, 401);
  t.setToken(token);
});

test('locations autocomplete', async () => {
  const r = await t.api('GET', '/api/local-rank/locations?q=lon');
  assert.equal(r.status, 200);
  assert.equal(r.data.results[0].name, 'London');
  assert.equal(r.data.results[0].type, 'city');
  const de = await t.api('GET', '/api/local-rank/locations?country=de&q=');
  assert.ok(de.data.results.every(x => x.country === 'DE'));
  assert.equal(de.data.results[0].type, 'country');
  const sp = await t.api('GET', '/api/local-rank/locations?q=sao');
  assert.ok(sp.data.results.some(x => x.name === 'São Paulo'));
  assert.equal((await t.api('GET', '/api/local-rank/locations?country=USA')).status, 400);
  assert.equal((await t.api('GET', '/api/local-rank/locations?limit=0')).status, 400);
});

test('map pack ownership and position', async () => {
  assert.equal((await t.api('GET', '/api/local-rank/map-pack')).status, 400);
  assert.equal((await t.api('GET', '/api/local-rank/map-pack?domainId=999')).status, 404);
  const r = await t.api('GET', `/api/local-rank/map-pack?domainId=${domainId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 3);
  assert.equal(r.data.owned, 2);
  const by = Object.fromEntries(r.data.keywords.map(k => [k.phrase, k]));
  assert.deepEqual([by.plumber.owned, by.plumber.packPosition], [true, 2]);
  assert.deepEqual([by.dentist.owned, by.dentist.packPosition], [true, null]);
  assert.deepEqual([by.cafe.owned, by.cafe.packPosition], [false, null]);
  assert.equal(by.gym, undefined);
});

test('rank by location', async () => {
  const r = await t.api('GET', `/api/local-rank/by-location?domainId=${domainId}`);
  assert.equal(r.status, 200);
  const [austin, ...rest] = r.data.locations;
  assert.deepEqual({ ...austin }, { country: 'US', location: 'Austin', keywords: 2, ranked: 2, top10: 1, top3: 0,
    countryName: 'United States', avgRank: 8, lat: 30.2672, lng: -97.7431 });
  const london = rest.find(l => l.location === 'London');
  assert.deepEqual([london.avgRank, london.top3, london.countryName], [2, 1, 'United Kingdom']);
  const national = rest.find(l => l.location === '' && l.country === 'US');
  assert.deepEqual([national.keywords, national.ranked, national.avgRank], [1, 0, null]);
});

test('grid validation and ownership', async () => {
  const center = { lat: 30.2672, lng: -97.7431 };
  assert.equal((await t.api('POST', '/api/local-rank/grid', { center })).status, 400);
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: 99999, center })).status, 404);
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0] })).status, 400);
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0], center: { lat: 95, lng: 0 } })).status, 400);
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0], center, size: 4 })).status, 400);
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0], center, spacingKm: 0 })).status, 400);
  // another user cannot grid someone else's keyword
  const mine = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  await t.signup();
  assert.equal((await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0], center })).status, 404);
  assert.equal((await t.api('GET', `/api/local-rank/by-location?domainId=${domainId}`)).status, 404);
  t.setToken(mine);
});

test('grid simulates deterministically without a provider', async () => {
  const body = { keywordId: kw[0], center: { lat: 30.2672, lng: -97.7431 }, size: 5, spacingKm: 2 };
  const a = await t.api('POST', '/api/local-rank/grid', body);
  assert.equal(a.status, 200);
  assert.equal(a.data.source, 'simulated');
  assert.equal(a.data.cells.length, 25);
  const mid = a.data.cells.find(c => c.row === 2 && c.col === 2);
  assert.deepEqual([mid.lat, mid.lng], [30.2672, -97.7431]);
  assert.ok(a.data.cells.find(c => c.row === 0 && c.col === 2).lat > mid.lat, 'row 0 is north');
  for (const c of a.data.cells) assert.ok(c.rank === null || (c.rank >= 1 && c.rank <= 100));
  assert.equal(a.data.stats.total, 25);
  const b = await t.api('POST', '/api/local-rank/grid', body);
  assert.deepEqual(b.data.cells, a.data.cells);
});

test('grid uses provider when present', async () => {
  const calls = [];
  t.ctx.provider = { fetchSerp: async opts => {
    calls.push(opts);
    const [lat] = opts.location.split(',').map(Number);
    return { results: [{ position: 1, host: 'example.com', type: 'local_pack' }, { position: lat > 30.27 ? 3 : 7, host: 'www.example.com', type: 'organic' }], features: ['local_pack'] };
  } };
  try {
    const r = await t.api('POST', '/api/local-rank/grid', { keywordId: kw[0], center: { lat: 30.2672, lng: -97.7431 }, size: 3, spacingKm: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.source, 'provider');
    assert.equal(calls.length, 9);
    assert.match(calls[0].location, /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    assert.equal(calls[0].phrase, 'plumber');
    assert.deepEqual(r.data.cells.filter(c => c.row === 0).map(c => c.rank), [3, 3, 3]);
    assert.deepEqual(r.data.cells.filter(c => c.row === 2).map(c => c.rank), [7, 7, 7]);
    assert.ok(r.data.cells.every(c => c.packPosition === 1));
    assert.deepEqual({ ...r.data.stats }, { total: 9, found: 9, top3: 3, top10: 9, avgRank: 5.7 });
  } finally { t.ctx.provider = null; }
});

test('gridPoints spacing', () => {
  const pts = gridPoints({ lat: 0, lng: 179.99 }, 3, 11.132);
  assert.equal(pts.length, 9);
  assert.equal(pts[0].lat, 0.1);
  assert.ok(pts[2].lng < -179, 'wraps antimeridian');
});
