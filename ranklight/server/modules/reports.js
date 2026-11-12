// Reports: standalone printable rank reports (HTML / CSV) and scheduled email delivery (table from 160-reports.sql).
//   GET    /api/reports/generate?domainId=&format=html|csv|pdf-html&days=1..365&sections=kpis,chart,movers,keywords
//          -> standalone HTML document (pdf-html opens the print dialog) or CSV download
//   GET    /api/reports/transport                     -> {mode: 'smtp'|'outbox'|'custom'}
//   GET    /api/reports/schedules?domainId=           -> [schedule]   (domainId optional filter)
//   POST   /api/reports/schedules  {domainId, name, frequency, format, recipients, sections?, days?, enabled?} -> 201 schedule
//   GET    /api/reports/schedules/:id                 -> schedule
//   PATCH  /api/reports/schedules/:id  {any of the above except domainId} -> schedule
//   DELETE /api/reports/schedules/:id                 -> {ok: true}
//   POST   /api/reports/schedules/:id/send            -> {ok, transport, file?, schedule}   (send now)
// schedule = {id, domainId, domainName, name, frequency, format, recipients[], sections[], days, enabled,
//             lastSentAt, lastError, nextDueAt, createdAt}
// Job 'reports' (every 15 min) sends due schedules. Transport: ctx.mailer.send(msg) if another module provides one,
// else SMTP when SMTP_HOST is set (SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_STARTTLS=0),
// else files in RL_OUTBOX_DIR (default data/outbox). Emits 'reports:sent' {scheduleId, domainId, userId, transport}.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { httpError, requireAuth, loadOwnedDomain, parseJson } from '../lib/http.js';
import { latestRanks, rankChange, estimatedClicks } from '../lib/metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SECTIONS = ['kpis', 'chart', 'movers', 'keywords'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const FORMATS = ['html', 'csv', 'pdf-html'];
const DEFAULT_DAYS = { daily: 7, weekly: 30, monthly: 90 };
const MAX_DAYS = 365, MAX_RECIPIENTS = 20, MAX_NAME = 120, MOVERS = 10;
const GRACE_MS = 10 * 60_000, RETRY_MS = 60 * 60_000;
const EMAIL_RE = /^[^\s@<>,;:"'()\\[\]]+@[^\s@<>,;:"'()\\[\]]+\.[^\s@<>,;:"'()\\[\]]+$/;
const DAY = 864e5;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brand = () => process.env.RL_BRAND_NAME || 'Ranklight';
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'report';
const oneLine = s => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const fmtAvg = v => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
const fmtInt = v => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
const fmtDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------------------------------------------------------------- report data
export function buildReport(db, domain, { days = 30, now = new Date() } = {}) {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - days * DAY).toISOString().slice(0, 10);
  const prev = new Map(latestRanks(db, domain.id, start).map(r => [r.id, r]));
  const rows = latestRanks(db, domain.id, end).map(k => {
    const p = prev.get(k.id), hasPrev = !!p?.checked_at, prevRank = hasPrev ? p.rank : null;
    return {
      id: k.id, phrase: k.phrase, searchEngine: k.search_engine, device: k.device, country: k.country, location: k.location,
      rank: k.rank, prevRank, change: hasPrev && k.checked_at ? rankChange(prevRank, k.rank) : null,
      url: k.url, volume: k.search_volume, clicks: estimatedClicks(k.rank, k.search_volume), checkedAt: k.checked_at,
    };
  }).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.phrase.localeCompare(b.phrase));

  const ranks = rows.filter(r => r.rank != null).map(r => r.rank), prevRanks = rows.filter(r => r.prevRank != null).map(r => r.prevRank);
  const kpis = {
    keywords: rows.length, ranked: ranks.length, prevRanked: prevRanks.length,
    avgRank: avg(ranks), prevAvgRank: avg(prevRanks),
    top3: ranks.filter(r => r <= 3).length, prevTop3: prevRanks.filter(r => r <= 3).length,
    top10: ranks.filter(r => r <= 10).length, prevTop10: prevRanks.filter(r => r <= 10).length,
    improved: rows.filter(r => r.change > 0).length, declined: rows.filter(r => r.change < 0).length,
    clicks: rows.reduce((a, r) => a + r.clicks, 0), prevClicks: rows.reduce((a, r) => a + estimatedClicks(r.prevRank, r.volume), 0),
  };
  const chart = db.prepare(`SELECT d AS date, AVG(r) AS avg, COUNT(*) AS n FROM (
      SELECT substr(s.checked_at,1,10) AS d, s.keyword_id, MIN(s.rank) AS r FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
      WHERE k.domain_id = ? AND s.checked_at >= ? AND s.checked_at <= ? AND s.rank IS NOT NULL GROUP BY d, s.keyword_id)
    GROUP BY d ORDER BY d`).all(domain.id, start, `${end}T23:59:59Z`).map(r => ({ date: r.date, avg: r.avg, n: r.n }));
  const moved = rows.filter(r => r.change);
  return {
    domain: { id: domain.id, host: domain.host, name: domain.display_name || domain.host },
    period: { start, end, days }, generatedAt: now.toISOString(), kpis, chart, rows,
    winners: moved.filter(r => r.change > 0).sort((a, b) => b.change - a.change).slice(0, MOVERS),
    losers: moved.filter(r => r.change < 0).sort((a, b) => a.change - b.change).slice(0, MOVERS),
  };
}

