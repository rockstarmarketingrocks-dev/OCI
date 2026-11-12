// Search volume: monthly volume, CPC, competition and a 12-month trend sparkline per keyword.
import { get, post } from '../api.js';
import { h, esc, table, kpi, toast, fmtNum, fmtDate } from '../ui.js';

const STYLE = `
.pg-search-volume .head { margin-bottom: 12px; gap: 8px; flex-wrap: wrap; }
.pg-search-volume .head h1 { margin: 0; }
.pg-search-volume .kpis { margin-bottom: 16px; }
.pg-search-volume .toolbar { margin-bottom: 12px; gap: 8px; flex-wrap: wrap; }
.pg-search-volume .toolbar input { min-width: 0; flex: 1 1 220px; max-width: 360px; }
.pg-search-volume .spark { display: block; width: 120px; height: 28px; overflow: visible; }
.pg-search-volume .spark path.line { fill: none; stroke: var(--primary); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.pg-search-volume .spark path.area { fill: var(--primary); opacity: .12; stroke: none; }
.pg-search-volume .spark.big { width: 100%; height: 80px; }
.pg-search-volume .comp { display: inline-block; width: 56px; height: 6px; border-radius: 3px; background: var(--surface-2); margin-right: 6px; vertical-align: middle; overflow: hidden; }
.pg-search-volume .comp i { display: block; height: 100%; }
.pg-search-volume .trend-card { margin-bottom: 16px; }
.pg-search-volume .trend-card .months { display: flex; justify-content: space-between; font-size: 11px; }
.pg-search-volume tfoot td { font-weight: 600; border-top: 2px solid var(--border); }
.pg-search-volume .notice { margin-bottom: 12px; }
@media (max-width: 700px) { .pg-search-volume .spark { width: 80px; } }
`;

const money = n => (n == null ? '–' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }));
const monthLabel = m => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });

// Inline SVG sparkline; null points break the line. Values are numbers only, so no escaping is needed in paths.
export function sparkline(values, { big = false, label = '' } = {}) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '<span class="muted">–</span>';
  const W = 100, H = 28, max = Math.max(...pts.map(p => p[1])), min = Math.min(...pts.map(p => p[1]));
  const span = max - min || 1, n = values.length - 1 || 1;
  const xy = ([i, v]) => [(i / n * W).toFixed(2), (H - 2 - (v - min) / span * (H - 4)).toFixed(2)];
  let line = '', prev = -2;
  for (const p of pts) { const [x, y] = xy(p); line += `${p[0] === prev + 1 ? 'L' : 'M'}${x},${y}`; prev = p[0]; }
  const [fx] = xy(pts[0]), [lx] = xy(pts.at(-1));
  const area = `M${fx},${H}` + pts.map(p => { const [x, y] = xy(p); return `L${x},${y}`; }).join('') + `L${lx},${H}Z`;
  const title = esc(label || values.map(v => v ?? '–').join(', '));
  return `<svg class="spark${big ? ' big' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${title}"><title>${title}</title><path class="area" d="${area}"/><path class="line" d="${line}"/></svg>`;
}

function compCell(c) {
  if (c == null) return '<span class="muted">–</span>';
  const color = c >= 0.66 ? 'var(--down)' : c >= 0.33 ? 'var(--warn)' : 'var(--up)';
  return `<span class="comp"><i style="width:${(c * 100).toFixed(0)}%;background:${color}"></i></span>${esc(Math.round(c * 100))}`;
}

// Change from first to last known month of the trend, in percent.
function trendChange(t) {
  const known = t.filter(v => v != null);
  if (known.length < 2 || !known[0]) return null;
  return Math.round((known.at(-1) - known[0]) / known[0] * 100);
}
const fmtPct = p => (p == null ? '<span class="muted">–</span>' : p > 0 ? `<span class="up">+${esc(p)}%</span>` : p < 0 ? `<span class="down">${esc(p)}%</span>` : '0%');

