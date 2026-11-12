// Keyword management: the main keyword grid, bulk add, per-keyword edits and bulk actions.
import { httpError, requireAuth, loadOwnedDomain, loadOwnedKeyword, parseJson } from '../lib/http.js';
import { rankChange } from '../lib/metrics.js';
import { tx } from '../db.js';

const DEVICES = ['desktop', 'mobile'];
const ENGINES = ['google', 'bing', 'youtube'];
const BULK_ACTIONS = ['delete', 'star', 'unstar', 'addTag', 'removeTag', 'move'];
const MAX_PHRASES = 5000;
const SORTS = {
  phrase: r => r.phrase, rank: r => r.rank, prev_rank: r => r.prev_rank, change: r => r.change,
  change_7d: r => r.change_7d, change_30d: r => r.change_30d, search_volume: r => r.search_volume,
  url: r => r.url, device: r => r.device, starred: r => r.starred, created_at: r => r.created_at,
  location: r => r.location, checked_at: r => r.checked_at,
};

const bool = v => v === true || v === 1 || v === '1' || v === 'true';
const normPhrase = p => String(p ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const normTag = t => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
function intParam(v, name, { min = -Infinity, max = Infinity } = {}) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return n;
}
function strParam(v, name, max = 200) {
  if (v == null) return null;
  if (typeof v !== 'string') throw httpError(400, `${name} must be a string`);
  const s = v.trim();
  if (s.length > max) throw httpError(400, `${name} is too long (max ${max})`);
  return s;
}
// Snapshot sub-select encoding: NULL = no snapshot, 0 = snapshot but unranked, n = rank.
const decodeRank = v => (v == null ? undefined : v === 0 ? null : v);
const changeFrom = (hasCur, cur, past) => (!hasCur || past === undefined ? null : rankChange(past, cur));