// ---------------------------------------------------------------- rendering
function rankChartSvg(points, W = 760, H = 240) {
  if (!points.length) return '<p class="empty">No ranking data in this period.</p>';
  const P = { l: 44, r: 16, t: 14, b: 28 };
  const xs = points.map(p => Date.parse(`${p.date}T00:00:00Z`)), ys = points.map(p => p.avg);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= DAY; x1 += DAY; }
  let y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys)); if (y0 === y1) { y0 = Math.max(0, y0 - 1); y1 += 1; }
  const sx = x => (P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r)).toFixed(1);
  const sy = y => (P.t + (y - y0) / (y1 - y0) * (H - P.t - P.b)).toFixed(1);   // inverted: best rank on top
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(xs[i])},${sy(p.avg)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => y0 + f * (y1 - y0));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Average rank over time (lower is better)">
${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--line)"/><text x="${P.l - 6}" y="${Number(sy(t)) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtAvg(t)}</text>`).join('')}
<path d="${line}L${sx(xs.at(-1))},${H - P.b}L${sx(xs[0])},${H - P.b}Z" fill="var(--accent)" opacity=".08"/>
<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
${points.length <= 60 ? points.map((p, i) => `<circle cx="${sx(xs[i])}" cy="${sy(p.avg)}" r="3" fill="var(--accent)"><title>${esc(p.date)}: ${fmtAvg(p.avg)}</title></circle>`).join('') : ''}
<text x="${P.l}" y="${H - 8}" font-size="11" fill="var(--muted)">${esc(fmtDay(points[0].date))}</text>
<text x="${W - P.r}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(fmtDay(points.at(-1).date))}</text></svg>`;
}

const changeHtml = (c, isNew) => (isNew ? '<span class="muted">new</span>' : !c ? '<span class="muted">–</span>'
  : c > 0 ? `<span class="up">▲ ${c}</span>` : `<span class="down">▼ ${-c}</span>`);
const kwLabel = r => esc(r.phrase) + (r.device === 'mobile' ? ' <span class="tag">mobile</span>' : '') + (r.location ? ` <span class="muted">· ${esc(r.location)}</span>` : '');
// Delta between two KPI values; lowerIsBetter flips the color.
function delta(curr, prev, { lowerIsBetter = false, fmt = fmtInt } = {}) {
  if (curr == null || prev == null || curr === prev) return '<span class="muted">no change</span>';
  const better = lowerIsBetter ? curr < prev : curr > prev;
  return `<span class="${better ? 'up' : 'down'}">${curr > prev ? '+' : '−'}${fmt(Math.abs(curr - prev))}</span> <span class="muted">vs ${fmt(prev)}</span>`;
}

