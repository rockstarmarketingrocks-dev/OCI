// Public share: tokenized, read-only dashboard links for a domain (table from 220-public-share.sql).
//   GET    /api/public-share?domainId=        -> [link]        (all of the user's links, or one domain's)
//   POST   /api/public-share  {domainId, name?, expiresInDays? | expiresAt?, password?} -> 201 link
//   GET    /api/public-share/:id              -> link
//   PATCH  /api/public-share/:id {name?, expiresInDays? | expiresAt? (null = never), password? ('' or null clears)} -> link
//   DELETE /api/public-share/:id              -> {ok: true}     (revoke)
//   GET    /api/public-share/view/:token?password=&days=  (NO auth) -> text/html standalone dashboard.
//          404 for unknown/expired tokens, 401 HTML password form when a password is set and missing/wrong.
//          Each successful render increments views.
// link = {id, domainId, domain, name, token, path, expiresAt, expired, hasPassword, views, createdAt}
import crypto from 'node:crypto';
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { latestRanks, snapshotDates, rankChange } from '../lib/metrics.js';

const MAX_NAME = 120, MAX_DAYS = 3650, TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const SELECT = `SELECT l.*, COALESCE(NULLIF(d.display_name, ''), d.host) AS domain FROM share_links l JOIN domains d ON d.id = l.domain_id`;

const isExpired = r => !!r.expires_at && r.expires_at <= new Date().toISOString();
const toLink = r => ({
  id: r.id, domainId: r.domain_id, domain: r.domain, name: r.name, token: r.token, path: `/api/public-share/view/${r.token}`,
  expiresAt: r.expires_at, expired: isExpired(r), hasPassword: !!r.password_hash, views: r.views, createdAt: r.created_at,
});

function parseId(v, name) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isSafeInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}
function parseName(v) {
  if (v == null) return '';
  if (typeof v !== 'string') throw httpError(400, 'name must be a string');
  const s = v.trim();
  if (s.length > MAX_NAME) throw httpError(400, `name must be at most ${MAX_NAME} characters`);
  return s;
}
// Returns ISO string, null (never) or undefined (not provided).
function parseExpiry(body) {
  if (body.expiresInDays !== undefined && body.expiresInDays !== null && body.expiresInDays !== '') {
    const n = Number(body.expiresInDays);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_DAYS) throw httpError(400, `expiresInDays must be between 1 and ${MAX_DAYS}`);
    return new Date(Date.now() + n * 864e5).toISOString();
  }
  if (body.expiresAt === undefined) return undefined;
  if (body.expiresAt === null || body.expiresAt === '') return null;
  const d = new Date(String(body.expiresAt));
  if (Number.isNaN(+d)) throw httpError(400, 'expiresAt must be an ISO date');
  if (+d <= Date.now()) throw httpError(400, 'expiresAt must be in the future');
  return d.toISOString();
}
// Returns hash, null (clear) or undefined (not provided).
function parsePassword(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length < 4 || v.length > 200) throw httpError(400, 'password must be 4-200 characters');
  return hashPassword(v);
}
function loadOwnedLink(db, req, id) {
  const r = db.prepare(`${SELECT} WHERE l.id = ? AND l.user_id = ?`).get(parseId(id, 'id'), req.user.id);
  if (!r) throw httpError(404, 'Share link not found');
  return r;
}

// ---- Dashboard data ----
export function dashboardData(db, domainId, days = 90) {
  const rows = latestRanks(db, domainId);
  const dates = snapshotDates(db, domainId);
  const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;
  const prev = new Map(prevDate ? latestRanks(db, domainId, prevDate).filter(r => r.checked_at).map(r => [r.id, r.rank]) : []);
  const keywords = rows.map(r => ({
    phrase: r.phrase, device: r.device, country: r.country, location: r.location, searchEngine: r.search_engine,
    rank: r.rank ?? null, url: r.url ?? null, volume: r.search_volume ?? null, checkedAt: r.checked_at ?? null,
    change: r.checked_at && prev.has(r.id) ? rankChange(prev.get(r.id), r.rank) : null,
  })).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.phrase.localeCompare(b.phrase));
  const ranked = keywords.filter(k => k.rank != null);
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const series = db.prepare(`SELECT substr(s.checked_at,1,10) AS date, AVG(s.rank) AS avg FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
    WHERE k.domain_id = ? AND s.rank IS NOT NULL AND s.checked_at >= ? GROUP BY date ORDER BY date`).all(domainId, since)
    .map(r => ({ date: r.date, avg: Math.round(r.avg * 10) / 10 }));
  return {
    keywords, series,
    kpis: {
      total: keywords.length, ranked: ranked.length,
      avgRank: ranked.length ? Math.round(ranked.reduce((s, k) => s + k.rank, 0) / ranked.length * 10) / 10 : null,
      top3: ranked.filter(k => k.rank <= 3).length, top10: ranked.filter(k => k.rank <= 10).length,
      improved: keywords.filter(k => k.change > 0).length, declined: keywords.filter(k => k.change < 0).length,
      lastChecked: dates.at(-1) ?? null,
    },
  };
}

