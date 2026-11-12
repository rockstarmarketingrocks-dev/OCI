// Tags and dynamic (rule-based) tags. Uses core `tags`, `keyword_tags` plus `tag_rules` (migration 100-tags.sql).
//   GET    /api/tags?domainId=                -> [{id, name, color, keywordCount, avgRank, top10, dynamic, match, rules, appliedAt}]
//   POST   /api/tags?domainId=  {name, color?, rules?, match?}            -> 201 tag
//   GET    /api/tags/:id                      -> tag + keywords:[{id, phrase, device, location, rank, url, search_volume}]
//   PATCH  /api/tags/:id        {name?, color?}                           -> tag
//   DELETE /api/tags/:id                      -> {ok}
//   POST   /api/tags/:id/rules  {rules:[{field, op, value}], match}       -> {tag, added, removed}  (saves + applies)
//   DELETE /api/tags/:id/rules                -> tag (becomes static, keeps current keywords)
//   POST   /api/tags/preview?domainId= {rules, match}                     -> {count, keywords:[...first 50]}
//   POST   /api/tags/apply?domainId=          -> {tags:[{id, added, removed}], added, removed}
//   GET    /api/tags/:id/stats                -> {count, ranked, unranked, avgRank, top3, top10, searchVolume, distribution}
// A dynamic tag's membership is exactly the set of keywords matching its rules: re-applying adds new matches
// and removes keywords that no longer match. Rules are re-applied on 'keywords:added' and 'ranks:updated'.
// Emits 'tags:applied' {domainId, added, removed} when an apply changed any membership.
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { latestRanks } from '../lib/metrics.js';
import { tx } from '../db.js';

export const FIELDS = { phrase: 'text', url: 'text', device: 'text', location: 'text', rank: 'num', search_volume: 'num' };
export const OPS = { text: ['contains', 'not_contains', 'equals', 'starts_with', 'regex'], num: ['equals', 'lt', 'gt'] };
const MAX_RULES = 20, MAX_VALUE = 200, UNRANKED = 101, DEFAULT_COLOR = '#6b7280';
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const round1 = n => Math.round(n * 10) / 10;

function parseId(v, name) {
  if (v === undefined || v === null || v === '') throw httpError(400, `${name} is required`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}
function parseName(v) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s || s.length > 50) throw httpError(400, 'name is required (1-50 characters)');
  return s;
}
function parseColor(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_COLOR;
  if (typeof v !== 'string' || !COLOR_RE.test(v)) throw httpError(400, 'color must be a hex color like #2f5bea');
  return v.toLowerCase();
}

// Validates and normalises a rule set. Throws HttpError(400) with the offending rule index.
export function validateRules(rules, match = 'all') {
  if (!['all', 'any'].includes(match)) throw httpError(400, "match must be 'all' or 'any'");
  if (!Array.isArray(rules) || !rules.length) throw httpError(400, 'rules must be a non-empty array');
  if (rules.length > MAX_RULES) throw httpError(400, `At most ${MAX_RULES} rules per tag`);
  const out = rules.map((r, i) => {
    const bad = msg => httpError(400, `Rule ${i + 1}: ${msg}`);
    if (!r || typeof r !== 'object') throw bad('must be an object');
    const kind = FIELDS[r.field];
    if (!kind) throw bad(`field must be one of ${Object.keys(FIELDS).join(', ')}`);
    if (!OPS[kind].includes(r.op)) throw bad(`op for ${r.field} must be one of ${OPS[kind].join(', ')}`);
    if (kind === 'num') {
      const n = typeof r.value === 'string' && r.value.trim() !== '' ? Number(r.value) : r.value;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw bad('value must be a number');
      return { field: r.field, op: r.op, value: n };
    }
    if (typeof r.value !== 'string' && typeof r.value !== 'number') throw bad('value must be a string');
    const value = String(r.value).trim();
    if (value.length > MAX_VALUE) throw bad(`value must be at most ${MAX_VALUE} characters`);
    if (!value && r.op !== 'equals') throw bad('value is required');
    if (r.op === 'regex') { try { new RegExp(value, 'i'); } catch { throw bad('invalid regular expression'); } }
    return { field: r.field, op: r.op, value };
  });
  return { rules: out, match };
}

// Returns a predicate (keywordRow -> boolean). Rows come from latestRanks (keyword columns + rank, url).
export function compileRules(rules, match = 'all') {
  const tests = rules.map(({ field, op, value }) => {
    if (FIELDS[field] === 'num') {
      return k => {
        const x = field === 'rank' ? (k.rank ?? UNRANKED) : k[field];
        if (x == null) return false;
        return op === 'lt' ? x < value : op === 'gt' ? x > value : x === value;
      };
    }
    const v = value.toLowerCase();
    const re = op === 'regex' ? new RegExp(value, 'i') : null;
    return k => {
      const s = String(k[field] ?? '').toLowerCase();
      switch (op) {
        case 'contains': return s.includes(v);
        case 'not_contains': return !s.includes(v);
        case 'equals': return s === v;
        case 'starts_with': return s.startsWith(v);
        default: return re.test(s);
      }
    };
  });
  return match === 'any' ? k => tests.some(t => t(k)) : k => tests.every(t => t(k));
}

