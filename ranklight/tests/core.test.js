import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('core auth flow', async () => {
  const s = await startTestServer();
  try {
    const { user } = await s.signup('a@b.co');
    assert.equal(user.email, 'a@b.co');
    const me = await s.api('GET', '/api/auth/me');
    assert.equal(me.status, 200);
    s.setToken(null);
    assert.equal((await s.api('GET', '/api/auth/me')).status, 401);
  } finally { s.close(); }
});