function moversTable(title, rows) {
  return `<div><h3>${title}</h3>${rows.length ? `<table><thead><tr><th>Keyword</th><th class="n">Rank</th><th class="n">Change</th></tr></thead><tbody>
${rows.map(r => `<tr><td>${kwLabel(r)}</td><td class="n">${r.rank ?? '–'}</td><td class="n">${changeHtml(r.change)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">None in this period.</p>'}</div>`;
}

const REPORT_CSS = `
:root{--bg:#fff;--ink:#1c2230;--muted:#667085;--line:#e3e6eb;--soft:#f5f7fa;--accent:#2f5bea;--up:#12a150;--down:#d92d20}
@media screen and (prefers-color-scheme:dark){:root{--bg:#0f1218;--ink:#e6e9ef;--muted:#98a2b3;--line:#2a3040;--soft:#171b23;--accent:#5b7cff;--up:#3ccf7e;--down:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.page{max-width:980px;margin:0 auto;padding:32px 24px}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;border-bottom:3px solid var(--accent);padding-bottom:12px;margin-bottom:24px}
.logo{font-weight:800;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
h1{font-size:24px;margin:4px 0 0}h2{font-size:16px;margin:28px 0 12px}h3{font-size:13px;margin:0 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.meta{text-align:right;color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--soft)}
.kpi .l{font-size:12px;color:var(--muted)}.kpi .v{font-size:24px;font-weight:650;margin:2px 0}.kpi .d{font-size:12px}
.movers{display:grid;grid-template-columns:1fr 1fr;gap:20px}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.url{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--muted)}.empty{color:var(--muted);font-style:italic}
.tag{font-size:10px;border:1px solid var(--line);border-radius:999px;padding:0 6px;color:var(--muted)}
.chart{display:block;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
.toolbar{position:fixed;top:12px;right:12px}.toolbar button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--soft);color:var(--ink);cursor:pointer}
.foot{margin-top:32px;color:var(--muted);font-size:11px;text-align:center}
@media (max-width:640px){.page{padding:16px}.movers{grid-template-columns:1fr}.meta{text-align:left}.url{max-width:140px}.toolbar{display:none}}
@page{margin:14mm}
@media print{.page{max-width:none;padding:0}.toolbar{display:none}.keep{break-inside:avoid}thead{display:table-header-group}tr{break-inside:avoid}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

// Full standalone HTML document. opts.email drops scripts and the toolbar; opts.print opens the print dialog on load.
export function renderHtml(report, { sections = SECTIONS, print = false, email = false, note = '' } = {}) {
  const { domain, period, kpis: k } = report, on = new Set(sections);
  const title = `${domain.name} rank report`;
  const parts = [];
  if (on.has('kpis')) parts.push(`<section class="keep"><h2>Summary</h2><div class="kpis">
<div class="kpi"><div class="l">Average rank</div><div class="v">${fmtAvg(k.avgRank)}</div><div class="d">${delta(k.avgRank, k.prevAvgRank, { lowerIsBetter: true, fmt: fmtAvg })}</div></div>
<div class="kpi"><div class="l">Top 3</div><div class="v">${fmtInt(k.top3)}</div><div class="d">${delta(k.top3, k.prevTop3)}</div></div>
<div class="kpi"><div class="l">Top 10</div><div class="v">${fmtInt(k.top10)}</div><div class="d">${delta(k.top10, k.prevTop10)}</div></div>
<div class="kpi"><div class="l">Ranked keywords</div><div class="v">${fmtInt(k.ranked)}<span class="muted" style="font-size:14px"> / ${fmtInt(k.keywords)}</span></div><div class="d">${delta(k.ranked, k.prevRanked)}</div></div>
<div class="kpi"><div class="l">Movement</div><div class="v"><span class="up">▲${k.improved}</span> <span class="down">▼${k.declined}</span></div><div class="d muted">improved / declined</div></div>
<div class="kpi"><div class="l">Est. monthly clicks</div><div class="v">${fmtInt(k.clicks)}</div><div class="d">${delta(k.clicks, k.prevClicks)}</div></div>
</div></section>`);
  if (on.has('chart')) parts.push(`<section class="keep"><h2>Average rank</h2>${rankChartSvg(report.chart)}</section>`);
  if (on.has('movers')) parts.push(`<section class="keep"><h2>Top movers</h2><div class="movers">${moversTable('Winners', report.winners)}${moversTable('Losers', report.losers)}</div></section>`);
  if (on.has('keywords')) parts.push(`<section><h2>All keywords (${report.rows.length})</h2>${report.rows.length ? `<table><thead><tr>
<th>Keyword</th><th class="n">Rank</th><th class="n">Start</th><th class="n">Change</th><th class="n">Volume</th><th class="n">Est. clicks</th><th>URL</th></tr></thead><tbody>
${report.rows.map(r => `<tr><td>${kwLabel(r)}</td><td class="n">${r.rank ?? '–'}</td><td class="n">${r.prevRank ?? '–'}</td><td class="n">${changeHtml(r.change, r.change == null && r.rank != null)}</td><td class="n">${fmtInt(r.volume)}</td><td class="n">${r.clicks ? fmtInt(r.clicks) : '–'}</td><td class="url" title="${esc(r.url)}">${esc(r.url || '')}</td></tr>`).join('\n')}
</tbody></table>` : '<p class="empty">No keywords tracked yet.</p>'}</section>`);
  const script = email ? '' : `<div class="toolbar"><button type="button" onclick="print()">Print / Save as PDF</button></div>${print ? '<script>addEventListener("load",()=>setTimeout(print,300))</script>' : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>${script}<main class="page">
<header class="head"><div><div class="logo">${esc(brand())}</div><h1>${esc(domain.name)}</h1><div class="muted">${esc(domain.host)}</div></div>
<div class="meta">Rank report · last ${period.days} day${period.days === 1 ? '' : 's'}<br>${esc(fmtDay(period.start))} – ${esc(fmtDay(period.end))}<br>Generated ${esc(report.generatedAt.slice(0, 16).replace('T', ' '))} UTC</div></header>
${note ? `<p>${esc(note)}</p>` : ''}${parts.join('\n')}
<p class="foot">Generated by ${esc(brand())}. Rank change compares the latest position with the position at the start of the period; ▲ means the keyword moved up.</p>
</main></body></html>`;
}

const csvCell = v => {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;     // spreadsheet formula injection guard
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function renderCsv(report) {
  const head = ['keyword', 'search_engine', 'device', 'country', 'location', 'rank', 'start_rank', 'change', 'search_volume', 'est_clicks', 'url', 'checked_at'];
  const lines = report.rows.map(r => [r.phrase, r.searchEngine, r.device, r.country, r.location, r.rank, r.prevRank, r.change,
    r.volume, Math.round(r.clicks * 10) / 10, r.url, r.checkedAt].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- mail transport
export function smtpConfig(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const secure = ['1', 'true'].includes(String(env.SMTP_SECURE).toLowerCase()) || Number(env.SMTP_PORT) === 465;
  return {
    host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || (secure ? 465 : 587), secure, starttls: env.SMTP_STARTTLS !== '0',
    user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: oneLine(env.SMTP_FROM || env.SMTP_USER || 'ranklight@localhost'),
  };
}
const outboxDir = () => process.env.RL_OUTBOX_DIR || path.join(here, '..', '..', 'data', 'outbox');
const addrOf = s => (/<([^>]+)>/.exec(s)?.[1] || s).trim();

export function buildMime({ from, to, subject, html, attachments = [], date = new Date() }) {
  const hdr = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
  const b64 = s => Buffer.from(s).toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
  const head = [`From: ${oneLine(from)}`, `To: ${to.join(', ')}`, `Subject: ${hdr(oneLine(subject))}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@ranklight.local>`, 'MIME-Version: 1.0'];
  const body = ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html)];
  if (!attachments.length) return [...head, ...body].join('\r\n');
  const bd = `rl-${crypto.randomBytes(12).toString('hex')}`;
  return [...head, `Content-Type: multipart/mixed; boundary="${bd}"`, '', `--${bd}`, ...body,
    ...attachments.flatMap(a => [`--${bd}`, `Content-Type: ${a.contentType}; charset=utf-8; name="${a.filename}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`, '', b64(a.content)]), `--${bd}--`, ''].join('\r\n');
}

// Reads complete (possibly multi-line) SMTP replies from a socket.
function replyReader(socket) {
  let buf = '', lines = [], error = null;
  const ready = [], waiting = [];
  const flush = () => {
    while (ready.length && waiting.length) waiting.shift().resolve(ready.shift());
    if (error) while (waiting.length) waiting.shift().reject(error);
  };
  const onData = d => {
    buf += d.toString('utf8');
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) { ready.push({ code: Number(line.slice(0, 3)), text: lines.map(l => l.slice(4)).join('\n') }); lines = []; }
    }
    flush();
  };
  const onError = e => { error ||= e; flush(); };
  const onEnd = () => onError(new Error('SMTP connection closed'));
  const onTimeout = () => { onError(new Error('SMTP timeout')); socket.destroy(); };
  socket.on('data', onData).on('error', onError).on('end', onEnd).on('timeout', onTimeout);
  return {
    next: () => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); flush(); }),
    detach: () => socket.off('data', onData).off('error', onError).off('end', onEnd).off('timeout', onTimeout),
  };
}

