// Alerts: user-defined rules evaluated whenever new rank snapshots arrive (tables from 180-alerts.sql).
//   GET    /api/alerts/rules?domainId=                      -> [rule]   (domainId filter optional)
//   POST   /api/alerts/rules  {name, type, threshold?, domainId?, tagId?, channels?, enabled?} -> 201 rule
//   GET    /api/alerts/rules/:id                            -> rule
//   PATCH  /api/alerts/rules/:id  (any POST field)          -> rule
//   DELETE /api/alerts/rules/:id                            -> {ok: true}
//   GET    /api/alerts/notifications?unread=1&domainId=&limit=  -> {items: [notification], unreadCount}
//   POST   /api/alerts/notifications/read  {ids: [..]} | {all: true}  -> {updated, unreadCount}
// rule = {id, name, type, threshold, domainId (null = all domains), tagId, channels, enabled, createdAt}
// notification = {id, domainId, keywordId, keyword, ruleId, type, message, details, read, createdAt}
// Listens to 'ranks:updated'. Emits 'alert:triggered' {notification, userId, rule} for rules with the 'webhook' channel
// and 'alert:email' {notification, userId, rule} for rules with the 'email' channel (for a mailer integration).
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';

export const TYPES = ['rank_drop', 'rank_gain', 'enters_top', 'leaves_top', 'url_change', 'feature_lost'];
export const CHANNELS = ['inapp', 'email', 'webhook'];
const DEFAULT_THRESHOLD = { rank_drop: 3, rank_gain: 3, enters_top: 10, leaves_top: 10 };
const usesThreshold = t => t in DEFAULT_THRESHOLD;

const toRule = r => r && ({
  id: r.id, name: r.name, type: r.type, threshold: r.threshold, domainId: r.domain_id, tagId: r.tag_id,
  channels: parseJson(r.channels, ['inapp']), enabled: !!r.enabled, createdAt: r.created_at,
});
const toNotification = r => r && ({
  id: r.id, domainId: r.domain_id, keywordId: r.keyword_id, keyword: r.phrase ?? null, ruleId: r.rule_id, type: r.type,
  message: r.message, details: parseJson(r.details, {}), read: !!r.read, createdAt: r.created_at,
});
const NOTIF_SELECT = 'SELECT n.*, k.phrase FROM notifications n LEFT JOIN keywords k ON k.id = n.keyword_id';

function parseId(v, name) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || typeof v === 'boolean' || !Number.isSafeInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}

// Validates a rule payload against the current rule (for PATCH) and returns the full next state.
function parseRule(db, req, body, cur = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const next = { ...cur };
  if ('name' in b || !cur.id) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) throw httpError(400, 'name is required');
    if (name.length > 120) throw httpError(400, 'name must be at most 120 characters');
    next.name = name;
  }
  if ('type' in b || !cur.id) {
    if (!TYPES.includes(b.type)) throw httpError(400, `type must be one of: ${TYPES.join(', ')}`);
    next.type = b.type;
  }
  if ('domainId' in b) next.domainId = b.domainId == null || b.domainId === '' ? null : loadOwnedDomain(db, req, parseId(b.domainId, 'domainId')).id;
  if ('tagId' in b) next.tagId = b.tagId == null || b.tagId === '' ? null : parseId(b.tagId, 'tagId');
  if (next.tagId) {
    if (!next.domainId) throw httpError(400, 'tagId requires a domainId');
    if (!db.prepare('SELECT 1 FROM tags WHERE id = ? AND domain_id = ?').get(next.tagId, next.domainId)) throw httpError(400, 'tagId does not belong to this domain');
  }
  if ('threshold' in b || 'type' in b || !cur.id) {
    if (!usesThreshold(next.type)) next.threshold = null;
    else if (b.threshold == null || b.threshold === '') {
      const keep = cur.id && next.type === cur.type && cur.threshold != null;
      next.threshold = keep ? cur.threshold : DEFAULT_THRESHOLD[next.type];
    } else {
      const t = Number(b.threshold);
      if (!Number.isInteger(t) || t < 1 || t > 100) throw httpError(400, 'threshold must be an integer between 1 and 100');
      next.threshold = t;
    }
  }
  if ('channels' in b || !cur.id) {
    const ch = b.channels ?? ['inapp'];
    if (!Array.isArray(ch) || !ch.length || ch.some(c => !CHANNELS.includes(c))) throw httpError(400, `channels must be a non-empty array of: ${CHANNELS.join(', ')}`);
    next.channels = [...new Set(ch)];
  }
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean' && b.enabled !== 0 && b.enabled !== 1) throw httpError(400, 'enabled must be a boolean');
    next.enabled = !!b.enabled;
  } else if (!cur.id) next.enabled = true;
  return next;
}