export default {
  name: 'keywords',
  router({ db, express, events }) {
    const r = express.Router();
    r.use(requireAuth);

    const tagsFor = keywordIds => {
      const out = new Map(keywordIds.map(id => [id, []]));
      if (!keywordIds.length) return out;
      for (let i = 0; i < keywordIds.length; i += 500) {
        const chunk = keywordIds.slice(i, i + 500);
        const rows = db.prepare(`SELECT kt.keyword_id, t.id, t.name, t.color FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id
                                 WHERE kt.keyword_id IN (${chunk.map(() => '?').join(',')}) ORDER BY t.name`).all(...chunk);
        for (const t of rows) out.get(t.keyword_id).push({ id: t.id, name: t.name, color: t.color });
      }
      return out;
    };
    const ensureTag = (domainId, name) => {
      db.prepare('INSERT OR IGNORE INTO tags(domain_id, name) VALUES (?,?)').run(domainId, name);
      return db.prepare('SELECT id FROM tags WHERE domain_id = ? AND name = ?').get(domainId, name).id;
    };

    // GET /api/keywords — filtered, sorted, paginated grid.
    r.get('/', (req, res) => {
      const q = req.query;
      const domain = loadOwnedDomain(db, req, intParam(q.domainId, 'domainId', { min: 1 }) ?? 0);
      const rankMin = intParam(q.rankMin, 'rankMin', { min: 1, max: 101 });
      const rankMax = intParam(q.rankMax, 'rankMax', { min: 1, max: 101 });
      const page = intParam(q.page, 'page', { min: 1 }) ?? 1;
      const pageSize = intParam(q.pageSize, 'pageSize', { min: 1, max: 500 }) ?? 50;
      const sort = q.sort || 'phrase';
      if (!SORTS[sort]) throw httpError(400, `sort must be one of: ${Object.keys(SORTS).join(', ')}`);
      const order = q.order === 'desc' ? -1 : 1;
      if (q.device && !DEVICES.includes(q.device)) throw httpError(400, `device must be one of: ${DEVICES.join(', ')}`);

      const where = ['k.domain_id = ?'], args = [domain.id];
      if (q.q) { where.push("k.phrase LIKE ? ESCAPE '\\'"); args.push(`%${String(q.q).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`); }
      if (q.device) { where.push('k.device = ?'); args.push(q.device); }
      if (q.starred != null && q.starred !== '') { where.push('k.starred = ?'); args.push(bool(q.starred) ? 1 : 0); }
      if (q.tag) {
        const byId = /^\d+$/.test(q.tag);
        where.push(`EXISTS (SELECT 1 FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id WHERE kt.keyword_id = k.id AND ${byId ? 't.id' : 't.name'} = ?)`);
        args.push(byId ? Number(q.tag) : String(q.tag));
      }
      const past = expr => `(SELECT IFNULL(rank, 0) FROM rank_snapshots p WHERE p.keyword_id = k.id
        AND substr(p.checked_at,1,10) <= date(substr(c.checked_at,1,10), '${expr}') ORDER BY p.checked_at DESC LIMIT 1)`;
      const raw = db.prepare(`
        SELECT k.*, c.id AS snap_id, c.rank, c.url, c.checked_at, c.serp_features, c.owned_features,
          ${past('-1 day')} AS prev_raw, ${past('-7 days')} AS d7_raw, ${past('-30 days')} AS d30_raw
        FROM keywords k
        LEFT JOIN rank_snapshots c ON c.id = (SELECT id FROM rank_snapshots WHERE keyword_id = k.id ORDER BY checked_at DESC LIMIT 1)
        WHERE ${where.join(' AND ')}`).all(...args);

      let rows = raw.map(({ snap_id, prev_raw, d7_raw, d30_raw, ...k }) => {
        const has = snap_id != null, prev = decodeRank(prev_raw);
        return {
          ...k, starred: !!k.starred, ignore_local_pack: !!k.ignore_local_pack,
          serp_features: parseJson(k.serp_features, []) || [], owned_features: parseJson(k.owned_features, []) || [],
          prev_rank: prev ?? null,
          change: changeFrom(has, k.rank, prev),
          change_7d: changeFrom(has, k.rank, decodeRank(d7_raw)),
          change_30d: changeFrom(has, k.rank, decodeRank(d30_raw)),
        };
      });
      if (rankMin != null || rankMax != null) {
        const lo = rankMin ?? 1, hi = rankMax ?? 101;
        // Keywords never checked are excluded; checked-but-unranked count as 101.
        rows = rows.filter(x => x.checked_at && (x.rank ?? 101) >= lo && (x.rank ?? 101) <= hi);
      }
      const key = SORTS[sort];
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        if (x == null && y == null) return a.id - b.id;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x > y ? 1 : x < y ? -1 : a.id - b.id) * order;
      });
      const total = rows.length;
      rows = rows.slice((page - 1) * pageSize, page * pageSize);
      const tags = tagsFor(rows.map(x => x.id));
      res.json({ rows: rows.map(x => ({ ...x, tags: tags.get(x.id) })), total, page, pageSize });
    });

    // GET /api/keywords/tags?domainId= — tags of a domain with keyword counts (for filter bars).
    r.get('/tags', (req, res) => {
      const domain = loadOwnedDomain(db, req, intParam(req.query.domainId, 'domainId', { min: 1 }) ?? 0);
      res.json(db.prepare(`SELECT t.id, t.name, t.color, COUNT(kt.keyword_id) AS count FROM tags t
                           LEFT JOIN keyword_tags kt ON kt.tag_id = t.id WHERE t.domain_id = ? GROUP BY t.id ORDER BY t.name`).all(domain.id));
    });

    // POST /api/keywords — bulk add phrases x devices.
    r.post('/', (req, res) => {
      const b = req.body || {};
      const domain = loadOwnedDomain(db, req, intParam(b.domainId, 'domainId', { min: 1 }) ?? 0);
      let list = b.phrases ?? (typeof b.text === 'string' ? b.text.split(/\r?\n/) : null);
      if (!Array.isArray(list)) throw httpError(400, 'Provide phrases (array) or text (newline separated)');
      const phrases = [...new Set(list.map(normPhrase).filter(Boolean))];
      if (!phrases.length) throw httpError(400, 'No keywords given');
      if (phrases.length > MAX_PHRASES) throw httpError(400, `At most ${MAX_PHRASES} phrases per request`);
      if (phrases.some(p => p.length > 200)) throw httpError(400, 'Keyword phrases must be at most 200 characters');
      const devices = b.devices == null ? ['desktop'] : b.devices;
      if (!Array.isArray(devices) || !devices.length || devices.some(d => !DEVICES.includes(d))) throw httpError(400, `devices must be a non-empty subset of: ${DEVICES.join(', ')}`);
      const engine = b.searchEngine ?? 'google';
      if (!ENGINES.includes(engine)) throw httpError(400, `searchEngine must be one of: ${ENGINES.join(', ')}`);
      const country = (strParam(b.country, 'country', 2) || domain.default_country).toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw httpError(400, 'country must be a 2-letter code');
      const location = strParam(b.location, 'location') ?? domain.default_location;
      const language = (strParam(b.language, 'language', 10) || domain.default_language).toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(language)) throw httpError(400, 'language must be a language code like "en"');
      if (b.tags != null && !Array.isArray(b.tags)) throw httpError(400, 'tags must be an array of names');
      const tagNames = [...new Set((b.tags || []).map(normTag).filter(Boolean))];

      const keywordIds = tx(db, () => {
        const ins = db.prepare(`INSERT OR IGNORE INTO keywords(domain_id, phrase, search_engine, device, country, location, language)
                                VALUES (?,?,?,?,?,?,?)`);
        const ids = [];
        for (const p of phrases) for (const d of [...new Set(devices)]) {
          const { changes, lastInsertRowid } = ins.run(domain.id, p, engine, d, country, location, language);
          if (changes) ids.push(Number(lastInsertRowid));
        }
        const tagIds = tagNames.map(n => ensureTag(domain.id, n));
        const link = db.prepare('INSERT OR IGNORE INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)');
        for (const k of ids) for (const t of tagIds) link.run(k, t);
        return ids;
      });
      const requested = phrases.length * new Set(devices).size;
      if (keywordIds.length) events.emit('keywords:added', { domainId: domain.id, keywordIds });
      res.status(201).json({ created: keywordIds.length, skipped: requested - keywordIds.length, keywordIds });
    });

    // POST /api/keywords/bulk — actions on many keywords at once.
    r.post('/bulk', (req, res) => {
      const { ids, action, tag, domainId } = req.body || {};
      if (!BULK_ACTIONS.includes(action)) throw httpError(400, `action must be one of: ${BULK_ACTIONS.join(', ')}`);
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PHRASES || ids.some(i => !Number.isInteger(i) || i < 1)) throw httpError(400, `ids must be a non-empty array of up to ${MAX_PHRASES} keyword ids`);
      const uniq = [...new Set(ids)];
      const owned = [];
      for (let i = 0; i < uniq.length; i += 500) {
        const chunk = uniq.slice(i, i + 500);
        owned.push(...db.prepare(`SELECT k.* FROM keywords k JOIN domains d ON d.id = k.domain_id
                                  WHERE d.user_id = ? AND k.id IN (${chunk.map(() => '?').join(',')})`).all(req.user.id, ...chunk));
      }
      if (owned.length !== uniq.length) throw httpError(404, 'One or more keywords not found');
      const tagName = normTag(tag);
      if ((action === 'addTag' || action === 'removeTag') && !tagName) throw httpError(400, 'tag is required');
      const target = action === 'move' ? loadOwnedDomain(db, req, intParam(domainId, 'domainId', { min: 1 }) ?? 0) : null;

      const result = tx(db, () => {
        let affected = 0, skipped = 0;
        for (const k of owned) {
          if (action === 'delete') affected += db.prepare('DELETE FROM keywords WHERE id = ?').run(k.id).changes;
          else if (action === 'star' || action === 'unstar') affected += db.prepare('UPDATE keywords SET starred = ? WHERE id = ?').run(action === 'star' ? 1 : 0, k.id).changes;
          else if (action === 'addTag') affected += db.prepare('INSERT OR IGNORE INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(k.id, ensureTag(k.domain_id, tagName)).changes;
          else if (action === 'removeTag') affected += db.prepare('DELETE FROM keyword_tags WHERE keyword_id = ? AND tag_id IN (SELECT id FROM tags WHERE domain_id = ? AND name = ?)').run(k.id, k.domain_id, tagName).changes;
          else if (k.domain_id === target.id) skipped++;
          else {
            const names = db.prepare('SELECT t.name FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id WHERE kt.keyword_id = ?').all(k.id).map(t => t.name);
            if (!db.prepare('UPDATE OR IGNORE keywords SET domain_id = ? WHERE id = ?').run(target.id, k.id).changes) { skipped++; continue; }
            db.prepare('DELETE FROM keyword_tags WHERE keyword_id = ?').run(k.id);
            for (const n of names) db.prepare('INSERT OR IGNORE INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)').run(k.id, ensureTag(target.id, n));
            affected++;
          }
        }
        return { affected, skipped };
      });
      if (action === 'move' && result.affected) events.emit('keywords:added', { domainId: target.id, keywordIds: owned.filter(k => k.domain_id !== target.id).map(k => k.id) });
      res.json({ ok: true, action, ...result });
    });

    // PATCH /api/keywords/:id
    r.patch('/:id', (req, res) => {
      const k = loadOwnedKeyword(db, req, req.params.id);
      const b = req.body || {};
      const set = {};
      if ('starred' in b) set.starred = bool(b.starred) ? 1 : 0;
      if ('ignore_local_pack' in b) set.ignore_local_pack = bool(b.ignore_local_pack) ? 1 : 0;
      if ('location' in b) set.location = strParam(b.location ?? '', 'location');
      if ('preferred_url' in b) {
        const u = b.preferred_url == null ? '' : strParam(b.preferred_url, 'preferred_url', 2000);
        if (u && !/^https?:\/\/\S+$/i.test(u)) throw httpError(400, 'preferred_url must be an http(s) URL');
        set.preferred_url = u || null;
      }
      const cols = Object.keys(set);
      if (!cols.length) throw httpError(400, 'Nothing to update: allowed fields are starred, preferred_url, location, ignore_local_pack');
      try {
        db.prepare(`UPDATE keywords SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => set[c]), k.id);
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw httpError(409, 'An identical keyword already exists for this location');
        throw e;
      }
      const row = db.prepare('SELECT * FROM keywords WHERE id = ?').get(k.id);
      res.json({ ...row, starred: !!row.starred, ignore_local_pack: !!row.ignore_local_pack, tags: tagsFor([k.id]).get(k.id) });
    });

    // DELETE /api/keywords/:id
    r.delete('/:id', (req, res) => {
      const k = loadOwnedKeyword(db, req, req.params.id);
      db.prepare('DELETE FROM keywords WHERE id = ?').run(k.id);
      res.json({ ok: true, id: k.id });
    });

    return r;
  },
};
