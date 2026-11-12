// Competitors: manage the competitor list, add suggested hosts in one click, and compare rankings head to head.
// Data: GET/POST/DELETE /api/competitors, /api/competitors/compare, /api/competitors/suggest (all ?domainId=).
import { get, post, del } from '../api.js';
import { h, esc, toast, table, fmtRank, fmtNum } from '../ui.js';

const STYLE = `
.pg-competitors .grid-2 { margin-bottom: 16px; }
.pg-competitors .add { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.pg-competitors .add input { flex: 1 1 140px; min-width: 0; }
.pg-competitors ul.items { list-style: none; margin: 0; padding: 0; }
.pg-competitors ul.items li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border); }
.pg-competitors ul.items li:first-child { border-top: 0; }
.pg-competitors ul.items .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-competitors .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.pg-competitors .h2h { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-bottom: 16px; }
.pg-competitors .h2h .host { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-competitors .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--surface-2); margin: 8px 0; }
.pg-competitors .bar .w { background: var(--up); } .pg-competitors .bar .t { background: var(--muted); } .pg-competitors .bar .l { background: var(--down); }
.pg-competitors .stats { display: flex; justify-content: space-between; font-size: 12px; gap: 8px; }
.pg-competitors .cell { display: inline-block; min-width: 2.5em; padding: 1px 6px; border-radius: 4px; text-align: center; }
.pg-competitors .cell.win { background: color-mix(in srgb, var(--up) 18%, transparent); color: var(--up); }
.pg-competitors .cell.loss { background: color-mix(in srgb, var(--down) 18%, transparent); color: var(--down); }
.pg-competitors .cell.tie { background: var(--surface-2); }
.pg-competitors .legend { font-size: 12px; margin-bottom: 8px; gap: 12px; }
.pg-competitors .kw { max-width: 280px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
@media (max-width: 800px) { .pg-competitors .grid-2 { grid-template-columns: minmax(0, 1fr); } }
`;
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const color = i => COLORS[i % COLORS.length];

// Head-to-head outcome from the tracked domain's point of view (unranked = 101).
function outcome(you, them) {
  if (you == null && them == null) return '';
  const a = you ?? 101, b = them ?? 101;
  return a < b ? 'win' : a > b ? 'loss' : 'tie';
}

