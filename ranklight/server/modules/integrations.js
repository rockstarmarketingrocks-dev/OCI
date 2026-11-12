// Integrations: outbound webhooks, Slack incoming webhooks and tokenized CSV feeds for BI tools (table from 230-integrations.sql).
//   GET    /api/integrations                       -> [integration]
//   POST   /api/integrations  {type, name, config?, enabled?}  -> 201 integration
//   GET    /api/integrations/:id                   -> integration
//   PATCH  /api/integrations/:id  {name?, config?, enabled?}   -> integration (type is immutable)
//   DELETE /api/integrations/:id                   -> {ok: true}
//   POST   /api/integrations/:id/test              -> {ok, lastStatus, ...} sends a sample payload (looker_csv: reports feed size)
//   POST   /api/integrations/:id/rotate-token      -> integration (looker_csv only; old feed URL stops working)
//   GET    /api/integrations/feed/:token.csv?days= -> text/csv, UNAUTHENTICATED (token is the secret)
// integration = {id, type, name, config, enabled, lastStatus, lastSentAt, createdAt, feedUrl}
// config: webhook {url, events, domainId, secret}; slack {url, events, domainId}; looker_csv {domainId}
//   events subset of EVENTS; domainId null = all of the user's domains; secret signs bodies (X-Ranklight-Signature: sha256=<hex hmac>).
// Listens to 'ranks:updated' and 'alert:triggered'. Network delivery is skipped when NODE_ENV=test (payloads go to `outbox`).
import crypto from 'node:crypto';
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { rankChange } from '../lib/metrics.js';

export const TYPES = ['webhook', 'slack', 'looker_csv'];
export const EVENTS = ['ranks:updated', 'alert:triggered'];
const TIMEOUT_MS = 8000;
const MAX_KEYWORDS = 500;
const UA = 'Ranklight-Integrations/1.0';

// Test support: in NODE_ENV=test deliveries are recorded here instead of sent. `settle()` awaits in-flight deliveries.
export const outbox = [];
const pending = new Set();
export const settle = () => Promise.allSettled([...pending]);
const track = p => { pending.add(p); p.finally(() => pending.delete(p)); return p; };

const feedPath = token => `/api/integrations/feed/${token}.csv`;
const toIntegration = r => r && ({
  id: r.id, type: r.type, name: r.name, config: parseJson(r.config, {}), enabled: !!r.enabled,
  lastStatus: r.last_status, lastSentAt: r.last_sent_at, createdAt: r.created_at,
  feedUrl: r.type === 'looker_csv' && r.feed_token ? feedPath(r.feed_token) : null,
});

function parseId(v, name) {
  const n = Number(v);
  if (v === '' || v == null || typeof v === 'boolean' || !Number.isSafeInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}

function parseUrl(v, httpsOnly) {
  if (typeof v !== 'string' || !v.trim()) throw httpError(400, 'config.url is required');
  if (v.length > 2000) throw httpError(400, 'config.url must be at most 2000 characters');
  let u;
  try { u = new URL(v.trim()); } catch { throw httpError(400, 'config.url must be a valid URL'); }
  if (!(httpsOnly ? ['https:'] : ['http:', 'https:']).includes(u.protocol)) throw httpError(400, `config.url must use ${httpsOnly ? 'https' : 'http or https'}`);
  return u.href;
}

// Validates config for a type, merging onto the current config (PATCH). Returns the normalized config.
function parseConfig(db, req, type, raw, cur = {}) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw httpError(400, 'config must be an object');
  const b = { ...cur, ...(raw || {}) };
  const out = {};
  out.domainId = b.domainId == null || b.domainId === '' ? null : loadOwnedDomain(db, req, parseId(b.domainId, 'config.domainId')).id;
  if (type === 'looker_csv') return out;
  out.url = parseUrl(b.url, type === 'slack');
  const ev = b.events ?? EVENTS;
  if (!Array.isArray(ev) || !ev.length || ev.some(e => !EVENTS.includes(e))) throw httpError(400, `config.events must be a non-empty array of: ${EVENTS.join(', ')}`);
  out.events = [...new Set(ev)];
  if (type === 'webhook') {
    if (b.secret != null && b.secret !== '' && (typeof b.secret !== 'string' || b.secret.length > 200)) throw httpError(400, 'config.secret must be a string of at most 200 characters');
    out.secret = b.secret || null;
  }
  return out;
}