export function statsFor(rows) {
  const ranks = rows.map(r => r.rank).filter(r => r != null);
  const within = n => ranks.filter(r => r <= n).length;
  return {
    count: rows.length, ranked: ranks.length, unranked: rows.length - ranks.length,
    avgRank: ranks.length ? round1(ranks.reduce((a, b) => a + b, 0) / ranks.length) : null,
    top3: within(3), top10: within(10),
    searchVolume: rows.reduce((a, r) => a + (r.search_volume || 0), 0),
    distribution: { '1-3': within(3), '4-10': within(10) - within(3), '11-20': within(20) - within(10), '21-50': within(50) - within(20), '51-100': within(100) - within(50), unranked: rows.length - ranks.length },
  };
}

export default {
  name: 'tags',
  setup(ctx) {
    const { db, events } = ctx;
    // Re-apply dynamic tags whenever keywords or ranks change. Defer if the emitter is mid-transaction.
    const onChange = ({ domainId } = {}) => {
      if (!domainId) return;
      const run = () => { try { applyDomain(db, events, Number(domainId)); } catch (e) { console.error('tags: apply failed', e); } };
      db.isTransaction ? setImmediate(run) : run();
    };
    events.on('keywords:added', onChange);
    events.on('ranks:updated', onChange);
  },
  router({ db, express, events }) {
    const r = express.Router();
    r.use(requireAuth);

    const domainFrom = req => loadOwnedDomain(db, req, parseId(req.query.domainId ?? req.body?.domainId, 'domainId'));
    const loadTag = (req, id = req.params.id) => {
      const t = db.prepare(`SELECT t.*, r.rules, r.match, r.applied_at FROM tags t JOIN domains d ON d.id = t.domain_id
                            LEFT JOIN tag_rules r ON r.tag_id = t.id WHERE t.id = ? AND d.user_id = ?`).get(parseId(id, 'id'), req.user.id);
      if (!t) throw httpError(404, 'Tag not found');
      return t;
    };
    const tagRow = (t, stats) => ({
      id: t.id, domainId: t.domain_id, name: t.name, color: t.color,
      dynamic: t.rules != null, match: t.match ?? null, rules: t.rules != null ? parseJson(t.rules, []) : null, appliedAt: t.applied_at ?? null,
      keywordCount: stats?.count ?? 0, avgRank: stats?.avgRank ?? null, top10: stats?.top10 ?? 0,
    });
    // Latest-rank rows of the keywords carrying a tag.
    const taggedRows = t => {
      const ids = new Set(db.prepare('SELECT keyword_id FROM keyword_tags WHERE tag_id = ?').all(t.id).map(x => x.keyword_id));
      return latestRanks(db, t.domain_id).filter(k => ids.has(k.id));
    };
    const fullTag = id => db.prepare('SELECT t.*, r.rules, r.match, r.applied_at FROM tags t LEFT JOIN tag_rules r ON r.tag_id = t.id WHERE t.id = ?').get(id);
    const withStats = t => tagRow(t, statsFor(taggedRows(t)));
    const uniqueName = (domainId, name, exceptId = 0) => {
      if (db.prepare('SELECT 1 FROM tags WHERE domain_id = ? AND lower(name) = lower(?) AND id <> ?').get(domainId, name, exceptId)) throw httpError(409, `A tag named "${name}" already exists`);
    };
    const saveRules = (tagId, { rules, match }) => db.prepare(`INSERT INTO tag_rules(tag_id, rules, match, updated_at) VALUES (?,?,?,datetime('now'))
      ON CONFLICT(tag_id) DO UPDATE SET rules = excluded.rules, match = excluded.match, updated_at = excluded.updated_at`).run(tagId, JSON.stringify(rules), match);

    r.get('/', (req, res) => {
      const domain = domainFrom(req);
      const tags = db.prepare('SELECT t.*, r.rules, r.match, r.applied_at FROM tags t LEFT JOIN tag_rules r ON r.tag_id = t.id WHERE t.domain_id = ? ORDER BY t.name COLLATE NOCASE').all(domain.id);
      const byKw = new Map(latestRanks(db, domain.id).map(k => [k.id, k]));
      const members = new Map();
      for (const { keyword_id, tag_id } of db.prepare('SELECT kt.keyword_id, kt.tag_id FROM keyword_tags kt JOIN tags t ON t.id = kt.tag_id WHERE t.domain_id = ?').all(domain.id)) {
        const k = byKw.get(keyword_id);
        if (k) (members.get(tag_id) || members.set(tag_id, []).get(tag_id)).push(k);
      }
      res.json(tags.map(t => tagRow(t, statsFor(members.get(t.id) || []))));
    });

    r.post('/', (req, res) => {
      const domain = domainFrom(req);
      const b = req.body || {};
      const name = parseName(b.name), color = parseColor(b.color);
      const ruleSet = b.rules != null ? validateRules(b.rules, b.match ?? 'all') : null;
      uniqueName(domain.id, name);
      const id = tx(db, () => {
        const id = Number(db.prepare('INSERT INTO tags(domain_id, name, color) VALUES (?,?,?)').run(domain.id, name, color).lastInsertRowid);
        if (ruleSet) saveRules(id, ruleSet);
        return id;
      });
      if (ruleSet) applyDomain(db, events, domain.id, [id]);
      res.status(201).json(withStats(fullTag(id)));
    });

    r.post('/preview', (req, res) => {
      const domain = domainFrom(req);
      const { rules, match } = validateRules(req.body?.rules, req.body?.match ?? 'all');
      const hit = latestRanks(db, domain.id).filter(compileRules(rules, match));
      res.json({ count: hit.length, keywords: hit.slice(0, 50).map(k => ({ id: k.id, phrase: k.phrase, device: k.device, location: k.location, rank: k.rank, url: k.url, search_volume: k.search_volume })) });
    });

    r.post('/apply', (req, res) => {
      const domain = domainFrom(req);
      res.json(applyDomain(db, events, domain.id));
    });

    r.get('/:id', (req, res) => {
      const t = loadTag(req);
      const rows = taggedRows(t).sort((a, b) => (a.rank ?? UNRANKED) - (b.rank ?? UNRANKED) || a.phrase.localeCompare(b.phrase));
      res.json({ ...tagRow(t, statsFor(rows)), keywords: rows.map(k => ({ id: k.id, phrase: k.phrase, device: k.device, location: k.location, rank: k.rank, url: k.url, search_volume: k.search_volume })) });
    });

    r.patch('/:id', (req, res) => {
      const t = loadTag(req);
      const b = req.body || {};
      if (b.name === undefined && b.color === undefined) throw httpError(400, 'Nothing to update: provide name and/or color');
      const name = b.name === undefined ? t.name : parseName(b.name);
      const color = b.color === undefined ? t.color : parseColor(b.color);
      if (name !== t.name) uniqueName(t.domain_id, name, t.id);
      db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, t.id);
      res.json(withStats(fullTag(t.id)));
    });

    r.delete('/:id', (req, res) => {
      const t = loadTag(req);
      db.prepare('DELETE FROM tags WHERE id = ?').run(t.id);
      res.json({ ok: true });
    });

    r.post('/:id/rules', (req, res) => {
      const t = loadTag(req);
      saveRules(t.id, validateRules(req.body?.rules, req.body?.match ?? 'all'));
      const result = applyDomain(db, events, t.domain_id, [t.id]);
      res.json({ tag: withStats(fullTag(t.id)), added: result.added, removed: result.removed });
    });

    r.delete('/:id/rules', (req, res) => {
      const t = loadTag(req);
      db.prepare('DELETE FROM tag_rules WHERE tag_id = ?').run(t.id);
      res.json(withStats(fullTag(t.id)));
    });

    r.get('/:id/stats', (req, res) => {
      const t = loadTag(req);
      res.json({ tagId: t.id, ...statsFor(taggedRows(t)) });
    });

    return r;
  },
};