const features = s => new Set(parseJson(s || '[]', []));
const posLabel = r => (r == null ? 'not ranked' : `#${r}`);
const inTop = (r, n) => r != null && r <= n;

// Pure check of one rule against previous/latest snapshot. Returns {message, details} or null.
export function checkRule(rule, phrase, prev, curr) {
  const p = prev.rank, c = curr.rank, delta = (p ?? 101) - (c ?? 101); // positive = improved
  const details = { prevRank: p, rank: c, prevUrl: prev.url ?? null, url: curr.url ?? null };
  const kw = `"${phrase}"`;
  switch (rule.type) {
    case 'rank_drop':
      return -delta >= rule.threshold ? { message: `${kw} dropped ${-delta} position${-delta === 1 ? '' : 's'} (${posLabel(p)} to ${posLabel(c)})`, details } : null;
    case 'rank_gain':
      return delta >= rule.threshold ? { message: `${kw} gained ${delta} position${delta === 1 ? '' : 's'} (${posLabel(p)} to ${posLabel(c)})`, details } : null;
    case 'enters_top':
      return !inTop(p, rule.threshold) && inTop(c, rule.threshold) ? { message: `${kw} entered the top ${rule.threshold} (${posLabel(p)} to ${posLabel(c)})`, details } : null;
    case 'leaves_top':
      return inTop(p, rule.threshold) && !inTop(c, rule.threshold) ? { message: `${kw} left the top ${rule.threshold} (${posLabel(p)} to ${posLabel(c)})`, details } : null;
    case 'url_change':
      return prev.url && curr.url && prev.url !== curr.url ? { message: `${kw} ranking URL changed from ${prev.url} to ${curr.url}`, details } : null;
    case 'feature_lost': {
      const now = features(curr.owned_features), lost = [...features(prev.owned_features)].filter(f => !now.has(f));
      return lost.length ? { message: `${kw} lost SERP feature${lost.length > 1 ? 's' : ''}: ${lost.join(', ')}`, details: { ...details, features: lost } } : null;
    }
    default: return null;
  }
}

// Evaluate all enabled rules of the domain's owner for the given keywords. Returns inserted notifications.
export function evaluateAlerts(db, events, { domainId, keywordIds } = {}) {
  const domain = db.prepare('SELECT id, user_id, host FROM domains WHERE id = ?').get(Number(domainId));
  if (!domain) return [];
  const rules = db.prepare('SELECT * FROM alert_rules WHERE user_id = ? AND enabled = 1 AND (domain_id IS NULL OR domain_id = ?) ORDER BY id')
    .all(domain.user_id, domain.id).map(r => ({ ...toRule(r) }));
  if (!rules.length) return [];
  const ids = Array.isArray(keywordIds) && keywordIds.length ? keywordIds.map(Number)
    : db.prepare('SELECT id FROM keywords WHERE domain_id = ?').all(domain.id).map(r => r.id);
  const kwStmt = db.prepare('SELECT id, phrase FROM keywords WHERE id = ? AND domain_id = ?');
  const snapStmt = db.prepare('SELECT id, rank, url, owned_features FROM rank_snapshots WHERE keyword_id = ? ORDER BY checked_at DESC, id DESC LIMIT 2');
  const tagStmt = db.prepare('SELECT 1 FROM keyword_tags WHERE keyword_id = ? AND tag_id = ?');
  const ins = db.prepare(`INSERT OR IGNORE INTO notifications(user_id, domain_id, keyword_id, rule_id, type, message, details, snapshot_id)
                          VALUES (?,?,?,?,?,?,?,?)`);
  const out = [];
  for (const kid of ids) {
    const kw = kwStmt.get(kid, domain.id);
    if (!kw) continue;
    const [curr, prev] = snapStmt.all(kw.id);
    if (!prev) continue;
    for (const rule of rules) {
      if (rule.tagId && !tagStmt.get(kw.id, rule.tagId)) continue;
      const hit = checkRule(rule, kw.phrase, prev, curr);
      if (!hit) continue;
      const { changes, lastInsertRowid } = ins.run(domain.user_id, domain.id, kw.id, rule.id, rule.type, hit.message, JSON.stringify(hit.details), curr.id);
      if (!changes) continue;
      const notification = toNotification(db.prepare(`${NOTIF_SELECT} WHERE n.id = ?`).get(Number(lastInsertRowid)));
      out.push(notification);
      const payload = { notification, userId: domain.user_id, rule, domain: { id: domain.id, host: domain.host } };
      if (rule.channels.includes('webhook')) events.emit('alert:triggered', payload);
      if (rule.channels.includes('email')) events.emit('alert:email', payload);
    }
  }
  return out;
}