export async function smtpSend(cfg, { from, to, raw }) {
  let socket = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
  socket.setTimeout(30_000);
  let reader = replyReader(socket);
  const cmd = async (line, ok) => {
    if (line != null) socket.write(`${line}\r\n`);
    const r = await reader.next();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${line == null ? 'greeting' : line.split(' ')[0]} failed: ${r.code} ${oneLine(r.text)}`);
    return r;
  };
  try {
    await cmd(null, [220]);
    let ehlo = await cmd('EHLO ranklight.local', [250]);
    if (!cfg.secure && cfg.starttls && /^STARTTLS\b/im.test(ehlo.text)) {
      await cmd('STARTTLS', [220]);
      reader.detach();
      socket = tls.connect({ socket, servername: cfg.host });
      socket.setTimeout(30_000);
      reader = replyReader(socket);
      await once(socket, 'secureConnect');
      ehlo = await cmd('EHLO ranklight.local', [250]);
    }
    if (cfg.user) await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, [235]);
    await cmd(`MAIL FROM:<${addrOf(from)}>`, [250]);
    for (const rcpt of to) await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await cmd('DATA', [354]);
    await cmd(`${raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.`, [250]);
    await cmd('QUIT', [221]).catch(() => {});
  } finally { socket.end(); socket.destroy(); }
}

function writeOutbox(msg) {
  const dir = outboxDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(msg.tag || msg.subject)}-${crypto.randomBytes(3).toString('hex')}`;
  const safe = s => oneLine(s).replace(/--/g, '- -');
  const file = path.join(dir, `${base}.html`);
  fs.writeFileSync(file, `<!--\nTo: ${safe(msg.to.join(', '))}\nSubject: ${safe(msg.subject)}\nAttachments: ${safe(msg.attachments.map(a => a.filename).join(', ') || 'none')}\n-->\n${msg.html}`);
  for (const a of msg.attachments) fs.writeFileSync(path.join(dir, `${base}-${a.filename}`), a.content);
  return file;
}

export function transportMode(ctx) { return typeof ctx.mailer?.send === 'function' ? 'custom' : smtpConfig() ? 'smtp' : 'outbox'; }

// msg = {to[], subject, html, attachments[{filename, contentType, content}], tag?}
export async function deliver(ctx, msg) {
  const mode = transportMode(ctx);
  if (mode === 'custom') { await ctx.mailer.send(msg); return { transport: 'custom' }; }
  if (mode === 'smtp') {
    const cfg = smtpConfig();
    await smtpSend(cfg, { from: cfg.from, to: msg.to, raw: buildMime({ ...msg, from: cfg.from }) });
    return { transport: 'smtp' };
  }
  const file = writeOutbox(msg);
  console.log(`[reports] SMTP not configured; wrote "${oneLine(msg.subject)}" for ${msg.to.join(', ')} to ${file}`);
  return { transport: 'outbox', file };
}

// ---------------------------------------------------------------- schedules
export function nextDueAt(s) {
  if (!s.last_sent_at) return null;
  const d = new Date(s.last_sent_at);
  if (s.frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (s.frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}
export function isDue(s, now = new Date()) {
  if (!s.enabled) return false;
  if (s.last_error && s.last_attempt_at && now - Date.parse(s.last_attempt_at) < RETRY_MS) return false;
  return !s.last_sent_at || now.getTime() >= Date.parse(nextDueAt(s)) - GRACE_MS;
}

export async function sendSchedule(ctx, s, now = new Date()) {
  const { db } = ctx;
  try {
    const domain = db.prepare('SELECT * FROM domains WHERE id = ? AND user_id = ?').get(s.domain_id, s.user_id);
    if (!domain) throw new Error('Domain no longer exists');
    const report = buildReport(db, domain, { days: s.days, now });
    const sections = parseJson(s.sections, SECTIONS), recipients = parseJson(s.recipients, []);
    if (!recipients.length) throw new Error('No recipients');
    const fileBase = `${slug(report.domain.name)}-${report.period.end}`;
    const msg = { to: recipients, tag: s.name, subject: `${s.name}: ${report.domain.name} (${report.period.start} to ${report.period.end})`, attachments: [] };
    if (s.format === 'html') msg.html = renderHtml(report, { sections, email: true });
    else {
      const csv = s.format === 'csv';
      msg.html = renderHtml(report, { sections: ['kpis'], email: true, note: `The full report is attached (${csv ? 'CSV' : 'printable HTML, open it and print to PDF'}).` });
      msg.attachments.push(csv ? { filename: `${fileBase}.csv`, contentType: 'text/csv', content: renderCsv(report) }
        : { filename: `${fileBase}.html`, contentType: 'text/html', content: renderHtml(report, { sections, print: true }) });
    }
    const result = await deliver(ctx, msg);
    db.prepare('UPDATE report_schedules SET last_sent_at = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?').run(now.toISOString(), now.toISOString(), s.id);
    ctx.events.emit('reports:sent', { scheduleId: s.id, domainId: s.domain_id, userId: s.user_id, transport: result.transport });
    return { ok: true, ...result };
  } catch (e) {
    db.prepare('UPDATE report_schedules SET last_attempt_at = ?, last_error = ? WHERE id = ?').run(now.toISOString(), String(e?.message || e).slice(0, 500), s.id);
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function runDueSchedules(ctx, now = new Date()) {
  const out = { sent: [], failed: [] };
  for (const s of ctx.db.prepare('SELECT * FROM report_schedules WHERE enabled = 1 ORDER BY id').all()) {
    if (!isDue(s, now)) continue;
    const r = await sendSchedule(ctx, s, now);
    (r.ok ? out.sent : out.failed).push(s.id);
    if (!r.ok) console.error(`[reports] schedule ${s.id} failed: ${r.error}`);
  }
  return out;
}

// ---------------------------------------------------------------- validation
function posInt(v, name, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > max) throw httpError(400, `${name} must be an integer between 1 and ${max}`);
  return n;
}
const oneOf = (v, list, name) => { if (!list.includes(v)) throw httpError(400, `${name} must be one of: ${list.join(', ')}`); return v; };
export function parseRecipients(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : null;
  if (!list) throw httpError(400, 'recipients must be an array or a comma-separated string of email addresses');
  const out = [...new Set(list.map(x => String(x ?? '').trim().toLowerCase()).filter(Boolean))];
  if (!out.length) throw httpError(400, 'At least one recipient is required');
  if (out.length > MAX_RECIPIENTS) throw httpError(400, `At most ${MAX_RECIPIENTS} recipients`);
  const bad = out.find(e => e.length > 254 || !EMAIL_RE.test(e));
  if (bad) throw httpError(400, `Invalid email address: ${bad}`);
  return out;
}
export function parseSections(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  const out = list && [...new Set(list.map(s => String(s).trim()).filter(Boolean))];
  if (!out?.length) throw httpError(400, `sections must be a non-empty list of: ${SECTIONS.join(', ')}`);
  const bad = out.find(s => !SECTIONS.includes(s));
  if (bad) throw httpError(400, `Unknown section "${bad}" (allowed: ${SECTIONS.join(', ')})`);
  return SECTIONS.filter(s => out.includes(s));
}
function parseName(v) {
  const s = oneLine(typeof v === 'string' ? v : '');
  if (!s) throw httpError(400, 'name is required');
  if (s.length > MAX_NAME) throw httpError(400, `name must be at most ${MAX_NAME} characters`);
  return s;
}

const toSchedule = r => r && ({
  id: r.id, domainId: r.domain_id, domainName: r.domain_name, name: r.name, frequency: r.frequency, format: r.format,
  recipients: parseJson(r.recipients, []), sections: parseJson(r.sections, SECTIONS), days: r.days, enabled: !!r.enabled,
  lastSentAt: r.last_sent_at, lastError: r.last_error, nextDueAt: r.enabled ? nextDueAt(r) : null, createdAt: r.created_at,
});
const SELECT = `SELECT s.*, COALESCE(NULLIF(d.display_name, ''), d.host) AS domain_name FROM report_schedules s JOIN domains d ON d.id = s.domain_id`;

export default {
  name: 'reports',
  setup(ctx) {
    ctx.jobs.set('reports', { everyMinutes: 15, run: c => runDueSchedules(c) });
    // Integration: deliver alerts module 'email' channel notifications through the same mail transport.
    ctx.events.on('alert:email', ({ notification, userId, rule, domain } = {}) => {
      const user = userId && ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
      if (!user?.email || !notification) return;
      const subject = `Ranklight alert: ${notification.message}`;
      const html = `<p>${esc(notification.message)}</p><p>Rule: ${esc(rule?.name)} · Domain: ${esc(domain?.host)}</p>`;
      deliver(ctx, { to: [user.email], subject, html, attachments: [] })
        .catch(e => console.error('[reports] alert email failed:', e.message));
    });
  },
  router(ctx) {
    const { db, express } = ctx;
    const r = express.Router();
    r.use(requireAuth);

    const owned = req => {
      const row = db.prepare(`${SELECT} WHERE s.id = ? AND s.user_id = ?`).get(posInt(req.params.id, 'id'), req.user.id);
      if (!row) throw httpError(404, 'Schedule not found');
      return row;
    };
    const one = id => toSchedule(db.prepare(`${SELECT} WHERE s.id = ?`).get(id));

    r.get('/generate', (req, res) => {
      const q = req.query;
      if (q.domainId == null || q.domainId === '') throw httpError(400, 'domainId is required');
      const domain = loadOwnedDomain(db, req, posInt(q.domainId, 'domainId'));
      const format = oneOf(q.format || 'html', FORMATS, 'format');
      const days = q.days == null || q.days === '' ? 30 : posInt(q.days, 'days', MAX_DAYS);
      const sections = q.sections ? parseSections(q.sections) : SECTIONS;
      const report = buildReport(db, domain, { days });
      const name = `${slug(report.domain.name)}-${report.period.end}`;
      res.setHeader('Cache-Control', 'no-store');
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
        return res.send(renderCsv(report));
      }
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:");
      res.type('html').send(renderHtml(report, { sections, print: format === 'pdf-html' }));
    });

    r.get('/transport', (_req, res) => res.json({ mode: transportMode(ctx) }));

    r.get('/schedules', (req, res) => {
      const args = [req.user.id];
      let where = 's.user_id = ?';
      if (req.query.domainId) { where += ' AND s.domain_id = ?'; args.push(loadOwnedDomain(db, req, posInt(req.query.domainId, 'domainId')).id); }
      res.json(db.prepare(`${SELECT} WHERE ${where} ORDER BY s.name COLLATE NOCASE, s.id`).all(...args).map(toSchedule));
    });

    r.post('/schedules', (req, res) => {
      const b = req.body || {};
      if (b.domainId == null || b.domainId === '') throw httpError(400, 'domainId is required');
      const domain = loadOwnedDomain(db, req, posInt(b.domainId, 'domainId'));
      const frequency = oneOf(b.frequency ?? 'weekly', FREQUENCIES, 'frequency');
      const v = {
        name: parseName(b.name), frequency, format: oneOf(b.format ?? 'html', FORMATS, 'format'),
        recipients: parseRecipients(b.recipients), sections: b.sections == null ? SECTIONS : parseSections(b.sections),
        days: b.days == null ? DEFAULT_DAYS[frequency] : posInt(b.days, 'days', MAX_DAYS), enabled: b.enabled === false ? 0 : 1,
      };
      const { lastInsertRowid } = db.prepare(`INSERT INTO report_schedules(user_id, domain_id, name, frequency, format, recipients, sections, days, enabled)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(req.user.id, domain.id, v.name, v.frequency, v.format, JSON.stringify(v.recipients), JSON.stringify(v.sections), v.days, v.enabled);
      res.status(201).json(one(Number(lastInsertRowid)));
    });

    r.get('/schedules/:id', (req, res) => res.json(toSchedule(owned(req))));

    r.patch('/schedules/:id', (req, res) => {
      const s = owned(req), b = req.body || {};
      const fields = ['name', 'frequency', 'format', 'recipients', 'sections', 'days', 'enabled'];
      if ('domainId' in b && Number(b.domainId) !== s.domain_id) throw httpError(400, 'domainId cannot be changed; create a new schedule instead');
      if (!fields.some(f => f in b)) throw httpError(400, `Nothing to update (${fields.join(', ')})`);
      if ('enabled' in b && typeof b.enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean');
      const v = {
        name: 'name' in b ? parseName(b.name) : s.name,
        frequency: 'frequency' in b ? oneOf(b.frequency, FREQUENCIES, 'frequency') : s.frequency,
        format: 'format' in b ? oneOf(b.format, FORMATS, 'format') : s.format,
        recipients: 'recipients' in b ? JSON.stringify(parseRecipients(b.recipients)) : s.recipients,
        sections: 'sections' in b ? JSON.stringify(parseSections(b.sections)) : s.sections,
        days: 'days' in b ? posInt(b.days, 'days', MAX_DAYS) : s.days,
        enabled: 'enabled' in b ? (b.enabled ? 1 : 0) : s.enabled,
      };
      db.prepare(`UPDATE report_schedules SET name = ?, frequency = ?, format = ?, recipients = ?, sections = ?, days = ?, enabled = ?,
        last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE id = ?`)
        .run(v.name, v.frequency, v.format, v.recipients, v.sections, v.days, v.enabled, 'recipients' in b ? 1 : 0, s.id);
      res.json(one(s.id));
    });

    r.delete('/schedules/:id', (req, res) => {
      db.prepare('DELETE FROM report_schedules WHERE id = ?').run(owned(req).id);
      res.json({ ok: true });
    });

    r.post('/schedules/:id/send', async (req, res) => {
      const s = owned(req);
      const result = await sendSchedule(ctx, s);
      if (!result.ok) throw httpError(502, `Report could not be sent: ${result.error}`);
      res.json({ ok: true, transport: result.transport, file: result.file ? path.basename(result.file) : undefined, schedule: one(s.id) });
    });

    return r;
  },
};
