// Keyword research: idea generation from a seed phrase, competitor gaps, and adding picks to tracking.
import { get, post } from '../api.js';
import { h, esc, table, toast, fmtNum } from '../ui.js';

const STYLE = `
.pg-keyword-research .search { gap: 8px; margin-bottom: 16px; }
.pg-keyword-research .search input[name=seed] { flex: 1 1 260px; min-width: 0; max-width: 480px; }
.pg-keyword-research .search select { flex: 0 0 auto; }
.pg-keyword-research .tabs { gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
.pg-keyword-research .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 8px 12px; color: var(--muted); }
.pg-keyword-research .tabs button.on { color: var(--text); border-bottom-color: var(--primary); font-weight: 600; }
.pg-keyword-research .actions { gap: 8px; margin-bottom: 10px; }
.pg-keyword-research .notice { margin-bottom: 12px; }
.pg-keyword-research .kd { display: inline-flex; align-items: center; gap: 6px; }
.pg-keyword-research .kd i { display: inline-block; width: 40px; height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.pg-keyword-research .kd i b { display: block; height: 100%; }
.pg-keyword-research .intent { font-size: 11px; text-transform: capitalize; }
.pg-keyword-research .intent.informational { border-left: 3px solid var(--c1); }
.pg-keyword-research .intent.commercial { border-left: 3px solid var(--c4); }
.pg-keyword-research .intent.transactional { border-left: 3px solid var(--c2); }
.pg-keyword-research .intent.navigational { border-left: 3px solid var(--c3); }
.pg-keyword-research td input[type=checkbox], .pg-keyword-research th input[type=checkbox] { margin: 0; }
@media (max-width: 700px) { .pg-keyword-research .search button { flex: 1 1 auto; } }
`;
const COUNTRIES = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'DK', 'NO', 'IN', 'BR', 'MX', 'JP'];
const money = n => (n == null ? '–' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }));

function kdCell(d) {
  if (d == null) return '<span class="muted">–</span>';
  const color = d >= 70 ? 'var(--down)' : d >= 40 ? 'var(--warn)' : 'var(--up)';
  return `<span class="kd"><i><b style="width:${Number(d)}%;background:${color}"></b></i>${esc(d)}</span>`;
}
const intentCell = i => `<span class="tag intent ${esc(i)}">${esc(i)}</span>`;

// Table with a checkbox column; `selected` is a Set of phrases shared with the caller.
// Rows matching `locked` render a disabled checkbox and are skipped by select-all.
function selectableTable(columns, rows, selected, onChange, empty, locked = () => false) {
  const pickable = rows.filter(r => !locked(r));
  const allOn = () => pickable.length > 0 && pickable.every(r => selected.has(r.phrase));
  const cols = [{ key: '_sel', label: '', render: r => `<input type="checkbox" data-p="${esc(r.phrase)}" ${selected.has(r.phrase) ? 'checked' : ''} ${locked(r) ? 'disabled' : ''} aria-label="Select ${esc(r.phrase)}">` }, ...columns];
  const el = table(cols, rows, { empty });
  const syncHead = () => {
    const th = el.querySelector('th[data-k="_sel"]');
    if (th && !th.querySelector('input')) th.innerHTML = '<input type="checkbox" data-all aria-label="Select all">';
    const all = el.querySelector('[data-all]');
    if (all) all.checked = allOn();
  };
  el.addEventListener('click', e => { if (e.target.closest('th[data-k="_sel"]')) e.stopPropagation(); }, true);
  el.addEventListener('change', e => {
    const cb = e.target;
    if (cb.matches('[data-all]')) {
      for (const r of pickable) cb.checked ? selected.add(r.phrase) : selected.delete(r.phrase);
      el.querySelectorAll('td input[data-p]:not(:disabled)').forEach(x => { x.checked = cb.checked; });
    } else if (cb.matches('[data-p]')) cb.checked ? selected.add(cb.dataset.p) : selected.delete(cb.dataset.p);
    syncHead(); onChange();
  });
  new MutationObserver(syncHead).observe(el.querySelector('thead'), { childList: true });
  syncHead();
  return el;
}

