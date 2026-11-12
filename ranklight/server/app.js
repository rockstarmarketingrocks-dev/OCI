// App factory. Feature modules in server/modules/*.js are auto-mounted at /api/<name>.
// A module default-exports: { name: 'kebab-name', setup?(ctx), router(ctx) -> express.Router }
// ctx = { db, express, events, authResolvers, jobs, provider }
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { openDb } from './db.js';
import { sessionMiddleware, hashPassword, verifyPassword, createSession } from './lib/auth.js';
import { errorHandler, httpError, requireAuth } from './lib/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function createApp({ dbFile, modules: only } = {}) {
  // `only`: optional array of module file basenames (without .js) to load; used by tests to isolate modules.
  const db = openDb(dbFile);
  const app = express();
  // Shared event bus. Conventions: 'ranks:updated' {keywordIds, domainId}, 'keywords:added' {domainId, keywordIds}
  const events = new EventEmitter();
  const authResolvers = [];      // modules may push (req) => user|null (e.g. API keys)
  const jobs = new Map();        // name -> async fn(ctx); scheduler module runs them
  const ctx = { db, express, events, authResolvers, jobs, provider: null };

  app.use(express.json({ limit: '5mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));
  app.use(sessionMiddleware(db, authResolvers));

  // ---- Core auth routes ----
  const auth = express.Router();
  auth.post('/signup', (req, res) => {
    const { email, password, name = '' } = req.body || {};
    if (!email || !password || password.length < 8) throw httpError(400, 'Email and a password of 8+ characters are required');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'Email already registered');
    const { lastInsertRowid } = db.prepare('INSERT INTO users(email, name, password_hash) VALUES (?,?,?)').run(email.toLowerCase(), name, hashPassword(password));
    const token = createSession(db, Number(lastInsertRowid));
    res.setHeader('Set-Cookie', `rl_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
    res.status(201).json({ token, user: { id: Number(lastInsertRowid), email: email.toLowerCase(), name } });
  });
  auth.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!u || !verifyPassword(password || '', u.password_hash)) throw httpError(401, 'Invalid email or password');
    const token = createSession(db, u.id);
    res.setHeader('Set-Cookie', `rl_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ token, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  });
  auth.post('/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.setHeader('Set-Cookie', 'rl_session=; Path=/; Max-Age=0');
    res.json({ ok: true });
  });
  auth.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
  app.use('/api/auth', auth);

  // ---- Feature modules ----
  const modDir = path.join(here, 'modules');
  const files = fs.readdirSync(modDir).filter(f => f.endsWith('.js') && (!only || only.includes(f.slice(0, -3)))).sort();
  const mods = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(modDir, f)).href)).default;
    if (!mod?.name) throw new Error(`Module ${f} must default-export { name, router }`);
    mods.push(mod);
  }
  for (const m of mods) await m.setup?.(ctx);           // setup first: providers, jobs, resolvers
  for (const m of mods) if (m.router) app.use(`/api/${m.name}`, m.router(ctx));

  // Frontend page discovery: public/js/pages/*.js
  app.get('/api/_meta/pages', (_req, res) => {
    const dir = path.join(here, '..', 'public', 'js', 'pages');
    res.json(fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort());
  });
  app.get('/api/_meta/modules', (_req, res) => res.json(mods.map(m => m.name)));

  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));
  app.use(express.static(path.join(here, '..', 'public')));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(here, '..', 'public', 'index.html')) : next()));
  app.use(errorHandler);
  return { app, ctx };
}