export default {
  id: 'search-volume', title: 'Search Volume', group: 'Discovery', order: 72, nav: true, needsDomain: true,
  async render(el, ctx) {
    const root = h(`<div class="pg-search-volume"><style>${STYLE}</style>
      <div class="row head"><h1>Search volume</h1><span class="spacer"></span><button class="primary" data-refresh>Refresh volumes</button></div>
      <div class="body"><div class="empty">Loading…</div></div></div>`);
    el.append(root);
    const body = root.querySelector('.body'), btn = root.querySelector('[data-refresh]');
    let filter = '';

    const draw = data => {
      const t = data.totals;
      btn.disabled = !data.providerAvailable;
      btn.title = data.providerAvailable ? '' : 'No search volume provider is configured';
      const kpis = h('<div class="grid grid-4 kpis"></div>');
      kpis.append(
        kpi('Total monthly volume', esc(fmtNum(t.volume)), `${esc(fmtNum(t.withVolume))} of ${esc(fmtNum(t.keywords))} keywords with data`),
        kpi('Average CPC', esc(money(t.avgCpc))),
        kpi('Avg. competition', t.avgCompetition == null ? '–' : esc(Math.round(t.avgCompetition * 100)), 'Scale 0–100'),
        kpi('Traffic value', esc(money(t.trafficValue)), t.lastUpdated ? `Updated ${esc(fmtDate(t.lastUpdated))}` : 'Not refreshed yet'));
      const nodes = [kpis];
      if (!data.providerAvailable) nodes.push(h('<div class="card notice muted">No search volume provider is configured, so volumes cannot be refreshed. Showing stored data.</div>'));
      if (t.trend.some(v => v != null)) {
        nodes.push(h(`<div class="card trend-card"><div class="label muted">Total volume, last 12 months</div>
          ${sparkline(t.trend, { big: true, label: data.months.map((m, i) => `${monthLabel(m)}: ${t.trend[i] ?? '–'}`).join(', ') })}
          <div class="months muted"><span>${esc(monthLabel(data.months[0]))}</span><span>${esc(monthLabel(data.months.at(-1)))}</span></div></div>`));
      }
      const rows = data.keywords.map(k => ({ ...k, change: trendChange(k.trend) }));
      const columns = [
        { key: 'phrase', label: 'Keyword', render: r => `<a href="#/keyword/${Number(r.id)}">${esc(r.phrase)}</a> <span class="tag">${esc(r.country)}</span>${r.device === 'mobile' ? ' <span class="tag">mobile</span>' : ''}` },
        { key: 'volume', label: 'Volume', num: true, render: r => esc(fmtNum(r.volume)) },
        { key: 'cpc', label: 'CPC', num: true, render: r => esc(money(r.cpc)) },
        { key: 'competition', label: 'Competition', num: true, render: r => compCell(r.competition) },
        { key: 'change', label: '12-mo change', num: true, render: r => fmtPct(r.change) },
        { key: 'trend', label: 'Trend', render: r => sparkline(r.trend, { label: `${r.phrase}: ` + data.months.map((m, i) => `${monthLabel(m)} ${r.trend[i] ?? '–'}`).join(', ') }) },
      ];
      const toolbar = h('<div class="row toolbar"><input type="search" placeholder="Filter keywords…" aria-label="Filter keywords"></div>');
      const holder = h('<div></div>');
      const drawTable = () => {
        const shown = filter ? rows.filter(r => r.phrase.toLowerCase().includes(filter)) : rows;
        const tbl = table(columns, shown, { empty: filter ? 'No keywords match the filter' : 'No keywords in this domain yet' });
        if (shown.length) {
          const vol = shown.reduce((a, r) => a + (r.volume || 0), 0);
          const totTrend = data.months.map((_, i) => shown.reduce((a, r) => (r.trend[i] == null ? a : (a ?? 0) + r.trend[i]), null));
          tbl.querySelector('table').append(h(`<table><tfoot><tr><td>Total (${esc(fmtNum(shown.length))})</td><td class="num">${esc(fmtNum(vol))}</td><td></td><td></td><td class="num">${fmtPct(trendChange(totTrend))}</td><td>${sparkline(totTrend)}</td></tr></tfoot></table>`).querySelector('tfoot'));
        }
        holder.replaceChildren(tbl);
      };
      toolbar.querySelector('input').value = filter;
      toolbar.querySelector('input').addEventListener('input', e => { filter = e.target.value.trim().toLowerCase(); drawTable(); });
      drawTable();
      body.replaceChildren(...nodes, toolbar, holder);
    };

    const load = async () => {
      try { draw(await get(`/api/search-volume?domainId=${ctx.domainId}`)); }
      catch (e) { body.replaceChildren(h(`<div class="card down">Could not load search volume: ${esc(e.message)}</div>`)); }
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Refreshing…';
      try {
        const r = await post('/api/search-volume/refresh', { domainId: ctx.domainId });
        toast(`Updated ${r.updated} of ${r.requested} keywords${r.missing ? ` (${r.missing} without data)` : ''}`);
        await load();
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      btn.textContent = 'Refresh volumes';
    });
    await load();
  },
};
