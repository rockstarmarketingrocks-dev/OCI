// Domain CRUD: list (with keyword stats), create, read, update, delete, pause/resume.
// Emits 'domain:created' { domainId, userId } after a domain is inserted.
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/;

// "https://www.Example.com:8080/path?q" -> "example.com". Returns '' when not a valid hostname.
export function normalizeHost(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'http://' + s;
  let host;
  try { host = new URL(s).hostname; } catch { return ''; }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return HOST_RE.test(host) ? host : '';
}

const str = (v, field, max = 200) => {
  if (typeof v !== 'string') throw httpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) throw httpError(400, `${field} must be at most ${max} characters`);
  return t;
};
const bool = (v, field) => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === 0 || v === 1) return v;
  throw httpError(400, `${field} must be a boolean`);
};

// Validates the editable fields present in body; returns column -> value map.
function readFields(body, { create }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'JSON body required');
  const out = {};
  if (create || body.host !== undefined) {
    const host = normalizeHost(body.host);
    if (!host) throw httpError(400, 'A valid host is required, e.g. example.com');
    out.host = host;
  }
  if (body.display_name !== undefined) out.display_name = str(body.display_name, 'display_name');
  if (body.default_country !== undefined) {
    const c = str(body.default_country, 'default_country').toUpperCase();
    if (!COUNTRY_RE.test(c)) throw httpError(400, 'default_country must be a 2-letter country code');
    out.default_country = c;
  }
  if (body.default_location !== undefined) out.default_location = str(body.default_location, 'default_location');
  if (body.default_language !== undefined) {
    const l = str(body.default_language, 'default_language').toLowerCase();
    if (!LANG_RE.test(l)) throw httpError(400, 'default_language must be a language code like "en" or "pt-br"');
    out.default_language = l;
  }
  if (body.group_name !== undefined) out.group_name = str(body.group_name, 'group_name', 80) || 'Default';
  for (const f of ['include_subdomains', 'exact_match', 'paused']) if (body[f] !== undefined) out[f] = bool(body[f], f);
  return out;
}

export default {
  name: 'domains',
  router({ db, express, events }) {
    const r = express.Router();
    r.use(requireAuth);

    // Domains of one user with stats from each keyword's latest snapshot.
    const statsSql = (where) => `
      WITH latest AS (
        SELECT s.keyword_id, s.rank, s.checked_at,
               ROW_NUMBER() OVER (PARTITION BY s.keyword_id ORDER BY s.checked_at DESC, s.id DESC) AS rn
        FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id JOIN domains d ON d.id = k.domain_id
        WHERE ${where})
      SELECT d.*, COUNT(k.id) AS keyword_count, COUNT(l.rank) AS ranked_count,
             MAX(l.checked_at) AS last_checked_at, ROUND(AVG(l.rank), 1) AS avg_rank
      FROM domains d
      LEFT JOIN keywords k ON k.domain_id = d.id
      LEFT JOIN latest l ON l.keyword_id = k.id AND l.rn = 1
      WHERE ${where}
      GROUP BY d.id
      ORDER BY d.group_name COLLATE NOCASE, COALESCE(NULLIF(d.display_name, ''), d.host) COLLATE NOCASE`;
    const listStmt = db.prepare(statsSql('d.user_id = ?'));
    const oneStmt = db.prepare(statsSql('d.id = ? AND d.user_id = ?'));

    const shape = row => ({ ...row, include_subdomains: !!row.include_subdomains, exact_match: !!row.exact_match, paused: !!row.paused });
    const one = (req, id) => shape(oneStmt.get(Number(id), req.user.id, Number(id), req.user.id));
    const assertUniqueHost = (req, host, exceptId = 0) => {
      if (db.prepare('SELECT 1 FROM domains WHERE user_id = ? AND host = ? AND id != ?').get(req.user.id, host, exceptId))
        throw httpError(409, `You already track ${host}`);
    };

    r.get('/', (req, res) => {
      res.json(listStmt.all(req.user.id, req.user.id).map(shape));
    });

    r.post('/', (req, res) => {
      const f = readFields(req.body, { create: true });
      assertUniqueHost(req, f.host);
      if (!f.display_name) f.display_name = f.host;
      const cols = Object.keys(f);
      const { lastInsertRowid } = db.prepare(`INSERT INTO domains(user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
        .run(req.user.id, ...cols.map(c => f[c]));
      const domainId = Number(lastInsertRowid);
      events.emit('domain:created', { domainId, userId: req.user.id });
      res.status(201).json(one(req, domainId));
    });

    r.get('/:id', (req, res) => {
      loadOwnedDomain(db, req, req.params.id);
      res.json(one(req, req.params.id));
    });

    r.patch('/:id', (req, res) => {
      const d = loadOwnedDomain(db, req, req.params.id);
      const f = readFields(req.body, { create: false });
      if (f.host) assertUniqueHost(req, f.host, d.id);
      if (f.display_name === '') f.display_name = f.host || d.host;
      const cols = Object.keys(f);
      if (!cols.length) throw httpError(400, 'No updatable fields given');
      db.prepare(`UPDATE domains SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
        .run(...cols.map(c => f[c]), d.id, req.user.id);
      res.json(one(req, d.id));
    });

    r.delete('/:id', (req, res) => {
      const d = loadOwnedDomain(db, req, req.params.id);
      db.prepare('DELETE FROM domains WHERE id = ? AND user_id = ?').run(d.id, req.user.id);
      res.json({ ok: true, id: d.id });
    });

    for (const [action, paused] of [['pause', 1], ['resume', 0]]) {
      r.post(`/:id/${action}`, (req, res) => {
        const d = loadOwnedDomain(db, req, req.params.id);
        db.prepare('UPDATE domains SET paused = ? WHERE id = ? AND user_id = ?').run(paused, d.id, req.user.id);
        res.json(one(req, d.id));
      });
    }
    return r;
  },
};