// Recomputes membership of the domain's dynamic tags (optionally only `onlyTagIds`). Returns per-tag deltas.
export function applyDomain(db, events, domainId, onlyTagIds = null) {
  let tagRules = db.prepare('SELECT r.* FROM tag_rules r JOIN tags t ON t.id = r.tag_id WHERE t.domain_id = ?').all(domainId);
  if (onlyTagIds) tagRules = tagRules.filter(r => onlyTagIds.includes(r.tag_id));
  const result = { tags: [], added: 0, removed: 0 };
  if (!tagRules.length) return result;
  const keywords = latestRanks(db, domainId);
  const link = db.prepare('INSERT OR IGNORE INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)');
  const unlink = db.prepare('DELETE FROM keyword_tags WHERE keyword_id = ? AND tag_id = ?');
  const stamp = db.prepare("UPDATE tag_rules SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tag_id = ?");
  tx(db, () => {
    for (const tr of tagRules) {
      let pred;
      try { const v = validateRules(parseJson(tr.rules, []), tr.match); pred = compileRules(v.rules, v.match); }
      catch { continue; } // corrupt stored rules: leave membership untouched
      const want = new Set(keywords.filter(pred).map(k => k.id));
      const have = new Set(db.prepare('SELECT keyword_id FROM keyword_tags WHERE tag_id = ?').all(tr.tag_id).map(x => x.keyword_id));
      let added = 0, removed = 0;
      for (const id of want) if (!have.has(id)) added += Number(link.run(id, tr.tag_id).changes);
      for (const id of have) if (!want.has(id)) removed += Number(unlink.run(id, tr.tag_id).changes);
      stamp.run(tr.tag_id);
      result.tags.push({ id: tr.tag_id, added, removed, count: want.size });
      result.added += added; result.removed += removed;
    }
  });
  if (result.added || result.removed) events?.emit('tags:applied', { domainId, added: result.added, removed: result.removed });
  return result;
}