// ---- HTML rendering (standalone, no external assets) ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = `
:root{--bg:#f6f7f9;--surface:#fff;--border:#e3e6eb;--text:#1c2230;--muted:#667085;--primary:#2f5bea;--up:#12a150;--down:#d92d20}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--surface:#171b23;--border:#2a3040;--text:#e6e9ef;--muted:#98a2b3;--primary:#5b7cff;--up:#3ccf7e;--down:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:0 0 12px}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:16px}
.muted{color:var(--muted)}.up{color:var(--up)}.down{color:var(--down)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
.kpis .card{margin:0}.kpis .l{font-size:12px;color:var(--muted)}.kpis .v{font-size:24px;font-weight:600}
.tw{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;white-space:nowrap}
th{font-size:12px;color:var(--muted)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}td.u{max-width:320px;overflow:hidden;text-overflow:ellipsis}
.tag{font-size:11px;border:1px solid var(--border);border-radius:4px;padding:0 4px;margin-left:6px;color:var(--muted)}
form{display:flex;gap:8px;flex-wrap:wrap}input,button{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
button{background:var(--primary);border-color:var(--primary);color:#fff;cursor:pointer}footer{font-size:12px;color:var(--muted);text-align:center;margin-top:24px}
.err{color:var(--down)}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}
<footer>Read-only report shared from Ranklight</footer></main></body></html>`;
}

export function avgRankSvg(series) {
  if (!series.length) return '<p class="muted">No ranking history yet.</p>';
  const W = 800, H = 220, P = { l: 40, r: 12, t: 12, b: 24 };
  const xs = series.map(p => +new Date(p.date)), ys = series.map(p => p.avg);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys); if (y0 === y1) { y0 = Math.max(1, y0 - 1); y1 += 1; }
  const sx = x => P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r);
  const sy = y => P.t + (y - y0) / (y1 - y0) * (H - P.t - P.b); // inverted: rank 1 on top
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => y0 + f * (y1 - y0));
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(p.avg).toFixed(1)}`).join('');
  const dots = series.length <= 60 ? series.map((p, i) => `<circle cx="${sx(xs[i]).toFixed(1)}" cy="${sy(p.avg).toFixed(1)}" r="3" fill="var(--primary)"><title>${esc(p.date)}: ${p.avg}</title></circle>`).join('') : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Average rank over time">`
    + ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" stroke="var(--border)"/><text x="${P.l - 6}" y="${(sy(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(t * 10) / 10}</text>`).join('')
    + `<path d="${d}" fill="none" stroke="var(--primary)" stroke-width="2"/>${dots}`
    + `<text x="${P.l}" y="${H - 6}" font-size="11" fill="var(--muted)">${esc(series[0].date)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(series.at(-1).date)}</text></svg>`;
}

const fmtChange = c => (c == null || c === 0 ? '<span class="muted">–</span>' : c > 0 ? `<span class="up">▲ ${c}</span>` : `<span class="down">▼ ${-c}</span>`);

export function renderDashboard(link, data, days) {
  const k = data.kpis, title = link.name || `${link.domain} rankings`;
  const kpi = (l, v, sub = '') => `<div class="card"><div class="l">${esc(l)}</div><div class="v">${v}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>`;
  const rows = data.keywords.map(r => `<tr><td>${esc(r.phrase)}${r.device === 'mobile' ? '<span class="tag">mobile</span>' : ''}${r.location ? `<span class="tag">${esc(r.location)}</span>` : ''}</td>
    <td>${esc(r.country)}</td><td class="n">${r.rank ?? '<span class="muted">–</span>'}</td><td class="n">${fmtChange(r.change)}</td>
    <td class="n">${r.volume == null ? '–' : r.volume.toLocaleString('en-US')}</td><td class="u" title="${esc(r.url)}">${esc(r.url || '')}</td></tr>`).join('');
  return page(title, `<header><div><h1>${esc(title)}</h1><div class="muted">${esc(link.domain)}</div></div>
<div class="muted">${k.lastChecked ? `Last checked ${esc(k.lastChecked)}` : 'Not checked yet'}</div></header>
<section class="kpis">${kpi('Keywords', k.total, `${k.ranked} ranking`)}${kpi('Average rank', k.avgRank ?? '–')}${kpi('Top 3', k.top3)}${kpi('Top 10', k.top10)}
${kpi('Improved', `<span class="up">${k.improved}</span>`)}${kpi('Declined', `<span class="down">${k.declined}</span>`)}</section>
<section class="card"><h2>Average rank, last ${days} days</h2>${avgRankSvg(data.series)}</section>
<section class="card"><h2>Keywords</h2><div class="tw"><table><thead><tr><th>Keyword</th><th>Country</th><th class="n">Rank</th><th class="n">Change</th><th class="n">Volume</th><th>URL</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">No keywords tracked yet.</td></tr>'}</tbody></table></div></section>`);
}

function renderPasswordForm(wrong) {
  return page('Protected report', `<section class="card" style="max-width:420px;margin:10vh auto 0"><h1>Protected report</h1>
<p class="muted">Enter the password you were given to view this report.</p>${wrong ? '<p class="err">Incorrect password.</p>' : ''}
<form method="get"><input type="password" name="password" aria-label="Password" required autofocus><button>View report</button></form></section>`);
}
const notFound = () => page('Link not available', '<section class="card"><h1>Link not available</h1><p class="muted">This share link does not exist, was revoked or has expired.</p></section>');

function sendHtml(res, status, html) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'",
  }).send(html);
}