export default {
  id: 'keyword-research', title: 'Keyword Research', group: 'Discovery', order: 75, nav: true, needsDomain: true,
  async render(el, ctx) {
    const seed0 = ctx.query.get('seed') || '';
    const country0 = (ctx.query.get('country') || ctx.domain?.default_country || 'US').toUpperCase();
    const countries = COUNTRIES.includes(country0) ? COUNTRIES : [country0, ...COUNTRIES];
    const root = h(`<div class="pg-keyword-research"><style>${STYLE}</style>
      <h1>Keyword research</h1>
      <form class="row search card">
        <input name="seed" type="search" placeholder="Enter a seed keyword, e.g. running shoes" maxlength="80" required value="${esc(seed0)}" aria-label="Seed keyword">
        <select name="country" aria-label="Country">${countries.map(c => `<option ${c === country0 ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <button class="primary">Find ideas</button>
      </form>
      <div class="row tabs" role="tablist"><button type="button" data-tab="ideas" class="on">Ideas</button><button type="button" data-tab="gap">Competitor gap</button></div>
      <div class="row actions"><span class="muted" data-count></span><span class="spacer"></span><button type="button" class="primary" data-track disabled>Track selected</button></div>
      <div class="body"><div class="empty">Enter a seed keyword to discover related ideas.</div></div></div>`);
    el.append(root);
    const body = root.querySelector('.body'), trackBtn = root.querySelector('[data-track]'), count = root.querySelector('[data-count]');
    const form = root.querySelector('form');
    const selected = new Set();
    let tab = 'ideas', ideasView = null, country = country0, hasKeywordsModule = null;

    const updateCount = () => {
      count.textContent = selected.size ? `${selected.size} selected` : '';
      trackBtn.disabled = !selected.size;
    };
    const show = nodes => { body.replaceChildren(...nodes); };

    async function loadIdeas() {
      const seed = form.seed.value.trim();
      country = form.country.value;
      if (seed.length < 2) { toast('Enter at least 2 characters', 'error'); return; }
      show([h('<div class="empty">Finding ideas…</div>')]);
      try {
        const data = await get(`/api/keyword-research/ideas?seed=${encodeURIComponent(seed)}&country=${encodeURIComponent(country)}`);
        selected.clear(); updateCount();
        const nodes = [];
        if (!data.providerAvailable) nodes.push(h('<div class="card notice muted">No data provider is configured: volumes and CPC are unavailable and difficulty is estimated.</div>'));
        for (const w of data.warnings || []) nodes.push(h(`<div class="card notice down">${esc(w)}</div>`));
        nodes.push(selectableTable([
          { key: 'phrase', label: 'Keyword', render: r => `${esc(r.phrase)}${r.source === 'seed' ? ' <span class="tag">seed</span>' : ''}` },
          { key: 'intent', label: 'Intent', render: r => intentCell(r.intent) },
          { key: 'volume', label: 'Volume', num: true, render: r => esc(fmtNum(r.volume)) },
          { key: 'cpc', label: 'CPC', num: true, render: r => esc(money(r.cpc)) },
          { key: 'difficulty', label: 'Difficulty', num: true, render: r => kdCell(r.difficulty) },
        ], data.ideas, selected, updateCount, 'No ideas found'));
        ideasView = nodes;
        if (tab === 'ideas') show(nodes);
      } catch (e) { show([h(`<div class="card down">${esc(e.message)}</div>`)]); }
    }

    async function loadGap() {
      show([h('<div class="empty">Loading competitor gap…</div>')]);
      try {
        const data = await get(`/api/keyword-research/gap?domainId=${ctx.domainId}`);
        const comps = data.competitors.length
          ? `${data.competitorsSource === 'detected' ? 'Detected competitors' : 'Competitors'}: ${data.competitors.map(c => `<span class="tag">${esc(c)}</span>`).join(' ')}`
          : 'No competitors configured or detected yet. Add competitors to find keyword gaps.';
        const rows = data.gaps.map(g => ({ ...g, comps: g.competitors.map(c => `${c.host} #${c.rank}`).join(', ') }));
        show([
          h(`<div class="card notice muted">Keywords where competitors rank in the top ${esc(data.maxRank)} and ${esc(ctx.domain?.host || 'your domain')} does not. ${comps}</div>`),
          selectableTable([
            { key: 'phrase', label: 'Keyword', render: r => `${esc(r.phrase)}${r.tracked ? ' <span class="tag">tracked</span>' : ''}` },
            { key: 'intent', label: 'Intent', render: r => intentCell(r.intent) },
            { key: 'yourRank', label: 'Your rank', num: true, render: r => (r.yourRank == null ? '<span class="muted">–</span>' : esc(r.yourRank)) },
            { key: 'bestCompetitorRank', label: 'Best competitor', num: true },
            { key: 'comps', label: 'Competitors ranking' },
            { key: 'volume', label: 'Volume', num: true, render: r => esc(fmtNum(r.volume)) },
          ], rows, selected, updateCount, 'No gaps found in stored rankings', r => r.tracked),
        ]);
      } catch (e) { show([h(`<div class="card down">${esc(e.message)}</div>`)]); }
    }

    async function track() {
      const phrases = [...selected];
      if (!phrases.length) return;
      trackBtn.disabled = true;
      try {
        if (hasKeywordsModule == null) hasKeywordsModule = (await get('/api/_meta/modules').catch(() => [])).includes('keywords');
        const url = hasKeywordsModule ? '/api/keywords' : '/api/keyword-research/track';
        const r = await post(url, { domainId: ctx.domainId, phrases, country: tab === 'ideas' ? country : undefined });
        toast(`Added ${r.created} keyword${r.created === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already tracked` : ''}`);
        selected.clear(); updateCount();
        body.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
        if (tab === 'gap') loadGap();
      } catch (e) { toast(e.message, 'error'); updateCount(); }
    }

    form.addEventListener('submit', e => { e.preventDefault(); if (tab !== 'ideas') setTab('ideas'); loadIdeas(); });
    trackBtn.addEventListener('click', track);
    function setTab(next) {
      tab = next;
      root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      selected.clear(); updateCount();
      form.querySelectorAll('input,select,button').forEach(x => { x.disabled = tab !== 'ideas'; });
      if (tab === 'gap') loadGap();
      else if (ideasView) { ideasView.forEach(n => n.querySelectorAll?.('input[type=checkbox]').forEach(cb => { cb.checked = false; })); show(ideasView); }
      else show([h('<div class="empty">Enter a seed keyword to discover related ideas.</div>')]);
    }
    root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    if (seed0) loadIdeas();
  },
};