function parseBody(db, req, body, cur) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const next = { type: cur?.type, name: cur?.name, enabled: cur ? cur.enabled : true };
  if (!cur) {
    if (!TYPES.includes(b.type)) throw httpError(400, `type must be one of: ${TYPES.join(', ')}`);
    next.type = b.type;
  } else if ('type' in b && b.type !== cur.type) throw httpError(400, 'type cannot be changed; create a new integration instead');
  if ('name' in b || !cur) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) throw httpError(400, 'name is required');
    if (name.length > 120) throw httpError(400, 'name must be at most 120 characters');
    next.name = name;
  }
  if ('enabled' in b) {
    if (typeof b.enabled !== 'boolean' && b.enabled !== 0 && b.enabled !== 1) throw httpError(400, 'enabled must be a boolean');
    next.enabled = !!b.enabled;
  }
  next.config = ('config' in b || !cur) ? parseConfig(db, req, next.type, b.config, cur?.config) : cur.config;
  return next;
}

// ---- Delivery ----
const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

// POST JSON; never throws. Records last_status/last_sent_at. Returns {ok, status, lastStatus}.
async function send(db, integ, event, body) {
  const json = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'user-agent': UA, 'x-ranklight-event': event };
  if (integ.config.secret) headers['x-ranklight-signature'] = sign(integ.config.secret, json);
  let result;
  if (process.env.NODE_ENV === 'test') {
    outbox.push({ integrationId: integ.id, type: integ.type, url: integ.config.url, event, headers, body });
    result = { ok: true, status: null, lastStatus: 'skipped: test mode (no network)' };
  } else {
    try {
      const res = await fetch(integ.config.url, { method: 'POST', headers, body: json, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
      await res.arrayBuffer().catch(() => {});
      result = res.ok ? { ok: true, status: res.status, lastStatus: `ok: HTTP ${res.status}` } : { ok: false, status: res.status, lastStatus: `error: HTTP ${res.status}` };
    } catch (e) {
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (e?.cause?.code || e?.message || 'request failed');
      result = { ok: false, status: null, lastStatus: `error: ${msg}` };
    }
  }
  try {
    db.prepare('UPDATE integrations SET last_status = ?, last_sent_at = ? WHERE id = ?').run(`${event}: ${result.lastStatus}`.slice(0, 300), new Date().toISOString(), integ.id);
  } catch { /* integration deleted meanwhile */ }
  return result;
}

const posLabel = r => (r == null ? 'not ranked' : `#${r}`);
const fmtDelta = c => (c > 0 ? `+${c}` : String(c));
const slackEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Event -> {webhook body, slack body}
export function buildRanksMessage(db, { domainId, keywordIds, checkedAt } = {}) {
  const domain = db.prepare('SELECT id, user_id, host, display_name FROM domains WHERE id = ?').get(Number(domainId));
  if (!domain) return null;
  const ids = (Array.isArray(keywordIds) && keywordIds.length ? keywordIds.map(Number)
    : db.prepare('SELECT id FROM keywords WHERE domain_id = ?').all(domain.id).map(r => r.id)).slice(0, MAX_KEYWORDS);
  const kwStmt = db.prepare('SELECT id, phrase, search_engine, device, country, location, search_volume FROM keywords WHERE id = ? AND domain_id = ?');
  const snapStmt = db.prepare('SELECT rank, url, checked_at FROM rank_snapshots WHERE keyword_id = ? ORDER BY checked_at DESC, id DESC LIMIT 2');
  const keywords = [];
  for (const id of ids) {
    const k = kwStmt.get(id, domain.id);
    if (!k) continue;
    const [curr, prev] = snapStmt.all(k.id);
    keywords.push({
      id: k.id, keyword: k.phrase, searchEngine: k.search_engine, device: k.device, country: k.country, location: k.location,
      searchVolume: k.search_volume, rank: curr?.rank ?? null, previousRank: prev?.rank ?? null,
      change: prev ? rankChange(prev.rank, curr.rank) : null, url: curr?.url ?? null, checkedAt: curr?.checked_at ?? null,
    });
  }
  const ranked = keywords.filter(k => k.rank != null);
  const summary = {
    keywords: keywords.length, ranked: ranked.length,
    improved: keywords.filter(k => k.change > 0).length, declined: keywords.filter(k => k.change < 0).length,
    top3: ranked.filter(k => k.rank <= 3).length, top10: ranked.filter(k => k.rank <= 10).length,
    averageRank: ranked.length ? Math.round(ranked.reduce((s, k) => s + k.rank, 0) / ranked.length * 10) / 10 : null,
  };
  const dom = { id: domain.id, host: domain.host, name: domain.display_name || domain.host };
  const webhook = { event: 'ranks:updated', sentAt: new Date().toISOString(), checkedAt: checkedAt ?? null, domain: dom, summary, keywords };
  const movers = keywords.filter(k => k.change).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 5);
  const text = [`*Rank update for ${slackEsc(dom.name)}*: ${summary.keywords} keyword${summary.keywords === 1 ? '' : 's'} checked, `
    + `${summary.improved} improved, ${summary.declined} declined, ${summary.top10} in top 10`
    + (summary.averageRank != null ? `, average position ${summary.averageRank}` : ''),
  ...movers.map(k => `${k.change > 0 ? ':arrow_up:' : ':arrow_down:'} ${slackEsc(k.keyword)}: ${posLabel(k.previousRank)} to ${posLabel(k.rank)} (${fmtDelta(k.change)})`)].join('\n');
  return { userId: domain.user_id, domainId: domain.id, webhook, slack: { text } };
}