export default {
  name: 'public-share',
  router({ db, express }) {
    const r = express.Router();

    // Public, unauthenticated view.
    r.get('/view/:token', (req, res) => {
      const token = String(req.params.token);
      const link = TOKEN_RE.test(token) ? db.prepare(`${SELECT} WHERE l.token = ?`).get(token) : null;
      if (!link || isExpired(link)) return sendHtml(res, 404, notFound());
      if (link.password_hash) {
        const pw = typeof req.query.password === 'string' ? req.query.password : '';
        if (!pw || !verifyPassword(pw, link.password_hash)) return sendHtml(res, 401, renderPasswordForm(!!pw));
      }
      const days = Math.min(365, Math.max(7, Number(req.query.days) || 90));
      const html = renderDashboard(link, dashboardData(db, link.domain_id, days), days);
      db.prepare('UPDATE share_links SET views = views + 1 WHERE id = ?').run(link.id);
      sendHtml(res, 200, html);
    });

    r.use(requireAuth);

    r.get('/', (req, res) => {
      const domainId = req.query.domainId;
      if (domainId !== undefined) {
        const d = loadOwnedDomain(db, req, parseId(domainId, 'domainId'));
        return res.json(db.prepare(`${SELECT} WHERE l.user_id = ? AND l.domain_id = ? ORDER BY l.id DESC`).all(req.user.id, d.id).map(toLink));
      }
      res.json(db.prepare(`${SELECT} WHERE l.user_id = ? ORDER BY l.id DESC`).all(req.user.id).map(toLink));
    });

    r.post('/', (req, res) => {
      const b = req.body || {};
      const d = loadOwnedDomain(db, req, parseId(b.domainId ?? req.query.domainId, 'domainId'));
      const name = parseName(b.name), expires = parseExpiry(b) ?? null, pw = parsePassword(b.password) ?? null;
      const token = crypto.randomBytes(24).toString('base64url');
      const { lastInsertRowid } = db.prepare('INSERT INTO share_links(user_id, domain_id, token, name, expires_at, password_hash) VALUES (?,?,?,?,?,?)')
        .run(req.user.id, d.id, token, name, expires, pw);
      res.status(201).json(toLink(loadOwnedLink(db, req, Number(lastInsertRowid))));
    });

    r.get('/:id', (req, res) => res.json(toLink(loadOwnedLink(db, req, req.params.id))));

    r.patch('/:id', (req, res) => {
      const link = loadOwnedLink(db, req, req.params.id), b = req.body || {};
      const sets = [], vals = [];
      if (b.name !== undefined) { sets.push('name = ?'); vals.push(parseName(b.name)); }
      const exp = parseExpiry(b);
      if (exp !== undefined) { sets.push('expires_at = ?'); vals.push(exp); }
      const pw = parsePassword(b.password);
      if (pw !== undefined) { sets.push('password_hash = ?'); vals.push(pw); }
      if (!sets.length) throw httpError(400, 'Nothing to update');
      db.prepare(`UPDATE share_links SET ${sets.join(', ')} WHERE id = ?`).run(...vals, link.id);
      res.json(toLink(loadOwnedLink(db, req, link.id)));
    });

    r.delete('/:id', (req, res) => {
      const link = loadOwnedLink(db, req, req.params.id);
      db.prepare('DELETE FROM share_links WHERE id = ?').run(link.id);
      res.json({ ok: true });
    });

    return r;
  },
};
