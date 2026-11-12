// SERP features insight: a card per feature with present/owned counts and a mini trend; click a card for its keywords.
import { get } from '../api.js';
import { h, esc, fmtNum, fmtRank, table, modal } from '../ui.js';

const PERIODS = [7, 30, 90, 365];
const STYLE = `
.pg-serp-features .head { margin-bottom: 16px; gap: 8px; }
.pg-serp-features .head h1 { margin: 0; }
.pg-serp-features .periods { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.pg-serp-features .periods button { border: 0; border-radius: 0; border-left: 1px solid var(--border); }
.pg-serp-features .periods button:first-child { border-left: 0; }
.pg-serp-features .periods button.on { background: var(--primary); color: var(--primary-ink); }
.pg-serp-features .summary { margin-bottom: 12px; }
.pg-serp-features .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.pg-serp-features .feat { text-align: left; display: grid; gap: 6px; padding: 14px; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow); color: var(--text); }
.pg-serp-features .feat:hover:not(:disabled), .pg-serp-features .feat:focus-visible { border-color: var(--primary); }
.pg-serp-features .feat:disabled { cursor: default; opacity: .6; }
.pg-serp-features .feat .name { font-weight: 600; }
.pg-serp-features .feat .nums { display: flex; gap: 16px; font-variant-numeric: tabular-nums; }
.pg-serp-features .feat .nums b { font-size: 20px; display: block; }
.pg-serp-features .feat .nums small { color: var(--muted); font-size: 12px; }
.pg-serp-features .meter { background: var(--surface-2); border-radius: 4px; height: 6px; overflow: hidden; }
.pg-serp-features .meter div { height: 100%; background: var(--up); }
.pg-serp-features svg.spark { width: 100%; height: 36px; display: block; }
.pg-serp-features .legend { font-size: 12px; display: flex; gap: 12px; }
.pg-serp-features .legend i { display: inline-block; width: 10px; height: 2px; vertical-align: middle; margin-right: 4px; }
.pg-serp-features-modal .filters { margin-bottom: 12px; }
.pg-serp-features-modal .pill { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); }
.pg-serp-features-modal .pill.own { color: var(--up); }
`;

// Two-line sparkline (present vs owned) sharing one y-scale.
function spark(trend) {
  if (trend.length < 2) return '<div class="muted" style="font-size:12px">Not enough history for a trend</div>';
  const W = 200, H = 36, max = Math.max(1, ...trend.map(p => p.present));
  const line = key => trend.map((p, i) => `${i ? 'L' : 'M'}${(i / (trend.length - 1) * W).toFixed(1)},${(H - 2 - p[key] / max * (H - 4)).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line('present')}" fill="none" stroke="var(--c1)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <path d="${line('owned')}" fill="none" stroke="var(--up)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function card(f) {
  const el = h(`<button class="feat" type="button" ${f.keywordsWithFeature ? '' : 'disabled'}
      aria-label="${esc(`${f.label}: ${f.keywordsWithFeature} keywords, ${f.ownedCount} owned`)}">
    <span class="name">${esc(f.label)}</span>
    <span class="nums"><span><b>${esc(fmtNum(f.keywordsWithFeature))}</b><small>keywords</small></span>
      <span><b class="up">${esc(fmtNum(f.ownedCount))}</b><small>owned (${esc(f.ownedPct)}%)</small></span></span>
    <span class="meter"><div style="width:${Math.min(100, Number(f.ownedPct) || 0)}%"></div></span>
    ${spark(f.trend)}</button>`);
  el.dataset.feature = f.feature;
  return el;
}

async function openKeywords(ctx, f) {
  const body = h(`<div class="pg-serp-features-modal"><div class="row filters" role="group" aria-label="Ownership filter">
      <button data-o="" class="primary">All</button><button data-o="true">Owned</button><button data-o="false">Not owned</button></div>
    <div class="list"><div class="empty">Loading…</div></div></div>`);
  modal(`${f.label} keywords`, body);
  const list = body.querySelector('.list');
  const load = async owned => {
    body.querySelectorAll('[data-o]').forEach(b => b.classList.toggle('primary', b.dataset.o === owned));
    const qs = new URLSearchParams({ domainId: ctx.domainId, feature: f.feature });
    if (owned) qs.set('owned', owned);
    try {
      const data = await get(`/api/serp-features/keywords?${qs}`);
      list.replaceChildren(table([
        { key: 'phrase', label: 'Keyword', render: k => `<a href="#/keyword/${encodeURIComponent(k.id)}">${esc(k.phrase)}</a> <span class="muted">${esc(k.device)} · ${esc(k.country)}${k.location ? ' · ' + esc(k.location) : ''}</span>` },
        { key: 'rank', label: 'Rank', num: true, render: k => esc(fmtRank(k.rank)) },
        { key: 'searchVolume', label: 'Volume', num: true, render: k => esc(fmtNum(k.searchVolume)) },
        { key: 'owned', label: 'Owned', render: k => k.owned ? '<span class="pill own">Owned</span>' : '<span class="pill">No</span>' },
      ], data.keywords, { empty: 'No keywords match' }));
    } catch (e) { list.replaceChildren(h(`<div class="down">Could not load keywords: ${esc(e.message)}</div>`)); }
  };
  body.querySelector('.filters').addEventListener('click', e => { const b = e.target.closest('[data-o]'); if (b) load(b.dataset.o); });
  body.addEventListener('click', e => { if (e.target.closest('a[href^="#/keyword/"]')) body.closest('.modal-backdrop')?.remove(); });
  await load('');
}

export default {
  id: 'serp-features', title: 'SERP Features', group: 'Insights', order: 50, nav: true, needsDomain: true,
  async render(el, ctx) {
    let days = Number(ctx.query.get('days'));
    if (!PERIODS.includes(days)) days = 30;
    const root = h(`<div class="pg-serp-features"><style>${STYLE}</style>
      <div class="row head"><h1>SERP features</h1><span class="spacer"></span>
        <div class="periods" role="group" aria-label="Trend period">${PERIODS.map(p => `<button data-days="${p}">${p === 365 ? '1y' : p + 'd'}</button>`).join('')}</div></div>
      <div class="body"><div class="empty">Loading…</div></div></div>`);
    el.append(root);
    const body = root.querySelector('.body');
    let features = [];

    const load = async () => {
      root.querySelectorAll('[data-days]').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === days));
      let data;
      try { data = await get(`/api/serp-features?${new URLSearchParams({ domainId: ctx.domainId, days })}`); }
      catch (e) { body.replaceChildren(h(`<div class="card down">Could not load SERP features: ${esc(e.message)}</div>`)); return; }
      features = data.features;
      if (!data.checkedKeywords) { body.replaceChildren(h('<div class="card empty">No rank checks yet. SERP features appear after the first check.</div>')); return; }
      const grid = h('<div class="cards"></div>');
      grid.append(...features.map(card));
      body.replaceChildren(h(`<div class="row summary muted"><span>${esc(fmtNum(data.checkedKeywords))} of ${esc(fmtNum(data.totalKeywords))} keywords checked</span><span class="spacer"></span>
        <span class="legend"><span><i style="background:var(--c1)"></i>Present</span><span><i style="background:var(--up)"></i>Owned</span></span></div>`), grid);
    };

    root.addEventListener('click', e => {
      const p = e.target.closest('[data-days]');
      if (p) { days = Number(p.dataset.days); load(); return; }
      const c = e.target.closest('.feat[data-feature]');
      const f = c && features.find(x => x.feature === c.dataset.feature);
      if (f) openKeywords(ctx, f);
    });
    await load();
  },
};
