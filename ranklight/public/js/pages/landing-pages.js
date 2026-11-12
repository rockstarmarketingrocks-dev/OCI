// Landing pages: ranking URLs with their keywords, URL cannibalization and preferred URL mismatches.
import { get } from '../api.js';
import { h, esc, table, kpi, modal, fmtNum, fmtRank, fmtChange, fmtDate } from '../ui.js';

const TABS = [
  { id: 'pages', label: 'Pages' },
  { id: 'cannibalization', label: 'Cannibalization' },
  { id: 'mismatches', label: 'Preferred URL mismatches' },
];
const WINDOWS = [7, 30, 90];
const STYLE = `
.pg-landing-pages .head { margin-bottom: 12px; gap: 8px; }
.pg-landing-pages .head h1 { margin: 0; }
.pg-landing-pages .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
.pg-landing-pages .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted); padding: 8px 12px; white-space: nowrap; }
.pg-landing-pages .tabs button.on { color: var(--text); border-bottom-color: var(--primary); font-weight: 600; }
.pg-landing-pages .kpis { margin-bottom: 16px; }
.pg-landing-pages .toolbar { margin-bottom: 12px; }
.pg-landing-pages .toolbar input { min-width: 0; flex: 1 1 220px; max-width: 360px; }
.pg-landing-pages .url { display: inline-block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.pg-landing-pages .urls { display: grid; gap: 2px; }
.pg-landing-pages .urls .cur { font-weight: 600; }
.pg-landing-pages .bar { display: inline-block; width: 64px; height: 6px; border-radius: 3px; background: var(--surface-2); margin-right: 6px; vertical-align: middle; overflow: hidden; }
.pg-landing-pages .bar i { display: block; height: 100%; background: var(--primary); }
.pg-landing-pages .hint { font-size: 12px; margin-bottom: 12px; }
.lp-detail .url { word-break: break-all; margin-bottom: 12px; display: block; }
@media (max-width: 800px) { .pg-landing-pages .url { max-width: 220px; } }
`;

const pct = v => `${Number(v || 0).toFixed(1)}%`;
const pathOf = u => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };
// Display a URL by its path, full URL in the tooltip; only http(s) URLs become links.
function urlCell(u, { full = false, cls = '' } = {}) {
  if (!u) return '<span class="muted">–</span>';
  const text = esc(full ? u : pathOf(u));
  return /^https?:\/\//i.test(u)
    ? `<a class="url ${cls}" href="${esc(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${text}</a>`
    : `<span class="url ${cls}" title="${esc(u)}">${text}</span>`;
}
const kwLink = r => `<a href="#/keyword/${Number(r.id)}">${esc(r.phrase)}</a>${r.device === 'mobile' ? ' <span class="tag">mobile</span>' : ''}${r.location ? ` <span class="tag">${esc(r.location)}</span>` : ''}`;
const errorBox = (what, e) => h(`<div class="card down">Could not load ${esc(what)}: ${esc(e.message)}</div>`);

async function showDetail(domainId, url) {
  const body = h(`<div class="lp-detail pg-landing-pages">${urlCell(url, { full: true })}<div class="empty">Loading…</div></div>`);
  modal('Landing page keywords', body);
  try {
    const data = await get(`/api/landing-pages/detail?${new URLSearchParams({ domainId, url })}`);
    body.querySelector('.empty').replaceWith(table([
      { key: 'phrase', label: 'Keyword', render: kwLink },
      { key: 'rank', label: 'Rank', num: true, render: r => esc(fmtRank(r.rank)) },
      { key: 'change', label: 'Change', num: true, render: r => fmtChange(r.change) },
      { key: 'volume', label: 'Volume', num: true, render: r => esc(fmtNum(r.volume)) },
      { key: 'estimatedClicks', label: 'Est. clicks', num: true, render: r => esc(fmtNum(r.estimatedClicks)) },
      { key: 'preferredMatch', label: 'Preferred URL', render: r => r.preferredMatch == null ? '<span class="muted">–</span>' : r.preferredMatch ? '<span class="up">Match</span>' : `<span class="down" title="${esc(r.preferredUrl)}">Other</span>` },
    ], data.keywords, { empty: 'No keywords currently rank with this URL' }));
  } catch (e) { body.querySelector('.empty').replaceWith(errorBox('keywords', e)); }
}

async function renderPages(body, ctx) {
  const data = await get(`/api/landing-pages?domainId=${ctx.domainId}`);
  const t = data.totals;
  const kpis = h('<div class="grid grid-4 kpis"></div>');
  kpis.append(kpi('Landing pages', esc(fmtNum(t.pages))), kpi('Ranking keywords', esc(fmtNum(t.rankedKeywords)), `${esc(fmtNum(t.unrankedKeywords))} not ranking`),
    kpi('Est. monthly clicks', esc(fmtNum(t.estimatedClicks))), kpi('Share of voice', esc(pct(t.sov))));
  const toolbar = h('<div class="row toolbar"><input type="search" placeholder="Filter URLs…" aria-label="Filter URLs"><span class="muted hint">Click a row to see its keywords.</span></div>');
  const maxShare = Math.max(1, ...data.pages.map(p => p.share));
  const columns = [
    { key: 'url', label: 'URL', render: r => urlCell(r.url) },
    { key: 'keywords', label: 'Keywords', num: true },
    { key: 'avgRank', label: 'Avg. rank', num: true },
    { key: 'bestRank', label: 'Best rank', num: true },
    { key: 'totalVolume', label: 'Volume', num: true, render: r => esc(fmtNum(r.totalVolume)) },
    { key: 'estimatedClicks', label: 'Est. clicks', num: true, render: r => esc(fmtNum(r.estimatedClicks)) },
    { key: 'sov', label: 'SoV', num: true, render: r => esc(pct(r.sov)) },
    { key: 'share', label: 'Click share', num: true, render: r => `<span class="bar"><i style="width:${(r.share / maxShare * 100).toFixed(1)}%"></i></span>${esc(pct(r.share))}` },
  ];
  const holder = h('<div></div>');
  const draw = q => holder.replaceChildren(table(columns, q ? data.pages.filter(p => p.url.toLowerCase().includes(q)) : data.pages,
    { empty: q ? 'No URLs match the filter' : 'No ranking URLs yet', onRowClick: r => showDetail(ctx.domainId, r.url) }));
  toolbar.querySelector('input').addEventListener('input', e => draw(e.target.value.trim().toLowerCase()));
  draw('');
  body.replaceChildren(kpis, toolbar, holder);
}

