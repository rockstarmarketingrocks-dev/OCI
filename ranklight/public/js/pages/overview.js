// Domain overview: KPI cards, average rank and rank distribution charts, winners/losers, period selector.
// Annotations come from GET /api/notes?domainId= when that module is installed (errors are ignored).
import { get } from '../api.js';
import { h, esc, fmtNum, fmtRank, fmtChange, table } from '../ui.js';

const PERIODS = [7, 30, 90, 365];
const BANDS = [
  ['top3', 'Top 3', 'var(--c2)'], ['top4_10', '4–10', 'var(--c6)'], ['top11_20', '11–20', 'var(--c1)'],
  ['top21_50', '21–50', 'var(--c4)'], ['top51_100', '51–100', 'var(--c3)'], ['notRanked', 'Not ranked', 'var(--border)'],
];
const W = 800, P = { l: 40, r: 12, t: 12, b: 24 };
const STYLE = `
.pg-overview .head { margin-bottom: 16px; }
.pg-overview .head h1 { margin: 0; }
.pg-overview .periods { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.pg-overview .periods button { border: 0; border-radius: 0; border-left: 1px solid var(--border); }
.pg-overview .periods button:first-child { border-left: 0; }
.pg-overview .periods button.on { background: var(--primary); color: var(--primary-ink); }
.pg-overview .kpis { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); margin-bottom: 16px; }
.pg-overview .grid-2 { margin-bottom: 16px; }
.pg-overview .chart svg { display: block; overflow: visible; }
.pg-overview .legend { margin-top: 8px; font-size: 12px; }
.pg-overview .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.pg-overview .note-line { stroke: var(--warn); stroke-dasharray: 3 3; }
.pg-overview .note-dot { fill: var(--warn); }
.pg-overview .kw { max-width: 260px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
`;

const fmtDelta = (v, suffix = '', invert = false) => {
  if (v == null || v === 0) return '<span class="muted">no change</span>';
  const good = invert ? v < 0 : v > 0;
  return `<span class="${good ? 'up' : 'down'}">${good ? '▲' : '▼'} ${esc(Math.abs(v))}${suffix}</span>`;
};

// Accepts several plausible shapes from the notes module and returns [{date: 'YYYY-MM-DD', text}].
function normalizeNotes(data) {
  const list = Array.isArray(data) ? data : data?.notes || data?.items || [];
  return list.map(n => ({ date: String(n.date || n.note_date || n.created_at || '').slice(0, 10), text: n.text || n.title || n.body || n.note || '' }))
    .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n.date));
}

// Shared x scale over ISO dates; returns svg fragments for annotation markers inside [from, to].
function xScale(from, to) {
  let x0 = +new Date(from), x1 = +new Date(to);
  if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
  return d => P.l + (+new Date(d) - x0) / (x1 - x0) * (W - P.l - P.r);
}
function noteMarks(notes, sx, from, to, H) {
  return notes.filter(n => n.date >= from && n.date <= to).map(n => {
    const x = sx(n.date).toFixed(1);
    return `<g><title>${esc(n.date)}: ${esc(n.text)}</title><line class="note-line" x1="${x}" x2="${x}" y1="${P.t}" y2="${H - P.b}"/><circle class="note-dot" cx="${x}" cy="${P.t}" r="4"/></g>`;
  }).join('');
}
const axisDates = (from, to, H) => `<text x="${P.l}" y="${H - 6}" font-size="11" fill="var(--muted)">${esc(new Date(from).toLocaleDateString())}</text>`
  + `<text x="${W - P.r}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(new Date(to).toLocaleDateString())}</text>`;

