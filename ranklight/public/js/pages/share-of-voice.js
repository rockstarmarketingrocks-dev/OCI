// Share of voice: your estimated click share vs competitors over time, current ranking and per-tag breakdown.
import { get } from '../api.js';
import { h, esc, table, lineChart } from '../ui.js';

const PERIODS = [7, 30, 90, 365];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const STYLE = `
.pg-share-of-voice .head { margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.pg-share-of-voice .head h1 { margin: 0; }
.pg-share-of-voice .periods { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.pg-share-of-voice .periods button { border: 0; border-radius: 0; border-left: 1px solid var(--border); }
.pg-share-of-voice .periods button:first-child { border-left: 0; }
.pg-share-of-voice .periods button.on { background: var(--primary); color: var(--primary-ink); }
.pg-share-of-voice .grid { margin-bottom: 16px; }
.pg-share-of-voice .bars { display: grid; gap: 10px; }
.pg-share-of-voice .bar-row { display: grid; grid-template-columns: minmax(80px, 180px) 1fr 64px; gap: 8px; align-items: center; font-size: 13px; }
.pg-share-of-voice .bar-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-share-of-voice .bar-row.you .name { font-weight: 600; }
.pg-share-of-voice .track { background: var(--surface-2); border-radius: 4px; height: 12px; overflow: hidden; }
.pg-share-of-voice .fill { height: 100%; border-radius: 4px; min-width: 2px; }
.pg-share-of-voice .num { text-align: right; font-variant-numeric: tabular-nums; }
.pg-share-of-voice .hint { font-size: 12px; margin-top: 8px; }
`;

const fmtPct = v => `${Number(v || 0).toFixed(1)}%`;

function bars(rows) {
  if (!rows.length) return h('<div class="empty">No share of voice data yet</div>');
  const max = Math.max(1, ...rows.map(r => r.sov));
  return h(`<div class="bars">${rows.map(r => `<div class="bar-row ${r.you ? 'you' : ''}">
    <span class="name" title="${esc(r.name)}">${esc(r.name)}</span>
    <div class="track" role="img" aria-label="${esc(r.name)} ${esc(fmtPct(r.sov))}"><div class="fill" style="width:${(r.sov / max * 100).toFixed(1)}%;background:${r.color}"></div></div>
    <span class="num">${esc(fmtPct(r.sov))}</span></div>`).join('')}</div>`);
}

export default {
  id: 'share-of-voice', title: 'Share of Voice', group: 'Insights', order: 40, nav: true, needsDomain: true,
  async render(el, ctx) {
    let days = Number(ctx.query.get('days'));
    if (!PERIODS.includes(days)) days = 30;
    let tag = ctx.query.get('tag') || '';
    const root = h(`<div class="pg-share-of-voice"><style>${STYLE}</style>
      <div class="row head"><h1>Share of voice</h1><span class="spacer"></span>
        <select class="tag-filter" aria-label="Filter by tag"><option value="">All keywords</option></select>
        <div class="periods" role="group" aria-label="Period">${PERIODS.map(p => `<button data-days="${p}">${p === 365 ? '1y' : p + 'd'}</button>`).join('')}</div></div>
      <div class="body"><div class="empty">Loading…</div></div></div>`);
    el.append(root);
    const body = root.querySelector('.body'), select = root.querySelector('.tag-filter');
    const card = (title, ...children) => { const c = h(`<div class="card"><h2>${esc(title)}</h2></div>`); c.append(...children); return c; };

    const load = async () => {
      root.querySelectorAll('[data-days]').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === days));
      const qs = new URLSearchParams({ domainId: ctx.domainId, days });
      if (tag) qs.set('tag', tag);
      let data;
      try { data = await get(`/api/share-of-voice?${qs}`); }
      catch (e) { body.replaceChildren(h(`<div class="card down">Could not load share of voice: ${esc(e.message)}</div>`)); return; }

      select.innerHTML = '<option value="">All keywords</option>' + data.byTag.map(t => t.tag).map(n => `<option value="${esc(n)}" ${n === tag ? 'selected' : ''}>${esc(n)}</option>`).join('');

      const hosts = data.current.competitors.map(c => c.host);
      const colorOf = new Map([['you', COLORS[0]], ...hosts.map((host, i) => [host, COLORS[(i + 1) % COLORS.length]])]);
      const youName = ctx.domain?.display_name || ctx.domain?.host || 'You';
      const nameOf = new Map(data.current.competitors.map(c => [c.host, c.displayName || c.host]));
      const series = [{ name: youName, color: colorOf.get('you'), points: data.history.map(p => ({ x: p.date, y: p.you })) },
        ...hosts.map(host => ({ name: nameOf.get(host), color: colorOf.get(host), points: data.history.map(p => ({ x: p.date, y: p[host] ?? null })) }))];

      const ranking = [{ name: youName, sov: data.current.you, you: true, color: colorOf.get('you') },
        ...data.current.competitors.map(c => ({ name: nameOf.get(c.host), sov: c.sov, color: colorOf.get(c.host) }))].sort((a, b) => b.sov - a.sov);
      const rankCard = card('Current ranking', bars(ranking));
      if (data.discovered && hosts.length) rankCard.append(h('<div class="muted hint">No competitors configured; showing the top hosts found in your tracked SERPs.</div>'));

      const tagTable = table([
        { key: 'tag', label: 'Tag' },
        { key: 'keywords', label: 'Keywords', num: true },
        { key: 'sov', label: 'Your share of voice', num: true, render: r => esc(fmtPct(r.sov)) },
      ], data.byTag, { empty: 'No tags on this domain', onRowClick: r => { tag = r.tag; load(); } });

      const top = h('<div class="grid grid-2"></div>');
      top.append(card('Share of voice over time', lineChart(series, { yLabel: 'Share of voice %' })), rankCard);
      body.replaceChildren(top, card('By tag', tagTable));
    };

    root.querySelector('.periods').addEventListener('click', e => {
      const b = e.target.closest('[data-days]'); if (!b) return;
      days = Number(b.dataset.days); load();
    });
    select.addEventListener('change', () => { tag = select.value; load(); });
    await load();
  },
};