async function renderCannibalization(body, ctx, days, setDays) {
  const data = await get(`/api/landing-pages/cannibalization?domainId=${ctx.domainId}&days=${days}`);
  const toolbar = h(`<div class="row toolbar"><label>Window<select aria-label="Window">${WINDOWS.map(d => `<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></label></div>`);
  toolbar.querySelector('select').addEventListener('change', e => setDays(Number(e.target.value)));
  const hint = h(`<div class="muted hint">Keywords whose ranking URL alternated between two or more of your pages since ${esc(fmtDate(data.since))}. Consolidating content or internal links can stabilise them.</div>`);
  const urls = r => `<div class="urls">${r.urls.map(u => `<div>${urlCell(u.url, { cls: u.url === r.currentUrl ? 'cur' : '' })} <span class="muted">best ${esc(fmtRank(u.bestRank))} · ${esc(fmtNum(u.snapshots))}×</span></div>`).join('')}</div>`;
  body.replaceChildren(toolbar, hint, table([
    { key: 'phrase', label: 'Keyword', render: kwLink },
    { key: 'currentRank', label: 'Rank', num: true },
    { key: 'volume', label: 'Volume', num: true, render: r => esc(fmtNum(r.volume)) },
    { key: 'switches', label: 'URL switches', num: true },
    { key: 'currentUrl', label: 'Competing URLs (current in bold)', render: urls },
  ], data.keywords, { empty: 'No cannibalization detected in this window' }));
}

async function renderMismatches(body, ctx) {
  const data = await get(`/api/landing-pages/mismatches?domainId=${ctx.domainId}`);
  const hint = h(`<div class="muted hint">${esc(fmtNum(data.keywordsWithPreferredUrl))} keywords have a preferred URL. These currently rank with a different page.</div>`);
  body.replaceChildren(hint, table([
    { key: 'phrase', label: 'Keyword', render: kwLink },
    { key: 'rank', label: 'Rank', num: true },
    { key: 'volume', label: 'Volume', num: true, render: r => esc(fmtNum(r.volume)) },
    { key: 'rankingUrl', label: 'Ranking URL', render: r => urlCell(r.rankingUrl) },
    { key: 'preferredUrl', label: 'Preferred URL', render: r => urlCell(r.preferredUrl) },
    { key: 'preferredPosition', label: 'Preferred pos.', num: true, render: r => r.preferredPosition == null ? '<span class="muted">Not in top 100</span>' : esc(r.preferredPosition) },
  ], data.keywords, { empty: data.keywordsWithPreferredUrl ? 'All keywords rank with their preferred URL' : 'No keywords have a preferred URL set' }));
}

export default {
  id: 'landing-pages', title: 'Landing Pages', group: 'Insights', order: 55, nav: true, needsDomain: true,
  async render(el, ctx) {
    let tab = TABS.some(x => x.id === ctx.query.get('tab')) ? ctx.query.get('tab') : 'pages';
    let days = WINDOWS.includes(Number(ctx.query.get('days'))) ? Number(ctx.query.get('days')) : 30;
    const root = h(`<div class="pg-landing-pages"><style>${STYLE}</style>
      <div class="row head"><h1>Landing pages</h1></div>
      <div class="tabs" role="tablist">${TABS.map(x => `<button role="tab" data-tab="${x.id}">${esc(x.label)}</button>`).join('')}</div>
      <div class="body" role="tabpanel"></div></div>`);
    el.append(root);
    const body = root.querySelector('.body');
    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      root.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      const qs = new URLSearchParams({ tab }); if (tab === 'cannibalization' && days !== 30) qs.set('days', days);
      history.replaceState(null, '', `#/landing-pages?${qs}`);
      body.replaceChildren(h('<div class="empty">Loading…</div>'));
      const target = h('<div></div>');
      try {
        if (tab === 'pages') await renderPages(target, ctx);
        else if (tab === 'cannibalization') await renderCannibalization(target, ctx, days, d => { days = d; load(); });
        else await renderMismatches(target, ctx);
      } catch (e) { target.replaceChildren(errorBox(TABS.find(x => x.id === tab).label.toLowerCase(), e)); }
      if (mine === seq) body.replaceChildren(...target.childNodes);
    };
    root.querySelector('.tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]'); if (!b || b.dataset.tab === tab) return;
      tab = b.dataset.tab; load();
    });
    await load();
  },
};