// Average rank line chart, inverted (rank 1 at top).
function avgRankChart(points, notes, from, to) {
  const pts = points.filter(p => p.avgRank != null);
  if (!pts.length) return h('<div class="empty">No ranking data in this period</div>');
  const H = 220, sx = xScale(from, to);
  let y0 = Math.min(...pts.map(p => p.avgRank)), y1 = Math.max(...pts.map(p => p.avgRank));
  if (y0 === y1) { y0 = Math.max(1, y0 - 1); y1 += 1; }
  const sy = y => P.t + (y - y0) / (y1 - y0) * (H - P.t - P.b);
  const ticks = [0, .25, .5, .75, 1].map(f => y0 + f * (y1 - y0));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.date).toFixed(1)},${sy(p.avgRank).toFixed(1)}`).join('');
  const dots = pts.map(p => `<circle cx="${sx(p.date).toFixed(1)}" cy="${sy(p.avgRank).toFixed(1)}" r="2.5" fill="var(--c1)"><title>${esc(p.date)}: ${esc(p.avgRank)}</title></circle>`).join('');
  return h(`<div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Average rank over time">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--border)"/><text x="${P.l - 6}" y="${sy(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(t * 10) / 10}</text>`).join('')}
    ${noteMarks(notes, sx, from, to, H)}
    <path d="${d}" fill="none" stroke="var(--c1)" stroke-width="2"/>${dots}${axisDates(from, to, H)}</svg></div>`);
}

// Stacked bar chart of keyword counts per rank band.
function distributionChart(rows, notes, from, to) {
  if (!rows.length) return h('<div class="empty">No ranking data in this period</div>');
  const H = 220, sx = xScale(from, to);
  const totals = rows.map(r => BANDS.reduce((s, [k]) => s + r[k], 0));
  const max = Math.max(1, ...totals);
  const plotW = W - P.l - P.r, bw = Math.max(2, Math.min(28, plotW / rows.length * 0.7));
  const sy = v => (H - P.t - P.b) * v / max;
  let bars = '';
  rows.forEach(r => {
    const x = Math.min(Math.max(sx(r.date) - bw / 2, P.l), W - P.r - bw);
    let y = H - P.b;
    const tip = `${r.date}\n` + BANDS.map(([k, l]) => `${l}: ${r[k]}`).join('\n');
    bars += `<g><title>${esc(tip)}</title>` + BANDS.map(([k, , c]) => {
      const hgt = sy(r[k]); if (!hgt) return '';
      y -= hgt;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${c}"/>`;
    }).join('') + '</g>';
  });
  const ticks = [0, .5, 1].map(f => Math.round(f * max));
  const el = h(`<div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Rank distribution over time">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b - sy(t)}" y2="${H - P.b - sy(t)}" stroke="var(--border)"/><text x="${P.l - 6}" y="${H - P.b - sy(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${t}</text>`).join('')}
    ${bars}${noteMarks(notes, sx, from, to, H)}${axisDates(from, to, H)}</svg>
    <div class="row legend">${BANDS.map(([, l, c]) => `<span><i style="background:${c}"></i>${esc(l)}</span>`).join('')}</div></div>`);
  return el;
}

function moversTable(rows, empty) {
  return table([
    { key: 'phrase', label: 'Keyword', render: r => `<span class="kw" title="${esc(r.phrase)}">${esc(r.phrase)}</span>` },
    { key: 'previousRank', label: 'Before', num: true, render: r => fmtRank(r.previousRank) },
    { key: 'rank', label: 'Now', num: true, render: r => fmtRank(r.rank) },
    { key: 'change', label: 'Change', num: true, render: r => fmtChange(r.change) },
    { key: 'searchVolume', label: 'Volume', num: true, render: r => fmtNum(r.searchVolume) },
  ], rows, { empty });
}

export default {
  id: 'overview', title: 'Overview', group: 'Overview', order: 0, nav: true, needsDomain: true,
  async render(el, ctx) {
    let days = Number(ctx.query.get('days'));
    if (!PERIODS.includes(days)) days = 30;
    const root = h(`<div class="pg-overview"><style>${STYLE}</style>
      <div class="row head"><h1>${esc(ctx.domain?.display_name || ctx.domain?.host || 'Overview')}</h1><span class="spacer"></span>
        <div class="periods" role="group" aria-label="Period">${PERIODS.map(p => `<button data-days="${p}">${p === 365 ? '1y' : p + 'd'}</button>`).join('')}</div></div>
      <div class="body"><div class="empty">Loading…</div></div></div>`);
    el.append(root);
    const body = root.querySelector('.body');
    const notesP = get(`/api/notes?domainId=${ctx.domainId}`).then(normalizeNotes).catch(() => []);

    const load = async () => {
      root.querySelectorAll('[data-days]').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === days));
      let data;
      try { data = await get(`/api/overview?domainId=${ctx.domainId}&days=${days}`); }
      catch (e) { body.replaceChildren(h(`<div class="card down">Could not load overview: ${esc(e.message)}</div>`)); return; }
      const notes = await notesP;
      const k = data.kpis;
      const pct = (n, d) => (d ? `${Math.round(n / d * 100)}% of keywords` : '');
      const kpis = h('<div class="grid kpis"></div>');
      kpis.append(
        h(`<div class="card kpi"><div class="label">Keywords</div><div class="value">${fmtNum(k.keywords)}</div><div class="muted"><span class="up">▲ ${fmtNum(k.up)}</span> · <span class="down">▼ ${fmtNum(k.down)}</span> · ${fmtNum(k.unchanged)} same</div></div>`),
        h(`<div class="card kpi"><div class="label">Average rank</div><div class="value">${k.avgRank == null ? '–' : esc(k.avgRank.toFixed(1))}</div><div class="muted">${fmtDelta(k.avgRankChange)}</div></div>`),
        h(`<div class="card kpi"><div class="label">Share of voice</div><div class="value">${esc(k.shareOfVoice.toFixed(1))}%</div><div class="muted">${fmtDelta(k.sovChange, ' pts')}</div></div>`),
        h(`<div class="card kpi"><div class="label">Est. monthly clicks</div><div class="value">${fmtNum(k.estimatedClicks)}</div><div class="muted">from tracked keywords</div></div>`),
        h(`<div class="card kpi"><div class="label">Top 3</div><div class="value">${fmtNum(k.top3)}</div><div class="muted">${pct(k.top3, k.keywords)}</div></div>`),
        h(`<div class="card kpi"><div class="label">Top 10</div><div class="value">${fmtNum(k.top10)}</div><div class="muted">${pct(k.top10, k.keywords)}</div></div>`),
        h(`<div class="card kpi"><div class="label">Top 100</div><div class="value">${fmtNum(k.top100)}</div><div class="muted">${pct(k.top100, k.keywords)}</div></div>`),
        h(`<div class="card kpi"><div class="label">Not ranked</div><div class="value">${fmtNum(k.notRanked)}</div><div class="muted">${pct(k.notRanked, k.keywords)}</div></div>`),
      );
      const card = (title, child) => { const c = h(`<div class="card"><h2>${esc(title)}</h2></div>`); c.append(child); return c; };
      const charts = h('<div class="grid grid-2"></div>');
      charts.append(card('Average rank', avgRankChart(data.avgRankHistory, notes, data.from, data.to)),
        card('Rank distribution', distributionChart(data.rankDistributionHistory, notes, data.from, data.to)));
      const movers = h('<div class="grid grid-2"></div>');
      movers.append(card('Top winners', moversTable(data.winners, 'No keywords improved in this period')),
        card('Top losers', moversTable(data.losers, 'No keywords declined in this period')));
      const parts = [kpis, charts, movers];
      if (!k.keywords) parts.unshift(h('<div class="card empty">No keywords tracked for this domain yet. <a href="#/keywords">Add keywords</a></div>'));
      body.replaceChildren(...parts);
    };
    root.querySelector('.periods').addEventListener('click', e => {
      const b = e.target.closest('[data-days]'); if (!b) return;
      days = Number(b.dataset.days); load();
    });
    await load();
  },
};
