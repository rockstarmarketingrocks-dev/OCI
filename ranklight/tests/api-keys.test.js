import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { hashKey, generateKey, DOCS } from '../server/modules/api-keys.js';

let t, user, token;
const withKey = key => ({ 'x-api-key': key });
// Calls without the session token so only the API key authenticates.
async function asKey(method, url, key, body) {
  t.setToken(null);
  try { return await t.api(method, url, body, withKey(key)); } finally { t.setToken(token); }
}

before(async () => {
  t = await startTestServer({ modules: ['api-keys'] });
  ({ user, token } = await t.signup());
});
after(() => t.close());

test('generateKey produces rl_ keys and stores only a hash', () => {
  const { key, hash, prefix } = generateKey();
  assert.match(key, /^rl_[A-Za-z0-9_-]{43}$/);
  assert.equal(hash, hashKey(key));
  assert.equal(prefix, key.slice(0, 11));
});

test('create key, authenticate /api/auth/me with x-api-key, full key shown once', async () => {
  const c = await t.api('POST', '/api/api-keys', { name: '  CI pipeline ' });
  assert.equal(c.status, 201);
  assert.equal(c.data.name, 'CI pipeline');
  assert.match(c.data.key, /^rl_/);
  assert.equal(c.data.prefix, c.data.key.slice(0, 11));
  assert.equal(c.data.revoked, false);
  assert.equal(c.data.lastUsedAt, null);

  const row = t.ctx.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(c.data.id);
  assert.equal(row.key_hash, hashKey(c.data.key));
  assert.ok(!JSON.stringify(row).includes(c.data.key));

  const me = await asKey('GET', '/api/auth/me', c.data.key);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, user.id);
  assert.equal(me.data.user.email, user.email);

  const list = await t.api('GET', '/api/api-keys');
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].key, undefined);
  assert.ok(list.data[0].lastUsedAt);
  assert.equal((await t.api('GET', `/api/api-keys/${c.data.id}`)).data.key, undefined);
});

test('invalid, unknown and revoked keys are rejected', async () => {
  assert.equal((await asKey('GET', '/api/auth/me', 'rl_nope')).status, 401);
  assert.equal((await asKey('GET', '/api/auth/me', 'not-a-key')).status, 401);

  const c = await t.api('POST', '/api/api-keys', { name: 'Temp' });
  assert.equal((await asKey('GET', '/api/auth/me', c.data.key)).status, 200);
  const rv = await t.api('POST', `/api/api-keys/${c.data.id}/revoke`);
  assert.equal(rv.status, 200);
  assert.equal(rv.data.revoked, true);
  assert.equal((await asKey('GET', '/api/auth/me', c.data.key)).status, 401);
});

test('rename, delete, validation and per-user scoping', async () => {
  const c = await t.api('POST', '/api/api-keys', { name: 'Zapier' });
  assert.equal((await t.api('POST', '/api/api-keys', {})).status, 400);
  assert.equal((await t.api('POST', '/api/api-keys', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await t.api('PATCH', `/api/api-keys/${c.data.id}`, { name: '' })).status, 400);
  const up = await t.api('PATCH', `/api/api-keys/${c.data.id}`, { name: 'Looker' });
  assert.equal(up.data.name, 'Looker');
  assert.equal((await t.api('GET', '/api/api-keys/abc')).status, 404);

  // Another user cannot see or touch these keys, and a key cannot manage keys.
  const mine = token;
  await t.signup();
  const other = (await t.api('GET', '/api/api-keys')).data;
  assert.deepEqual(other, []);
  assert.equal((await t.api('DELETE', `/api/api-keys/${c.data.id}`)).status, 404);
  assert.equal((await t.api('POST', `/api/api-keys/${c.data.id}/revoke`)).status, 404);
  t.setToken(mine); token = mine;
  assert.equal((await asKey('GET', '/api/api-keys', c.data.key)).status, 403);
  assert.equal((await asKey('POST', '/api/api-keys', c.data.key, { name: 'escalate' })).status, 403);

  const d = await t.api('DELETE', `/api/api-keys/${c.data.id}`);
  assert.deepEqual(d.data, { ok: true, id: c.data.id });
  assert.equal((await asKey('GET', '/api/auth/me', c.data.key)).status, 401);
  assert.equal((await t.api('GET', `/api/api-keys/${c.data.id}`)).status, 404);
});

test('unauthenticated management is rejected; docs are public', async () => {
  t.setToken(null);
  try {
    assert.equal((await t.api('GET', '/api/api-keys')).status, 401);
    const docs = await t.api('GET', '/api/api-keys/docs');
    assert.equal(docs.status, 200);
    assert.ok(Array.isArray(docs.data));
    assert.equal(docs.data.length, DOCS.length);
    const me = docs.data.find(e => e.path === '/api/auth/me');
    assert.equal(me.method, 'GET');
    assert.equal(me.module, 'core');
    for (const e of docs.data) {
      assert.match(e.method, /^(GET|POST|PATCH|PUT|DELETE)$/);
      assert.match(e.path, /^\/api\//);
      assert.ok(e.summary);
    }
  } finally { t.setToken(token); }
});
