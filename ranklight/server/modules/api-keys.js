// API keys: personal keys for the public REST API.
// Clients send "x-api-key: rl_<secret>"; the key authenticates as its owner on every /api route.
// Only a SHA-256 hash of each key is stored; the full key is returned once, at creation.
// Routes: GET / (list), POST / (create), PATCH /:id (rename), POST /:id/revoke, DELETE /:id, GET /docs (public).
import crypto from 'node:crypto';
import { httpError, requireAuth } from '../lib/http.js';

export const KEY_PREFIX = 'rl_';
const MAX_ACTIVE_KEYS = 25;
const MAX_NAME = 80;
const TOUCH_INTERVAL_MS = 60_000; // last_used_at is written at most once per minute per key

export const hashKey = key => crypto.createHash('sha256').update(key).digest('hex');
export function generateKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 8) };
}

const P = (name, inn, description, required = false) => ({ name, in: inn, required, description });
const domainQ = P('domainId', 'query', 'Domain id', true);
// Documented public endpoints. `module` names the server module that serves it ('core' is always present).
export const DOCS = [
  { module: 'core', method: 'GET', path: '/api/auth/me', summary: 'The user the key belongs to.' },
  { module: 'domains', method: 'GET', path: '/api/domains', summary: 'List your tracked domains.' },
  { module: 'domains', method: 'POST', path: '/api/domains', summary: 'Add a domain.', body: { host: 'example.com', display_name: 'Example' } },
  { module: 'domains', method: 'GET', path: '/api/domains/:id', summary: 'One domain.', params: [P('id', 'path', 'Domain id', true)] },
  { module: 'domains', method: 'PATCH', path: '/api/domains/:id', summary: 'Update domain settings.', params: [P('id', 'path', 'Domain id', true)], body: { display_name: 'New name' } },
  { module: 'domains', method: 'DELETE', path: '/api/domains/:id', summary: 'Delete a domain and all its data.', params: [P('id', 'path', 'Domain id', true)] },
  { module: 'keywords', method: 'GET', path: '/api/keywords', summary: 'Keywords with latest rank, change and volume (paginated).',
    params: [domainQ, P('page', 'query', 'Page number, default 1'), P('pageSize', 'query', 'Rows per page, 1-500, default 50'), P('sort', 'query', 'Sort column, e.g. phrase or rank'), P('order', 'query', 'asc or desc'), P('device', 'query', 'desktop or mobile')] },
  { module: 'keywords', method: 'POST', path: '/api/keywords', summary: 'Add keywords to a domain.', body: { domainId: 1, phrases: ['rank tracker', 'seo tool'], devices: ['desktop', 'mobile'] } },
  { module: 'keywords', method: 'DELETE', path: '/api/keywords/:id', summary: 'Delete a keyword.', params: [P('id', 'path', 'Keyword id', true)] },
  { module: 'keyword-history', method: 'GET', path: '/api/keyword-history/:keywordId', summary: 'Rank history for one keyword.', params: [P('keywordId', 'path', 'Keyword id', true), P('days', 'query', 'Days of history')] },
  { module: 'overview', method: 'GET', path: '/api/overview', summary: 'Dashboard KPIs for a domain.', params: [domainQ] },
  { module: 'share-of-voice', method: 'GET', path: '/api/share-of-voice', summary: 'Share of voice for a domain and its competitors.', params: [domainQ] },
  { module: 'serp-features', method: 'GET', path: '/api/serp-features', summary: 'SERP feature presence and ownership.', params: [domainQ] },
  { module: 'competitors', method: 'GET', path: '/api/competitors', summary: 'Competitors of a domain.', params: [domainQ] },
  { module: 'landing-pages', method: 'GET', path: '/api/landing-pages', summary: 'Ranking URLs with their keywords.', params: [domainQ] },
  { module: 'tags', method: 'GET', path: '/api/tags', summary: 'Tags of a domain.', params: [domainQ] },
  { module: 'exports', method: 'GET', path: '/api/exports/keywords.csv', summary: 'Keywords with latest ranks as CSV.', params: [domainQ] },
  { module: 'scheduler', method: 'POST', path: '/api/scheduler/refresh', summary: 'Re-check ranks now for a domain or keywords.', body: { domainId: 1 } },
];

export default {
  name: 'api-keys',
  setup({ db, authResolvers }) {
    const find = db.prepare(`SELECT k.id AS key_id, k.last_used_at, u.id, u.email, u.name, u.role, u.organization_id
                             FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.revoked = 0`);
    const touch = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
    authResolvers.push(req => {
      const key = req.headers['x-api-key'];
      if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length > 200) return null;
      const row = find.get(hashKey(key));
      if (!row) return null;
      const now = new Date();
      if (!row.last_used_at || now - new Date(row.last_used_at) > TOUCH_INTERVAL_MS) touch.run(now.toISOString(), row.key_id);
      req.apiKeyId = row.key_id;
      const { key_id, last_used_at, ...user } = row;
      return user;
    });
  },
  router({ db, express }) {
    const r = express.Router();
    const COLS = 'id, name, prefix, last_used_at AS lastUsedAt, created_at AS createdAt, revoked';
    const out = k => ({ ...k, revoked: !!k.revoked });
    const one = (req, id) => {
      const n = Number(id);
      const k = Number.isInteger(n) && n > 0 && db.prepare(`SELECT ${COLS} FROM api_keys WHERE id = ? AND user_id = ?`).get(n, req.user.id);
      if (!k) throw httpError(404, 'API key not found');
      return k;
    };
    const readName = b => {
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (!name) throw httpError(400, 'name is required');
      if (name.length > MAX_NAME) throw httpError(400, `name must be at most ${MAX_NAME} characters`);
      return name;
    };

    r.get('/docs', (_req, res) => res.json(DOCS));

    r.use(requireAuth);
    // Keys cannot be managed with a key: a leaked key must not be able to mint more keys or hide itself.
    r.use((req, _res, next) => next(req.apiKeyId ? httpError(403, 'API keys can only be managed from a signed-in session') : undefined));

    r.get('/', (req, res) => {
      res.json(db.prepare(`SELECT ${COLS} FROM api_keys WHERE user_id = ? ORDER BY revoked, id DESC`).all(req.user.id).map(out));
    });
    r.post('/', (req, res) => {
      const name = readName(req.body);
      const active = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked = 0').get(req.user.id).n;
      if (active >= MAX_ACTIVE_KEYS) throw httpError(409, `At most ${MAX_ACTIVE_KEYS} active API keys; revoke one first`);
      const { key, hash, prefix } = generateKey();
      const { lastInsertRowid } = db.prepare('INSERT INTO api_keys(user_id, name, key_hash, prefix, created_at) VALUES (?,?,?,?,?)')
        .run(req.user.id, name, hash, prefix, new Date().toISOString());
      res.status(201).json({ ...out(one(req, Number(lastInsertRowid))), key });
    });
    r.get('/:id', (req, res) => res.json(out(one(req, req.params.id))));
    r.patch('/:id', (req, res) => {
      const k = one(req, req.params.id);
      db.prepare('UPDATE api_keys SET name = ? WHERE id = ? AND user_id = ?').run(readName(req.body), k.id, req.user.id);
      res.json(out(one(req, k.id)));
    });
    r.post('/:id/revoke', (req, res) => {
      const k = one(req, req.params.id);
      db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?').run(k.id, req.user.id);
      res.json(out(one(req, k.id)));
    });
    r.delete('/:id', (req, res) => {
      const k = one(req, req.params.id);
      db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(k.id, req.user.id);
      res.json({ ok: true, id: k.id });
    });
    return r;
  },
};