export default {
  name: 'alerts',
  setup({ db, events }) {
    events.on('ranks:updated', payload => {
      try { evaluateAlerts(db, events, payload || {}); } catch (e) { console.error('alerts: evaluation failed', e); }
    });
  },
  router({ db, express }) {
    const r = express.Router();
    r.use(requireAuth);

    const ownedRule = req => {
      const row = db.prepare('SELECT * FROM alert_rules WHERE id = ? AND user_id = ?').get(parseId(req.params.id, 'id'), req.user.id);
      if (!row) throw httpError(404, 'Alert rule not found');
      return toRule(row);
    };
    const one = id => toRule(db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id));
    const unreadCount = userId => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;

    r.get('/rules', (req, res) => {
      const args = [req.user.id];
      let where = 'user_id = ?';
      if (req.query.domainId) { where += ' AND (domain_id IS NULL OR domain_id = ?)'; args.push(loadOwnedDomain(db, req, parseId(req.query.domainId, 'domainId')).id); }
      res.json(db.prepare(`SELECT * FROM alert_rules WHERE ${where} ORDER BY id`).all(...args).map(toRule));
    });

    r.post('/rules', (req, res) => {
      const n = parseRule(db, req, req.body);
      const { lastInsertRowid } = db.prepare('INSERT INTO alert_rules(user_id, domain_id, name, type, threshold, tag_id, channels, enabled) VALUES (?,?,?,?,?,?,?,?)')
        .run(req.user.id, n.domainId ?? null, n.name, n.type, n.threshold, n.tagId ?? null, JSON.stringify(n.channels), n.enabled ? 1 : 0);
      res.status(201).json(one(Number(lastInsertRowid)));
    });

    r.get('/rules/:id', (req, res) => res.json(ownedRule(req)));

    r.patch('/rules/:id', (req, res) => {
      const cur = ownedRule(req);
      const fields = ['name', 'type', 'threshold', 'domainId', 'tagId', 'channels', 'enabled'];
      if (!req.body || !fields.some(f => f in req.body)) throw httpError(400, `Nothing to update (${fields.join(', ')})`);
      const n = parseRule(db, req, req.body, cur);
      db.prepare('UPDATE alert_rules SET domain_id = ?, name = ?, type = ?, threshold = ?, tag_id = ?, channels = ?, enabled = ? WHERE id = ?')
        .run(n.domainId, n.name, n.type, n.threshold, n.tagId, JSON.stringify(n.channels), n.enabled ? 1 : 0, cur.id);
      res.json(one(cur.id));
    });

    r.delete('/rules/:id', (req, res) => {
      db.prepare('DELETE FROM alert_rules WHERE id = ?').run(ownedRule(req).id);
      res.json({ ok: true });
    });

    r.get('/notifications', (req, res) => {
      const where = ['n.user_id = ?'], args = [req.user.id];
      if (['1', 'true'].includes(String(req.query.unread))) where.push('n.read = 0');
      if (req.query.domainId) { where.push('n.domain_id = ?'); args.push(loadOwnedDomain(db, req, parseId(req.query.domainId, 'domainId')).id); }
      let limit = 100;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw httpError(400, 'limit must be an integer between 1 and 500');
      }
      const items = db.prepare(`${NOTIF_SELECT} WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ?`).all(...args, limit).map(toNotification);
      res.json({ items, unreadCount: unreadCount(req.user.id) });
    });

    r.post('/notifications/read', (req, res) => {
      const b = req.body || {};
      let updated;
      if (b.all === true) updated = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(req.user.id).changes;
      else if (Array.isArray(b.ids) && b.ids.length && b.ids.length <= 1000) {
        const ids = b.ids.map(v => parseId(v, 'ids[]'));
        updated = db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0 AND id IN (${ids.map(() => '?').join(',')})`).run(req.user.id, ...ids).changes;
      } else throw httpError(400, 'Provide {ids: [notification ids]} (1-1000) or {all: true}');
      res.json({ updated: Number(updated), unreadCount: unreadCount(req.user.id) });
    });

    return r;
  },
};