export default {
  id: 'competitors', title: 'Competitors', group: 'Insights', order: 45, nav: true, needsDomain: true,
  async render(el, ctx) {
    const q = `domainId=${encodeURIComponent(ctx.domainId)}`;
    const root = h(`<div class="pg-competitors"><style>${STYLE}</style>
      <div class="row"><h1>Competitors</h1></div>
      <div class="grid grid-2">
        <div class="card"><h2>Your competitors</h2>
          <form class="add"><input name="host" placeholder="competitor.com" aria-label="Competitor host" required>
            <input name="displayName" placeholder="Label (optional)" aria-label="Label" maxlength="100">
            <button class="primary">Add</button></form>
          <div data-list></div></div>
        <div class="card"><h2>Suggestions</h2><p class="muted" style="margin-top:0">Hosts appearing most often in the top 10 of your tracked keywords.</p><div data-suggest></div></div>
      </div>
      <div data-h2h></div>
      <div class="card"><h2>Ranking comparison</h2><div data-compare></div></div>
    </div>`);
    el.append(root);
    const $ = s => root.querySelector(s);

    const add = async (host, displayName = '') => {
      try { await post(`/api/competitors?${q}`, { host, displayName }); toast(`Added ${host}`); await load(); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    };
    const remove = async (id, host) => {
      if (!confirm(`Remove ${host} from competitors?`)) return;
      try { await del(`/api/competitors/${encodeURIComponent(id)}?${q}`); toast(`Removed ${host}`); await load(); }
      catch (e) { toast(e.message, 'error'); }
    };

    $('form.add').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (await add(String(f.get('host')).trim(), String(f.get('displayName')).trim())) e.target.reset();
    });
    root.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'add') { b.disabled = true; add(b.dataset.host).finally(() => { b.disabled = false; }); }
      if (b.dataset.act === 'del') remove(b.dataset.id, b.dataset.host);
    });

    function drawList(list) {
      $('[data-list]').innerHTML = list.length
        ? `<ul class="items">${list.map((c, i) => `<li><span class="swatch" style="background:${color(i)}"></span>
            <span class="name" title="${esc(c.host)}">${esc(c.display_name || c.host)}${c.display_name ? ` <span class="muted">${esc(c.host)}</span>` : ''}</span>
            <button class="danger" data-act="del" data-id="${esc(c.id)}" data-host="${esc(c.host)}" aria-label="Remove ${esc(c.host)}">Remove</button></li>`).join('')}</ul>`
        : '<div class="empty">No competitors yet. Add one or pick a suggestion.</div>';
    }
    function drawSuggestions(list) {
      $('[data-suggest]').innerHTML = list.length
        ? `<ul class="items">${list.map(s => `<li><span class="name" title="${esc(s.host)}">${esc(s.host)}</span>
            <span class="muted">${fmtNum(s.keywords)} kw · avg #${esc(s.avgPosition)}</span>
            <button data-act="add" data-host="${esc(s.host)}">+ Add</button></li>`).join('')}</ul>`
        : '<div class="empty">No suggestions yet. They appear once rankings have been checked.</div>';
    }
    function drawHeadToHead(cmp) {
      const box = $('[data-h2h]');
      if (!cmp.summary.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="grid h2h">${cmp.summary.map((s, i) => {
        const total = s.wins + s.ties + s.losses || 1, pct = n => (n / total * 100).toFixed(1);
        return `<div class="card"><div class="row"><span class="swatch" style="background:${color(i)}"></span><span class="host" title="${esc(s.host)}">${esc(s.displayName || s.host)}</span></div>
          <div class="bar" role="img" aria-label="${s.wins} wins, ${s.ties} ties, ${s.losses} losses"><span class="w" style="width:${pct(s.wins)}%"></span><span class="t" style="width:${pct(s.ties)}%"></span><span class="l" style="width:${pct(s.losses)}%"></span></div>
          <div class="stats"><span class="up">${s.wins} won</span><span class="muted">${s.ties} tied</span><span class="down">${s.losses} lost</span></div>
          <div class="stats" style="margin-top:6px"><span>Their avg: <b>${s.avgRank ?? '–'}</b></span><span>Yours: <b>${cmp.you.avgRank ?? '–'}</b></span><span>Top 10: ${s.top10}</span></div></div>`;
      }).join('')}</div>`;
    }
    function drawCompare(cmp) {
      const box = $('[data-compare]');
      box.innerHTML = '';
      if (!cmp.competitors.length) { box.append(h('<div class="empty">Add competitors to compare rankings keyword by keyword.</div>')); return; }
      const rows = cmp.keywords.map(k => ({ ...k, ...Object.fromEntries(cmp.competitors.map((c, i) => [`c${i}`, k.ranks[c.host]])) }));
      const cols = [
        { key: 'phrase', label: 'Keyword', render: r => `<span class="kw" title="${esc(r.phrase)}">${esc(r.phrase)}</span> <span class="muted">${esc(r.device)} · ${esc(r.country)}${r.location ? ' · ' + esc(r.location) : ''}</span>` },
        { key: 'searchVolume', label: 'Volume', num: true, render: r => fmtNum(r.searchVolume) },
        { key: 'you', label: cmp.host, num: true, render: r => r.checkedAt ? `<b>${fmtRank(r.you)}</b>` : '<span class="muted">not checked</span>' },
        ...cmp.competitors.map((c, i) => ({ key: `c${i}`, label: c.display_name || c.host, num: true,
          render: r => r.checkedAt ? `<span class="cell ${outcome(r.you, r[`c${i}`])}" title="${esc(c.host)}">${fmtRank(r[`c${i}`])}</span>` : '' })),
      ];
      box.append(h('<div class="row legend"><span><span class="cell win">#</span> you rank higher</span><span><span class="cell loss">#</span> they rank higher</span><span><span class="cell tie">#</span> tie</span></div>'));
      box.append(table(cols, rows, { empty: 'No keywords tracked for this domain yet' }));
    }

    async function load() {
      try {
        const [list, suggestions, cmp] = await Promise.all([get(`/api/competitors?${q}`), get(`/api/competitors/suggest?${q}`), get(`/api/competitors/compare?${q}`)]);
        drawList(list); drawSuggestions(suggestions); drawHeadToHead(cmp); drawCompare(cmp);
      } catch (e) { toast(e.message, 'error'); }
    }
    await load();
  },
};
