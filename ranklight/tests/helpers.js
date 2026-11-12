// Test helpers: spin up an app on an ephemeral port with an in-memory DB.
import { createApp } from '../server/app.js';

// opts.modules: array of module names to load (default: all). Load only what your test needs.
export async function startTestServer({ modules } = {}) {
  const { app, ctx } = await createApp({ dbFile: ':memory:', modules });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = null;
  async function api(method, url, body, headers = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string') { payload = body; h['content-type'] ||= 'text/csv'; }
      else { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  async function signup(email = `u${Math.floor(performance.now()*1000)}@test.dev`) {
    const r = await api('POST', '/api/auth/signup', { email, password: 'password123', name: 'Test' });
    token = r.data.token; return r.data;
  }
  // Creates a domain + keywords directly in the DB for the logged-in user.
  function seedDomain(userId, host = 'example.com', phrases = ['seo tool', 'rank tracker']) {
    const d = ctx.db.prepare('INSERT INTO domains(user_id, host, display_name) VALUES (?,?,?)').run(userId, host, host);
    const domainId = Number(d.lastInsertRowid);
    const keywordIds = phrases.map(p => Number(ctx.db.prepare('INSERT INTO keywords(domain_id, phrase) VALUES (?,?)').run(domainId, p).lastInsertRowid));
    return { domainId, keywordIds };
  }
  return { base, ctx, api, signup, seedDomain, setToken: t => (token = t), close: () => server.close() };
}