export function buildAlertMessage({ notification: n, rule, domain } = {}) {
  if (!n) return null;
  const webhook = {
    event: 'alert:triggered', sentAt: new Date().toISOString(),
    domain: domain ? { id: domain.id, host: domain.host } : { id: n.domainId },
    rule: rule ? { id: rule.id, name: rule.name, type: rule.type, threshold: rule.threshold ?? null } : null,
    alert: { id: n.id, type: n.type, keywordId: n.keywordId, keyword: n.keyword, message: n.message, details: n.details, createdAt: n.createdAt },
  };
  const where = domain?.host ? ` on ${slackEsc(domain.host)}` : '';
  const text = `:rotating_light: *${slackEsc(rule?.name || 'Rank alert')}*${where}\n${slackEsc(n.message)}`;
  return { domainId: domain?.id ?? n.domainId, webhook, slack: { text } };
}

function targets(db, userId, domainId, event) {
  return db.prepare("SELECT * FROM integrations WHERE user_id = ? AND enabled = 1 AND type IN ('webhook','slack') ORDER BY id").all(userId)
    .map(toIntegration).filter(i => (i.config.events || EVENTS).includes(event) && (i.config.domainId == null || i.config.domainId === domainId));
}

export function dispatch(db, event, userId, msg) {
  return Promise.all(targets(db, userId, msg.domainId, event).map(i => track(send(db, i, event, i.type === 'slack' ? msg.slack : msg.webhook))));
}

function sampleMessage(user) {
  const now = new Date().toISOString();
  const keywords = [
    { id: 0, keyword: 'example keyword', rank: 4, previousRank: 7, change: 3, url: 'https://example.com/page', checkedAt: now },
    { id: 0, keyword: 'another keyword', rank: 12, previousRank: 9, change: -3, url: 'https://example.com/other', checkedAt: now },
  ];
  return {
    webhook: { event: 'test', sentAt: now, test: true, message: `Test delivery from Ranklight for ${user.email}`,
      domain: { id: 0, host: 'example.com', name: 'example.com' }, summary: { keywords: 2, improved: 1, declined: 1 }, keywords },
    slack: { text: ':white_check_mark: *Ranklight test message*: this Slack integration is connected.\n:arrow_up: example keyword: #7 to #4 (+3)' },
  };
}

// ---- CSV feed ----
const FEED_COLS = ['date', 'checked_at', 'domain', 'keyword', 'search_engine', 'device', 'country', 'location', 'language',
  'rank', 'previous_rank', 'change', 'url', 'search_volume', 'cpc', 'starred'];
const TEXT_COLS = new Set(['domain', 'keyword', 'location', 'url']);
function csvCell(v, isText) {
  if (v == null) return '';
  let s = String(v);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formulas
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function feedRows(db, userId, domainId, days) {
  const domains = db.prepare(`SELECT id, host FROM domains WHERE user_id = ?${domainId ? ' AND id = ?' : ''} ORDER BY id`).all(...(domainId ? [userId, domainId] : [userId]));
  const kwStmt = db.prepare('SELECT * FROM keywords WHERE domain_id = ? ORDER BY phrase, id');
  const latest = db.prepare('SELECT rank, url, checked_at FROM rank_snapshots WHERE keyword_id = ? ORDER BY checked_at DESC, id DESC LIMIT 2');
  const since = days ? new Date(Date.now() - days * 864e5).toISOString() : null;
  const hist = db.prepare('SELECT rank, url, checked_at FROM rank_snapshots WHERE keyword_id = ? AND checked_at >= ? ORDER BY checked_at, id');
  const rows = [];
  for (const d of domains) for (const k of kwStmt.all(d.id)) {
    const base = { domain: d.host, keyword: k.phrase, search_engine: k.search_engine, device: k.device, country: k.country, location: k.location,
      language: k.language, search_volume: k.search_volume, cpc: k.cpc, starred: k.starred ? 1 : 0 };
    const snaps = since ? hist.all(k.id, since) : latest.all(k.id).reverse();
    const out = since ? snaps : snaps.slice(-1);
    if (!out.length) { if (!since) rows.push({ ...base }); continue; }
    for (const s of out) {
      const i = snaps.indexOf(s), prev = i > 0 ? snaps[i - 1] : null;
      rows.push({ ...base, date: s.checked_at.slice(0, 10), checked_at: s.checked_at, rank: s.rank, url: s.url,
        previous_rank: prev?.rank ?? null, change: prev ? rankChange(prev.rank, s.rank) : null });
    }
  }
  return rows;
}
const toCsv = rows => [FEED_COLS.join(','), ...rows.map(r => FEED_COLS.map(c => csvCell(r[c], TEXT_COLS.has(c))).join(','))].join('\r\n') + '\r\n';
const newToken = () => crypto.randomBytes(24).toString('base64url');

export default {
  name: 'integrations',
  setup({ db, events }) {
    const guard = fn => payload => {
      try { const p = fn(payload || {}); p?.catch?.(e => console.error('integrations: delivery failed', e)); }
      catch (e) { console.error('integrations: event handling failed', e); }
    };
    events.on('ranks:updated', guard(p => {
      const msg = buildRanksMessage(db, p);
      return msg && dispatch(db, 'ranks:updated', msg.userId, msg);
    }));
    events.on('alert:triggered', guard(p => {
      const msg = buildAlertMessage(p);
      return msg && p.userId && dispatch(db, 'alert:triggered', p.userId, msg);
    }));
  },
  router({ db, express }) {
    const r = express.Router();

    // Public tokenized feed (before requireAuth). Disabled integrations behave as unknown tokens.
    r.get('/feed/:token.csv', (req, res) => {
      const row = db.prepare("SELECT * FROM integrations WHERE feed_token = ? AND type = 'looker_csv' AND enabled = 1").get(String(req.params.token));
      if (!row) throw httpError(404, 'Feed not found');
      let days = null;
      if (req.query.days != null && req.query.days !== '') {
        days = Number(req.query.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) throw httpError(400, 'days must be an integer between 1 and 365');
      }
      const cfg = parseJson(row.config, {});
      const rows = feedRows(db, row.user_id, cfg.domainId ?? null, days);
      db.prepare('UPDATE integrations SET last_status = ?, last_sent_at = ? WHERE id = ?').run(`feed: fetched ${rows.length} rows`, new Date().toISOString(), row.id);
      res.set({ 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
      res.send(toCsv(rows));
    });

    r.use(requireAuth);
    const owned = req => {
      const row = db.prepare('SELECT * FROM integrations WHERE id = ? AND user_id = ?').get(parseId(req.params.id, 'id'), req.user.id);
      if (!row) throw httpError(404, 'Integration not found');
      return toIntegration(row);
    };
    const one = id => toIntegration(db.prepare('SELECT * FROM integrations WHERE id = ?').get(id));

    r.get('/', (req, res) => {
      const args = [req.user.id];
      let where = 'user_id = ?';
      if (req.query.type) {
        if (!TYPES.includes(req.query.type)) throw httpError(400, `type must be one of: ${TYPES.join(', ')}`);
        where += ' AND type = ?'; args.push(req.query.type);
      }
      res.json(db.prepare(`SELECT * FROM integrations WHERE ${where} ORDER BY id`).all(...args).map(toIntegration));
    });

    r.post('/', (req, res) => {
      const n = parseBody(db, req, req.body);
      const { lastInsertRowid } = db.prepare('INSERT INTO integrations(user_id, type, name, config, enabled, feed_token) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, n.type, n.name, JSON.stringify(n.config), n.enabled ? 1 : 0, n.type === 'looker_csv' ? newToken() : null);
      res.status(201).json(one(Number(lastInsertRowid)));
    });

    r.get('/:id', (req, res) => res.json(owned(req)));

    r.patch('/:id', (req, res) => {
      const cur = owned(req);
      const n = parseBody(db, req, req.body, cur);
      db.prepare('UPDATE integrations SET name = ?, config = ?, enabled = ? WHERE id = ?').run(n.name, JSON.stringify(n.config), n.enabled ? 1 : 0, cur.id);
      res.json(one(cur.id));
    });

    r.delete('/:id', (req, res) => {
      db.prepare('DELETE FROM integrations WHERE id = ?').run(owned(req).id);
      res.json({ ok: true });
    });

    r.post('/:id/rotate-token', (req, res) => {
      const cur = owned(req);
      if (cur.type !== 'looker_csv') throw httpError(400, 'Only CSV feed integrations have a token');
      db.prepare('UPDATE integrations SET feed_token = ? WHERE id = ?').run(newToken(), cur.id);
      res.json(one(cur.id));
    });

    r.post('/:id/test', async (req, res) => {
      const cur = owned(req);
      if (cur.type === 'looker_csv') {
        const rows = feedRows(db, req.user.id, cur.config.domainId ?? null, null).length;
        const lastStatus = `test: feed ready with ${rows} rows`;
        db.prepare('UPDATE integrations SET last_status = ?, last_sent_at = ? WHERE id = ?').run(lastStatus, new Date().toISOString(), cur.id);
        return res.json({ ok: true, rows, feedUrl: cur.feedUrl, lastStatus, integration: one(cur.id) });
      }
      const msg = sampleMessage(req.user);
      const result = await track(send(db, cur, 'test', cur.type === 'slack' ? msg.slack : msg.webhook));
      res.json({ ...result, integration: one(cur.id) });
    });

    return r;
  },
};
